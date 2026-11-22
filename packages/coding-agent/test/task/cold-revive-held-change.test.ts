/**
 * A task subagent whose prompt a configuration sync moves holds the change on its bound prompt, and a hidden settings
 * notice tells the model the change goes out by its deadline. A subagent that yields before then is parked, and a
 * cold revive (a restarted process, the hub scan) sends the prompt its transcript stores as its fixed prompt and holds
 * nothing. That stored prompt must be the one that goes out with the change: one that kept the held prompt would send
 * the old prompt on every request after the deadline the notice gave, and nothing would tell the model so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "../helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	heldOpen,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	withoutCacheControl,
} from "../helpers/anthropic-gateway";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";

/** The opening of the hidden settings notice. */
const SETTINGS_NOTICE = '<system-notice id="settings">';

/** The workstation line `includeModelInPrompt` renders into the prompt. */
const MODEL_LINE = "- Model:";

const MINUTE_MS = 60_000;

const AGENT_ID = "HeldReviveWorker";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** The overlay the subagent starts under: one-hour cache entries, and a subagent that stays live until parked. */
const INITIAL = [
	"providers:\n  cacheRetention: long",
	"modelRoles:\n  default: anthropic/claude-opus-5-5",
	"async:\n  enabled: false",
	"compaction:\n  enabled: false",
	"retry:\n  enabled: false",
	"todo:\n  enabled: false",
	"advisor:\n  enabled: false",
	"task:\n  agentIdleTtlMs: 0",
	"",
].join("\n");

/** A subagent parked while it held a change, and what a revive of it needs. */
interface ParkedRun {
	cwd: string;
	settings: Settings;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	requests: MessagesRequest[];
	/** Settles at the gateway's next request. */
	nextRequest(): Promise<void>;
}

describe("a parked subagent that held a settings change, revived cold", () => {
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cold-revive-held-change-"));
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work"), { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		await Bun.write(path.join(root, "models.yml"), gatewayModelsYml());
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	/**
	 * A subagent whose first request is in flight when a sync turns `includeModelInPrompt` off, a change its prompt
	 * renders; its second request, a minute later, keeps the prompt and carries the notice, and yields. Then it is
	 * parked.
	 */
	async function parkedWhileHolding(): Promise<ParkedRun> {
		const overlay = path.join(root, "overlay.yml");
		await Bun.write(overlay, INITIAL);
		const cwd = path.join(root, "home", "work");
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			configFiles: [overlay],
		});
		let requested = Promise.withResolvers<void>();
		let synced: Promise<void> = Promise.resolve();
		const gateway = mockGatewayFetch(turn => {
			requested.resolve();
			if (turn === 1) {
				synced = (async () => {
					const subagent = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
					await reloadOverlay(
						{ session: subagent, settings, overlay },
						`${INITIAL}includeModelInPrompt: false\n`,
						RELOAD_CALLS,
					);
					setClock(MINUTE_MS);
				})();
				return heldOpen(toolCallAnswer(turn, "read", { path: overlay }, { cacheWriteTokens: 100 }), synced);
			}
			if (turn === 2) {
				return toolCallAnswer(turn, "yield", { type: "result", data: "done" }, { cacheWriteTokens: 100 });
			}
			return answer(turn, { cacheWriteTokens: 100 });
		});
		cleanups.push(() => gateway.restore());
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		setClock(0);
		const result = await runSubprocess({
			cwd,
			artifactsDir: path.join(root, "artifacts"),
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "anthropic/claude-opus-5-5",
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		await synced;
		expect(result.exitCode).toBe(0);
		await AgentLifecycleManager.global().park(AGENT_ID);
		return {
			cwd,
			settings,
			authStorage,
			modelRegistry,
			requests: gateway.requests,
			nextRequest: () => {
				requested = Promise.withResolvers<void>();
				return requested.promise;
			},
		};
	}

	/** The parked subagent as a restarted process revives it from its session file. */
	async function coldRevive(run: ParkedRun): Promise<AgentSession> {
		const owner = {
			sessionManager: { getCwd: () => run.cwd, getArtifactManager: () => undefined },
			effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		} as unknown as AgentSession;
		const ref = AgentRegistry.global().get(AGENT_ID);
		if (!ref) throw new Error(`${AGENT_ID} is not registered`);
		const reviver = await createPersistedSubagentReviverFactory({
			session: owner,
			authStorage: run.authStorage,
			modelRegistry: run.modelRegistry,
			settings: run.settings,
			enableLsp: false,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = localSession(await reviver(ref));
		cleanups.push(() => revived.dispose());
		return revived;
	}

	/** Wakes `revived` with a message and returns the request the wake sends. */
	async function wake(run: ParkedRun, revived: AgentSession, body: string): Promise<MessagesRequest> {
		const before = run.requests.length;
		const requested = run.nextRequest();
		await revived.deliverIrcMessage({ id: `irc-${before}`, from: "Main", to: AGENT_ID, body, ts: before });
		await requested;
		await revived.agent.waitForIdle();
		const request = run.requests[before];
		if (!request) throw new Error("Expected the wake's request");
		return request;
	}

	/** The spawn's two requests: before the change, and the one that carries its notice. */
	function spawnRequests(run: ParkedRun): { first: MessagesRequest; held: MessagesRequest; notice: string } {
		const [first, held] = run.requests;
		if (!first || !held) throw new Error("Expected the spawn's two requests");
		const notice = textOf(held.messages.slice(first.messages.length));
		// Preconditions: the prompt renders the model, and the request after the change keeps it and is told the
		// change is held.
		expect(textOf(first.system)).toContain(MODEL_LINE);
		expect(withoutCacheControl(held.system)).toBe(withoutCacheControl(first.system));
		expect(notice).toContain(SETTINGS_NOTICE);
		expect(notice).toContain("`includeModelInPrompt`: `true` → `false`");
		return { first, held, notice };
	}

	it("sends the changed prompt when revived before the deadline, and tells the model nothing is held", async () => {
		const run = await parkedWhileHolding();
		const { held } = spawnRequests(run);

		setClock(2 * MINUTE_MS);
		const revived = await coldRevive(run);
		const woken = await wake(run, revived, "one more");

		expect(textOf(woken.system)).not.toContain(MODEL_LINE);
		expect(textOf(woken.messages.slice(held.messages.length))).not.toContain(SETTINGS_NOTICE);
	}, 60_000);

	it("sends the changed prompt from its first request when revived after the deadline the notice gave", async () => {
		const run = await parkedWhileHolding();
		const { held, notice } = spawnRequests(run);
		const deadline = notice.match(/at the first request made at (\S+) or later/)?.[1];
		if (!deadline) throw new Error("Expected the notice's deadline");

		setClock(7 * MINUTE_MS);
		// The revive comes after the time the notice gave for the change to go out.
		expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(deadline));
		const revived = await coldRevive(run);
		const woken = await wake(run, revived, "one more");
		const again = await wake(run, revived, "and another");

		expect(textOf(woken.system)).not.toContain(MODEL_LINE);
		// The change goes out once: the next request continues the prompt the first one sent.
		expect(withoutCacheControl(again.system)).toBe(withoutCacheControl(woken.system));
		expect(textOf(woken.messages.slice(held.messages.length))).not.toContain(SETTINGS_NOTICE);
	}, 60_000);
});
