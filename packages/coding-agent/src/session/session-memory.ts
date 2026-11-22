/** Session memory backend lifecycle and transcript resets. */

import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import {
	type AnySetting,
	all as allSettings,
	combine,
	type Derived,
	type SettingChange,
	settingValuesEqual,
} from "../config/registry";
import type { Settings } from "../config/settings";
import { computeBankScope, hindsightRecallScope } from "../hindsight/bank";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import type { HindsightConversationTracking, HindsightSessionState } from "../hindsight/state";
import {
	type ConversationRecall,
	type RecallChangesReport,
	recallsIntoConversation,
} from "../memory-backend/recall-entry";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import type { MemoryBackendId, MemoryBackendStartOptions } from "../memory-backend/types";
import { loadMnemopiConfig } from "../mnemopi/config";
import { getMnemopiRecallScope, type MnemopiConversationTracking, type MnemopiSessionState } from "../mnemopi/state";
import { releaseSharpshooterSession } from "../sharpshooter/backend";
import type { SettingsChangeOptions } from "./session-tools";

import { cfgMemoryBackend } from "../memory-backend/settings";

/** Id prefixes of the memory backends' own settings; their live edits reconfigure the active backend. */
const MEMORY_BACKEND_SETTING_PREFIXES: readonly string[] = ["hindsight.", "mnemopi.", "sharpshooter."];

let memorySettings: Derived<Record<string, unknown>> | undefined;

/** `memory.backend` plus every backend's own settings, keyed by setting id (built once registration is complete). */
function memorySettingsValue(): Derived<Record<string, unknown>> {
	memorySettings ??= combine(
		Object.fromEntries(
			allSettings()
				.filter(
					handle =>
						handle.id === cfgMemoryBackend.id ||
						MEMORY_BACKEND_SETTING_PREFIXES.some(prefix => handle.id.startsWith(prefix)),
				)
				.map(handle => [handle.id, handle]),
		),
	);
	return memorySettings;
}

/**
 * The scope the first-turn recall of the backend `settings` select reads, as its records name it (`findPersistedRecall`):
 * Hindsight's server, account, bank and tag filter for `cwd`, or Mnemopi's banks and databases under `agentDir`.
 * Undefined under a backend that recalls nothing into the conversation, and under Hindsight with no server. Mnemopi's
 * needs its core module loaded (`loadMnemopiCore`).
 */
export function memoryRecallScope(settings: Settings, cwd: string, agentDir: string): string | undefined {
	switch (cfgMemoryBackend.get(settings)) {
		case "hindsight": {
			const config = loadHindsightConfig(settings);
			return isHindsightConfigured(config) ? hindsightRecallScope(config, computeBankScope(config, cwd)) : undefined;
		}
		case "mnemopi":
			return getMnemopiRecallScope(loadMnemopiConfig(settings, agentDir));
		default:
			return undefined;
	}
}

/**
 * What a transcript leaves in the session's memory state ({@link SessionMemory.conversationTracking}): the base prompt
 * captured before a per-turn memory promotion, the recall the conversation carries, and each memory backend's tracking
 * of the transcript.
 */
