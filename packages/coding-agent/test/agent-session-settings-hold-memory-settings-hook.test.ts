import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import { offBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/off-backend";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlaySession, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, Hindsight on. */
const HINDSIGHT_ON = "providers:\n  cacheRetention: long\nmemory:\n  backend: hindsight\n";

/** {@link HINDSIGHT_ON} with an edit of a Hindsight setting. */
const RECALL_BUDGET_EDITED = `${HINDSIGHT_ON}hindsight:\n  recallBudget: high\n`;

/** {@link RECALL_BUDGET_EDITED} with memory switched off. */
const SWITCHED_OFF = "providers:\n  cacheRetention: long\nmemory:\n  backend: off\nhindsight:\n  recallBudget: high\n";

/** {@link HINDSIGHT_ON} switched to Mnemopi, with an edit of a Mnemopi setting. */
const SWITCHED_TO_MNEMOPI =
	"providers:\n  cacheRetention: long\nmemory:\n  backend: mnemopi\nmnemopi:\n  injectionTokenLimit: 10\n";

const MEMORIES = "<memories>\nRelevant memories:\n\n- The deploy host is alpha-7.\n</memories>";

/**
 * A memory backend that behaves as Hindsight does: the first turn's recall is adopted into the memory instructions
 * of every later prompt build, and `clear` (`/memory clear`) drops it. When `editRebuildsState`, an edit of its own
 * settings installs a fresh state, which recalls afresh, and withdraws the conversation's recall
 * (`reconcilePrimaryState` in `hindsight/backend.ts`); otherwise the edit leaves its state as it is, as
 * `reconcilePrimaryState` does for an edit that moves neither its configuration nor its bank (any edit but
 * `hindsight.apiUrl` while no server is configured, for one).
 */
function hindsightLikeBackend(editRebuildsState: boolean): MemoryBackend {
	let adopted: string | undefined;
	let recalled = false;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions(_agentDir, _cwd, _settings, _session, options) {
			return adopted && !options?.recallDelivered ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {
			adopted = undefined;
		},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (recalled) return undefined;
			return {
				context: MEMORIES,
				commit: () => {
					recalled = true;
					adopted = MEMORIES;
					return true;
				},
			};
		},
		async applySettings(session) {
			if (!editRebuildsState) return;
			adopted = undefined;
			await session.withdrawMemoryRecall();
		},
	};
}