export interface ConversationTracking {
	readonly promotionSnapshot: string[] | undefined;
	readonly recall: ConversationRecall | undefined;
	readonly recallChanges: readonly RecallChangesReport[];
	readonly hindsight: HindsightConversationTracking | undefined;
	readonly mnemopi: MnemopiConversationTracking | undefined;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionMemoryHost {
	agent: Agent;
	settings: Settings;
	modelRegistry: ModelRegistry;
	isDisposed(): boolean;
	/** Session working directory; memory bank scopes derive from it. */
	cwd(): string;
	/** Registers teardown to run when the session is disposed (settings listeners bound to this host). */
	addDisposer(dispose: () => void): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	getHindsightSessionState(): HindsightSessionState | undefined;
	setHindsightSessionState(state: HindsightSessionState | undefined): void;
	getMnemopiSessionState(): MnemopiSessionState | undefined;
	takeMnemopiSessionState(): MnemopiSessionState | undefined;
	setBaseSystemPrompt(prompt: string[]): void;
	/**
	 * Rebuilds the base prompt; with `settingsChange` (the memory settings a backend apply took in) a bound prompt
	 * holds the rebuild (`SessionTools.refreshBaseSystemPrompt`).
	 */
	refreshBaseSystemPrompt(options?: SettingsChangeOptions): Promise<void>;
	/** Swaps the memory tools; with `settingsChange` a bound prompt holds the swap (`SessionTools.replaceMemoryTools`). */
	replaceMemoryTools(tools: AgentTool[], options?: SettingsChangeOptions): Promise<void>;
}

/** Owns memory backend transitions and transcript-scoped memory state. */
export class SessionMemory {
	readonly #host: SessionMemoryHost;
	readonly #memoryAgentDir: string | undefined;
	readonly #memoryTaskDepth: number;
	readonly #createMemoryTools: (() => Promise<AgentTool[]>) | undefined;
	#memoryBackendTransition: Promise<void> = Promise.resolve();
	#localMemoryStartupAbort: AbortController | undefined;
	#baseSystemPromptBeforeMemoryPromotion: string[] | undefined;
	/**
	 * The recall the memory backend adopted that the conversation carries itself, as a hidden `memory-recall` message
	 * (`MEMORY_RECALL_MESSAGE_TYPE`), which each request sends where its context lacks it, or as the system prompt's own
	 * last block, which each prompt build appends.
	 */
	#recall: ConversationRecall | undefined;
	/**
	 * The reports of what changed in a reused recall's memories that the conversation carries as hidden
	 * `memory-recall-changes` messages, oldest first; each request sends one again where its context lacks it.
	 */
	#recallChanges: readonly RecallChangesReport[] = [];
	/** Cwd the running backend state was built for; a transcript is never retained after it moved. */
	#runtimeCwd: string | undefined;
	/** Apply waiting behind the current transition; later requests join it. */
	#queuedApply: { retainMnemopi: boolean; done: Promise<void> } | undefined;
	/** Memory settings as last dispatched to `#applySettingsChange`; unset when live changes are disabled. */
	#observedSettings: Record<string, unknown> | undefined;
	/**
	 * Each memory setting's value as a backend apply last took it in ({@link #applyMemoryBackend}): the value the
	 * running backend, its tools and the prompt follow. Unset when live changes are disabled.
	 */
	#appliedSettings: Map<AnySetting, unknown> | undefined;
	/**
	 * The backend the running memory state follows: the one selected when the session started, then the one each
	 * backend apply resolved ({@link #applyMemoryBackend}). A switch still waiting for its apply does not move it.
	 */
	#runningBackend: MemoryBackendId;
	/** Dispatched setting changes still running, including backend hooks that run outside the transition queue. */
	readonly #settingsChanges = new Set<Promise<void>>();

	constructor(
		host: SessionMemoryHost,
		options: {
			/** Session-start memory policy; false disables live backend changes. */
			memoryEnabled?: boolean;
			memoryAgentDir?: string;
			memoryTaskDepth?: number;
			createMemoryTools?: () => Promise<AgentTool[]>;
			/**
			 * Reads the recall the loaded transcript's branch leaves the conversation carrying (`findConversationRecall`),
			 * of `scope`, the scope the live backend's recall reads ({@link recallScope}).
			 */
			recall?: (scope: () => string | undefined) => ConversationRecall | undefined;
			/** Reads the reports of a reused recall's changes the loaded branch delivered (`findDeliveredRecallChanges`). */
			recallChanges?: (scope: () => string | undefined) => readonly RecallChangesReport[];
		},
	) {
		this.#host = host;
		this.#memoryAgentDir = options.memoryAgentDir;
		this.#memoryTaskDepth = options.memoryTaskDepth ?? 0;
		this.#createMemoryTools = options.createMemoryTools;
		// Only Hindsight and Mnemopi recall into the conversation: under another backend, or with memory off, the
		// transcript's recall is history the session does not send again, and its branch is not read for it. Nor is
		// another backend's, bank's or server's recall: the live backend recalls afresh.
		const backend = cfgMemoryBackend.get(host.settings);
		this.#runningBackend = backend;
		if (options.memoryEnabled !== false && recallsIntoConversation(backend)) {
			const scope = () => this.recallScope();
			this.adoptRecall(options.recall?.(scope), options.recallChanges?.(scope) ?? []);
		}
		if (this.#memoryAgentDir) this.#runtimeCwd = host.cwd();
		// Subagents alias the parent's backend state and never replace it live.
		if (options.memoryEnabled !== false && this.#memoryAgentDir && this.#memoryTaskDepth === 0) {
			const value = memorySettingsValue();
			this.#observedSettings = value.get(host.settings);
			this.#appliedSettings = new Map(value.sources.map(setting => [setting, setting.get(host.settings)] as const));
			value.listen(host, () => this.#observeSettings());
		}
	}

	/**
	 * Dispatches memory-setting edits not handled yet. The settings listener and
	 * {@link settle} both land here, so an edit starts exactly once, whichever
	 * observes it first.
	 */
	#observeSettings(): void {
		const previous = this.#observedSettings;
		if (!previous || this.#host.isDisposed()) return;
		const next = memorySettingsValue().get(this.#host.settings);
		const changed: string[] = [];
		for (const id in next) if (!Bun.deepEquals(next[id], previous[id])) changed.push(id);
		if (changed.length === 0) return;
		this.#observedSettings = next;
		const handling = this.#applySettingsChange(changed);
		this.#settingsChanges.add(handling);
		void handling.then(() => this.#settingsChanges.delete(handling));
	}

	/**
	 * Resolves once the runtime reflects every memory-setting edit made so far:
	 * starts edits the listener has not delivered yet, then waits out backend
	 * transitions and settings hooks until no new work arrives. Failed edits are
	 * reported by their handler; callers inspect the settled runtime themselves.
	 */
	async settle(): Promise<void> {
		let drained: Promise<void> | undefined;
		for (;;) {
			this.#observeSettings();
			const transition = this.#memoryBackendTransition;
			if (transition === drained && this.#settingsChanges.size === 0) return;
			drained = transition;
			await Promise.all([transition, ...this.#settingsChanges]);
		}
	}

	/**
	 * Live memory-setting edits: switching `memory.backend` re-applies everything;
	 * edits to the active backend's own `<id>.*` settings go to its
	 * `applySettings` hook, or re-apply the backend when it has none. A hook
	 * takes the edit in itself, so once it returns the backend's own settings
	 * count as applied ({@link #takeSettingsChange}): a later apply or recall
	 * withdrawal does not take the edit for a change of its own. A backend
	 * switch written meanwhile is left to the apply it starts.
	 */
	async #applySettingsChange(changed: string[]): Promise<void> {
		try {
			if (changed.includes("memory.backend")) {
				await this.applyMemoryBackend();
				return;
			}
			// Queue synchronously, like a backend switch, so the next prompt's
			// transition drain orders after this edit.
			const hook = await this.#enqueueTransition(async () => {
				if (this.#host.isDisposed()) return undefined;
				const backend = await resolveMemoryBackend(this.#host.settings);
				const own = changed.filter(path => path.startsWith(`${backend.id}.`));
				if (own.length === 0) return undefined;
				if (backend.applySettings) return { backend, own };
				await this.#applyMemoryBackend(true);
				return undefined;
			});
			// Backend hooks may re-enter `applyMemoryBackend`, so they run outside the transition.
			if (!hook) return;
			await hook.backend.applySettings?.(this.#host.memoryBackendSession(), hook.own);
			this.#takeSettingsChange(hook.backend.id, { backendSwitch: false });
		} catch (error) {
			logger.warn("Memory lifecycle: applying setting change failed", { changed, error: String(error) });
			this.#host.emitNotice("error", `Failed to apply memory settings: ${String(error)}`, "Memory");
		}
	}

	/** Current serialized backend transition, used by prompt and disposal drains. */
	get transition(): Promise<void> {
		return this.#memoryBackendTransition;
	}

	/** Clears the per-turn memory promotion after a canonical prompt rebuild. */
	clearPromotionSnapshot(): void {
		this.#baseSystemPromptBeforeMemoryPromotion = undefined;
	}

	/** Captures the canonical prompt before the first per-turn memory promotion. */
	capturePromotionSnapshot(prompt: string[]): void {
		this.#baseSystemPromptBeforeMemoryPromotion ??= prompt;
	}

	/** The recall the conversation carries as a hidden message; undefined when its recall, if any, is a system block. */
	get hiddenRecall(): string | undefined {
		return this.#recall?.hidden ? this.#recall.text : undefined;
	}

	/** The recall the conversation carries, as a hidden message or as the system prompt's own last block. */
	get recall(): ConversationRecall | undefined {
		return this.#recall;
	}

	/**
	 * The scope the live backend's first-turn recall reads ({@link memoryRecallScope}), for the session's cwd and memory
	 * directory: a recall the branch records under another is not the conversation's.
	 */
	recallScope(): string | undefined {
		const settings = this.#host.settings;
		return memoryRecallScope(settings, this.#host.cwd(), this.#memoryAgentDir ?? settings.getAgentDir());
	}

	/**
	 * Records what the recall the backend just adopted leaves the conversation carrying: `recall`, as a hidden message
	 * or as the system prompt's own last block (undefined when it carries none), with the reports of what changed in a
	 * reused recall's memories (none for a fresh one). `adoptRecall(undefined, [])` withdraws the conversation's recall,
	 * which no later request or prompt build sends.
	 */
	adoptRecall(recall: ConversationRecall | undefined, changes: readonly RecallChangesReport[]): void {
		this.#recall = recall;
		this.#recallChanges = changes;
	}

	/** The reports of what changed in a reused recall's memories that the conversation carries, oldest first. */
	get recallChanges(): readonly RecallChangesReport[] {
		return this.#recallChanges;
	}

	/**
	 * Withdraws the conversation's recall ({@link adoptRecall}) after the backend's recall was reset, then rebuilds the
	 * base prompt. The running backend's own settings it took in since the last apply (a Hindsight state rebuilt for an
	 * edit of a `hindsight.*` setting) go with the rebuild ({@link #takeSettingsChange}), so a bound prompt holds it as
	 * it holds a backend apply; `/memory clear` and a cwd move take in none and rebuild at once. A backend switch, and
	 * the settings of the backend it selects, are left to the apply the switch starts.
	 */
	withdrawRecall(): Promise<void> {
		this.adoptRecall(undefined, []);
		const settingsChange = this.#takeSettingsChange(this.#runningBackend, { backendSwitch: false });
		return this.#host.refreshBaseSystemPrompt({ settingsChange });
	}

	/** Rekeys every active memory backend to the current provider session. */
	rekeyForCurrentSessionId(): void {
		this.#rekeyHindsightMemoryForCurrentSessionId();
		this.#rekeyMnemopiMemoryForCurrentSessionId();
	}

	#rekeyHindsightMemoryForCurrentSessionId(): void {
		if (cfgMemoryBackend.get(this.#host.settings) !== "hindsight") return;
		const sid = this.#host.agent.sessionId;
		if (!sid) return;
		this.#host.getHindsightSessionState()?.setSessionId(sid);
	}

	#rekeyMnemopiMemoryForCurrentSessionId(): void {
		if (cfgMemoryBackend.get(this.#host.settings) !== "mnemopi") return;
		const sid = this.#host.agent.sessionId;
		if (!sid) return;
		this.#host.getMnemopiSessionState()?.setSessionId(sid);
	}

	/** New transcript: reset Hindsight counters and reload its frozen mental-model snapshot. */
	#resetHindsightConversationTrackingIfHindsight(): boolean {
		if (cfgMemoryBackend.get(this.#host.settings) !== "hindsight") return false;
		const state = this.#host.getHindsightSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		// Start a bounded first-turn reload without delaying /new, fork, clear, or
		// session switches. A slow result is discarded so the previous snapshot
		// remains byte-stable for this transcript (#11961).
		state.beginMentalModelsTranscriptReload();
		return true;
	}

	#resetMnemopiConversationTrackingIfMnemopi(): boolean {
		if (cfgMemoryBackend.get(this.#host.settings) !== "mnemopi") return false;
		const state = this.#host.getMnemopiSessionState();
		if (!state || state.aliasOf) return false;
		state.resetConversationTracking();
		return true;
	}

	/** What a new transcript resets ({@link resetContextForNewTranscript}), for a failed session switch to put back. */
	conversationTracking(): ConversationTracking {
		const hindsight = this.#host.getHindsightSessionState();
		const mnemopi = this.#host.getMnemopiSessionState();
		return {
			promotionSnapshot: this.#baseSystemPromptBeforeMemoryPromotion,
			recall: this.#recall,
			recallChanges: this.#recallChanges,
			hindsight: hindsight && !hindsight.aliasOf ? hindsight.conversationTracking() : undefined,
			mnemopi: mnemopi && !mnemopi.aliasOf ? mnemopi.conversationTracking() : undefined,
		};
	}

	/** Puts back the state {@link conversationTracking} took, while rolling back a failed session switch. */
	restoreConversationTracking(tracking: ConversationTracking): void {
		this.#baseSystemPromptBeforeMemoryPromotion = tracking.promotionSnapshot;
		this.adoptRecall(tracking.recall, tracking.recallChanges);
		if (tracking.hindsight) this.#host.getHindsightSessionState()?.restoreConversationTracking(tracking.hindsight);
		if (tracking.mnemopi) this.#host.getMnemopiSessionState()?.restoreConversationTracking(tracking.mnemopi);
	}

	/** Resets transcript-scoped memory counters and removes a promoted prompt. */
	async resetContextForNewTranscript(): Promise<void> {
		// The new transcript does not carry the old one's recall, and the backend recalls afresh for it.
		this.adoptRecall(undefined, []);
		const hadPromotedMemoryPrompt = this.#baseSystemPromptBeforeMemoryPromotion !== undefined;
		const resetHindsight = this.#resetHindsightConversationTrackingIfHindsight();
		const resetMnemopi = this.#resetMnemopiConversationTrackingIfMnemopi();
		if (hadPromotedMemoryPrompt) {
			this.#host.setBaseSystemPrompt(this.#baseSystemPromptBeforeMemoryPromotion!);
			this.#baseSystemPromptBeforeMemoryPromotion = undefined;
		}
		if (resetHindsight || resetMnemopi || hadPromotedMemoryPrompt) {
			await this.#host.refreshBaseSystemPrompt();
		}
	}

	/** Cancel the local rollout-memory startup owned by this session. */
	cancelLocalMemoryStartup(): void {
		this.#localMemoryStartupAbort?.abort();
		this.#localMemoryStartupAbort = undefined;
	}

	/** Start a new local rollout-memory generation and cancel its predecessor. */
	beginLocalMemoryStartup(): AbortSignal {
		this.cancelLocalMemoryStartup();
		const controller = new AbortController();
		this.#localMemoryStartupAbort = controller;
		return controller.signal;
	}

	/** Release the local startup slot if `signal` still owns it. */
	endLocalMemoryStartup(signal: AbortSignal): void {
		if (this.#localMemoryStartupAbort?.signal === signal) this.#localMemoryStartupAbort = undefined;
	}

	async #disposeMemoryBackendState(consolidateMnemopi = true, retainMnemopi = true): Promise<void> {
		this.cancelLocalMemoryStartup();
		try {
			releaseSharpshooterSession(this.#host.memoryBackendSession());
		} catch (error) {
			logger.warn("Memory lifecycle: Sharpshooter dispose failed", { error: String(error) });
		}
		const hindsight = this.#host.getHindsightSessionState();
		if (hindsight) {
			try {
				await hindsight.flushRetainQueue();
			} catch (error) {
				logger.warn("Memory lifecycle: Hindsight flush failed", { error: String(error) });
			}
			this.#host.setHindsightSessionState(undefined);
			hindsight.dispose();
		}

		const mnemopi = this.#host.takeMnemopiSessionState();
		if (mnemopi) {
			try {
				await mnemopi.dispose({ consolidate: consolidateMnemopi, retain: retainMnemopi });
			} catch (error) {
				logger.warn("Memory lifecycle: Mnemopi dispose failed", { error: String(error) });
			}
		}
	}

	/**
	 * Apply the selected memory backend to runtime state, tools, and prompt.
	 * Concurrent settings changes run in order and settle before the next turn;
	 * requests arriving while an apply is still queued join it, since it reads
	 * settings only once it starts. Cwd rebinding can disable Mnemopi
	 * auto-retention without skipping its drain.
	 */
	async applyMemoryBackend(options: { retainMnemopi?: boolean } = {}): Promise<void> {
		if (this.#host.isDisposed()) return;
		const retainMnemopi = options.retainMnemopi !== false;
		const queued = this.#queuedApply;
		if (queued) {
			queued.retainMnemopi &&= retainMnemopi;
			return queued.done;
		}
		const request = { retainMnemopi, done: Promise.resolve() };
		this.#queuedApply = request;
		request.done = this.#enqueueTransition(() => {
			this.#queuedApply = undefined;
			return this.#applyMemoryBackend(request.retainMnemopi);
		});
		await request.done;
	}

	/** Runs `work` after every earlier transition; its failure does not block later ones. */
	#enqueueTransition<T>(work: () => Promise<T>): Promise<T> {
		const transition = this.#memoryBackendTransition.then(work);
		this.#memoryBackendTransition = transition.then(
			() => undefined,
			() => undefined,
		);
		return transition;
	}

	/**
	 * Starts the selected backend and swaps its tools and prompt in. The memory settings it takes in that moved since
	 * the last apply ({@link #takeSettingsChange}) go with the swap and the rebuild, so a bound prompt holds both as it
	 * holds any settings change: its tools and bytes stay as sent until the hold is due, and the settings notice tells
	 * the model. An apply that takes in no change (a cwd move, an explicit re-apply) swaps them in at once.
	 */
	async #applyMemoryBackend(retainMnemopi: boolean): Promise<void> {
		if (this.#host.isDisposed()) return;
		const cwd = this.#host.cwd();
		// A cwd move (or its rollback) may reach here before the rebind does:
		// drain the outgoing state without capturing the transcript under a stale scope.
		const retain = retainMnemopi && (this.#runtimeCwd ?? cwd) === cwd;
		let settingsChange: SettingChange[] | undefined;
		try {
			await this.#disposeMemoryBackendState(true, retain);
			// The backend starts again without a recall and recalls afresh at the next turn.
			this.adoptRecall(undefined, []);
			this.#runtimeCwd = cwd;
			if (this.#memoryAgentDir && this.#memoryTaskDepth === 0 && !this.#host.isDisposed()) {
				const backend = await resolveMemoryBackend(this.#host.settings);
				this.#runningBackend = backend.id;
				settingsChange = this.#takeSettingsChange(backend.id, { backendSwitch: true });
				await backend.start({
					session: this.#host.memoryBackendSession(),
					settings: this.#host.settings,
					modelRegistry: this.#host.modelRegistry,
					agentDir: this.#memoryAgentDir,
					taskDepth: this.#memoryTaskDepth,
				});
			}
			if (this.#host.isDisposed()) return;
			await this.#refreshMemoryTools(settingsChange);
			if (this.#host.isDisposed()) return;
			await this.#host.refreshBaseSystemPrompt({ settingsChange });
		} catch (error) {
			await this.#disposeMemoryBackendState(false);
			if (!this.#host.isDisposed()) {
				await this.#replaceMemoryTools([], settingsChange).catch(refreshError => {
					logger.warn("Failed to remove memory tools after backend apply error", {
						error: String(refreshError),
					});
				});
			}
			throw error;
		}
	}

	/**
	 * The settings of the backend `id` whose value moved since they were last taken in, each with the value taken in
	 * then; records the values now as taken in. Those are its own `<id>.*` settings, and `memory.backend` too with
	 * `backendSwitch`: only a backend apply ({@link #applyMemoryBackend}) takes a switch in, so a settings hook or a
	 * recall withdrawal that ends while a switch waits for its apply leaves the switch for that apply to name and hold.
	 * Undefined when none moved or live changes are disabled. Another backend's settings keep the value last taken in,
	 * so a switch to it later names an edit made while it was inactive.
	 */
	#takeSettingsChange(
		id: MemoryBackendId,
		{ backendSwitch }: { backendSwitch: boolean },
	): SettingChange[] | undefined {
		const applied = this.#appliedSettings;
		if (!applied) return undefined;
		const own = `${id}.`;
		const changes: SettingChange[] = [];
		for (const [setting, previous] of applied) {
			if (setting === cfgMemoryBackend ? !backendSwitch : !setting.id.startsWith(own)) continue;
			const value = setting.get(this.#host.settings);
			if (settingValuesEqual(value, previous)) continue;
			changes.push({ setting, previous });
			applied.set(setting, value);
		}
		return changes.length > 0 ? changes : undefined;
	}

	async #refreshMemoryTools(settingsChange: readonly SettingChange[] | undefined): Promise<void> {
		const tools = (await this.#createMemoryTools?.()) ?? [];
		await this.#replaceMemoryTools(tools, settingsChange);
	}

	#replaceMemoryTools(tools: AgentTool[], settingsChange: readonly SettingChange[] | undefined): Promise<void> {
		return this.#host.replaceMemoryTools(tools, { settingsChange });
	}
}