describe("a memory backend's own setting edited on a bound prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * A session on the gateway's claude-opus-5-5 whose memory backend `resolveBackend` gives, whose settings load an
	 * overlay with Hindsight on: sends two prompts, which bind the prompt with the first turn's recall, runs
	 * `afterBinding`, sends a third prompt and gives the three requests.
	 */
	async function threeRequests(
		resolveBackend: () => Promise<MemoryBackend>,
		afterBinding: (harness: OverlaySession, dir: TempDir) => Promise<void>,
	): Promise<[MessagesRequest, MessagesRequest, MessagesRequest]> {
		using dir = TempDir.createSync("@pi-settings-memory-hook-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, HINDSIGHT_ON);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockImplementation(resolveBackend);
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			await session.prompt("second");
			await afterBinding({ session, settings, overlay }, dir);
			await session.prompt("third");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the first turn's recall is in the system prompt the conversation is bound to.
		expect(withoutCacheControl(second.system)).toContain("alpha-7");
		return [first, second, third];
	}

	it("keeps the system prompt as sent while the state the edit rebuilt waits, and names the setting", async () => {
		const backend = hindsightLikeBackend(true);
		const [, second, third] = await threeRequests(
			async () => backend,
			async harness => {
				await reloadOverlay(harness, RECALL_BUDGET_EDITED);
				await harness.session.settleMemoryBackend();
			},
		);

		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(second.system));
		expect(withoutCacheControl(third.tools)).toBe(withoutCacheControl(second.tools));
		const notices = textOf(third.messages.slice(second.messages.length));
		expect(notices).toContain("is held");
		expect(notices).toContain("`hindsight.recallBudget`");
	}, 30_000);

	it("rebuilds the prompt at once at a later `/memory clear` when the backend took the edit in without a rebuild", async () => {
		const backend = hindsightLikeBackend(false);
		const [, second, third] = await threeRequests(
			async () => backend,
			async (harness, dir) => {
				await reloadOverlay(harness, RECALL_BUDGET_EDITED);
				await harness.session.settleMemoryBackend();
				// `/memory clear`: the backend drops its recall, then the conversation's recall is withdrawn.
				await backend.clear(dir.path(), dir.path());
				await harness.session.withdrawMemoryRecall();
			},
		);

		// The clear rebuilt the prompt without the recall, and no hold names the edit the backend already took in.
		expect(withoutCacheControl(third.system)).not.toContain("alpha-7");
		const notices = textOf(third.messages.slice(second.messages.length));
		expect(notices).not.toContain("is held");
		expect(notices).not.toContain("`hindsight.recallBudget`");
	}, 30_000);

	it("holds a backend switch written while the backend's settings hook runs, and names the switch", async () => {
		const hookEntered = Promise.withResolvers<void>();
		const hookDone = Promise.withResolvers<void>();
		const switchResolved = Promise.withResolvers<void>();
		// A hook that takes its time, as Hindsight's does while it rebuilds its state.
		const hindsight: MemoryBackend = {
			...hindsightLikeBackend(false),
			async applySettings() {
				hookEntered.resolve();
				await hookDone.promise;
			},
		};
		let selected = hindsight;
		const [, second, third] = await threeRequests(
			async () => {
				const backend = selected;
				// The switch's apply resolves the backend after the switch was written and before it takes the
				// settings in: it waits here until released.
				if (backend === offBackend) await switchResolved.promise;
				return backend;
			},
			async harness => {
				await reloadOverlay(harness, RECALL_BUDGET_EDITED);
				await hookEntered.promise;
				selected = offBackend;
				await reloadOverlay(harness, SWITCHED_OFF, []);
				// The hook returns once the switch is written. What runs after it runs in the microtasks that follow,
				// with no promise to await: one turn of the event loop, with no delay, runs them all before the switch's
				// apply goes on.
				hookDone.resolve();
				await Bun.sleep(0);
				switchResolved.resolve();
				await harness.session.settleMemoryBackend();
			},
		);

		// The switch's apply took the switch in: the system prompt stays as sent, and the notice names it.
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(second.system));
		const notices = textOf(third.messages.slice(second.messages.length));
		expect(notices).toContain("is held");
		expect(notices).toContain("`memory.backend`");
	}, 30_000);

	it("rebuilds the prompt at once at a `/memory clear` while a backend switch waits, taking none of the new backend's settings in", async () => {
		const switchResolved = Promise.withResolvers<void>();
		const hindsight = hindsightLikeBackend(false);
		const mnemopi: MemoryBackend = {
			id: "mnemopi",
			async start() {},
			async buildDeveloperInstructions() {
				return "Mnemopi instructions.";
			},
			async clear() {},
			async enqueue() {},
		};
		let selected = hindsight;
		const [, second, third] = await threeRequests(
			async () => {
				const backend = selected;
				// The switch's apply resolves the backend after the switch was written and before it takes the
				// settings in: it waits here until released, and so does any prompt build that resolves Mnemopi.
				if (backend === mnemopi) await switchResolved.promise;
				return backend;
			},
			async (harness, dir) => {
				selected = mnemopi;
				await reloadOverlay(harness, SWITCHED_TO_MNEMOPI, []);
				// `/memory clear` while the switch waits: the backend drops its recall, then the conversation's recall
				// is withdrawn, which takes the running backend's settings in before the switch's apply takes its own.
				await hindsight.clear(dir.path(), dir.path());
				const clearing = harness.session.withdrawMemoryRecall();
				switchResolved.resolve();
				await clearing;
				await harness.session.settleMemoryBackend();
			},
		);

		// The clear rebuilt the prompt without the recall at once: it took in no setting of the backend the switch
		// selects, so it held nothing and named nothing. The rewritten prompt cannot read the cached one, so the
		// switch goes out with it too, unheld.
		expect(withoutCacheControl(third.system)).not.toContain("alpha-7");
		const notices = textOf(third.messages.slice(second.messages.length));
		expect(notices).not.toContain("is held");
		expect(notices).not.toContain("`mnemopi.injectionTokenLimit`");
	}, 30_000);
});
