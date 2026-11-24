/**
 * A configuration sync turns `grep.enabled` off under a session whose prompt is bound: the session holds the change,
 * so `grep` stays declared and listed in the prompt's tool inventory until the rebuild, and its calls are refused. A
 * copy that cannot hold the change takes the prompt the session gives as the one that goes out with it: a `/tan` clone
 * sends it as its fixed prompt, and a parked subagent stores it for a cold revive. Neither copy declares `grep`, since
 * the setting gates it off. The prompt that goes out with the change lists the tools the session has after it, so a
 * copy's prompt must list only the tools its requests declare: one that lists `grep` tells the model of a tool it can
 * never call, on every request it makes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	heldOpen,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
} from "../helpers/anthropic-gateway";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MINUTE_MS = 60_000;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const AGENT_ID = "HeldGateWorker";

/** The overlay sessions start under: one-hour cache entries, background jobs on, and subagents that stay until parked. */
const INITIAL = [
	"providers:\n  cacheRetention: long",
	"modelRoles:\n  default: anthropic/claude-opus-5-5",
	"async:\n  enabled: true",
	"marketplace:\n  autoUpdate: off",
	"compaction:\n  enabled: false",
	"retry:\n  enabled: false",
	"todo:\n  enabled: false",
	"advisor:\n  enabled: false",
	"task:\n  enableLsp: false\n  agentIdleTtlMs: 0",
	"",
].join("\n");

/** {@link INITIAL} with `grep` gated off. */
const GREP_OFF = `${INITIAL}grep:\n  enabled: false\n`;

/** The real clock, read before the test moves it. */
const realNow = Date.now.bind(Date);

function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/** The tool names the prompt's tool inventory lists. */
function inventory(request: MessagesRequest | undefined): string[] {
	const lines = textOf(request?.system).split("\n");
	const start = lines.indexOf("# Tool Inventory");
	if (start === -1) throw new Error("Expected the prompt's tool inventory");
	const names: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const name = /^- (?:.*: )?`([^`]+)`$/.exec(line)?.[1];
		if (!name) break;
		names.push(name);
	}
	return names;
}

function declared(request: MessagesRequest | undefined): string[] {
	return (request?.tools ?? []).map(tool => tool.name);
}

/**
 * Rewrites the overlay and reloads it as the config watcher does, then waits for the prompt rebuild, the tool reconcile
 * and the hold the change starts.
 */
async function reload(session: AgentSession, settings: Settings, overlay: string, content: string): Promise<void> {
	const calls = ["refreshBaseSystemPrompt", "reconcileBuiltinTools", "holdToolDeclarationChange"] as const;
	const spies = calls
		.filter(call => typeof (session as unknown as Record<string, unknown>)[call] === "function")
		.map(call => vi.spyOn(session as unknown as Record<string, () => Promise<void>>, call));
	await Bun.write(overlay, content);
	await settings.reloadFromDisk();
	await Promise.resolve();
	await Promise.all(spies.flatMap(spy => spy.mock.results.map(result => result.value)));
	for (const spy of spies) spy.mockRestore();
}

describe("a copy of a session that holds a change disabling a tool", () => {
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-held-tool-set-copy-"));
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work"), { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		await Bun.write(path.join(root, "models.yml"), gatewayModelsYml());
		await Bun.write(path.join(root, "overlay.yml"), INITIAL);
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

	async function loadSettings(): Promise<{ cwd: string; overlay: string; settings: Settings }> {
		const cwd = path.join(root, "home", "work");
		const overlay = path.join(root, "overlay.yml");
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			configFiles: [overlay],
		});
		return { cwd, overlay, settings };
	}

	it("starts a /tan clone on a prompt that lists only the tools the clone declares", async () => {
		const { cwd, overlay, settings } = await loadSettings();
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(() => gateway.restore());
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session: parent } = await sdk.createAgentSession({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read", "grep"],
		});
		cleanups.push(() => parent.dispose());
		setClock(0);
		await parent.prompt("first");
		await reload(parent, settings, overlay, GREP_OFF);
		setClock(MINUTE_MS);
		await parent.prompt("second");

		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			cleanups.push(() => created.session.dispose());
			return created;
		});
		const manager = parent.asyncJobManager;
		if (!manager) throw new Error("Missing async job manager");
		let runJob: (() => Promise<unknown>) | undefined;
		vi.spyOn(manager, "register").mockImplementation((_type, _label, run) => {
			runJob = () =>
				run({
					jobId: "tan-test",
					signal: new AbortController().signal,
					reportProgress: async () => {},
					markRunning: () => {},
				});
			return "tan-test";
		});
		const context = {
			session: parent,
			sessionManager: parent.sessionManager,
			showHookConfirm: async () => true,
			rebuildChatFromMessages: () => {},
			settings,
			showError: (message: string) => {
				throw new Error(message);
			},
			showWarning: () => {},
			showStatus: () => {},
		} as unknown as InteractiveModeContext;
		const parentRequests = gateway.requests.length;
		setClock(2 * MINUTE_MS);
		await new TanCommandController(context).start("Check the deploy host");
		if (!runJob) throw new Error("Tan did not register its job");
		await runJob();

		const [first] = gateway.requests;
		const clone = gateway.requests[parentRequests];
		if (!clone) throw new Error("Expected the clone's request");
		// Preconditions: the session's first prompt lists and declares `grep`; the clone, under the gate, declares no
		// `grep`.
		expect(inventory(first)).toContain("grep");
		expect(declared(first)).toContain("grep");
		expect(declared(clone)).not.toContain("grep");

		expect(inventory(clone).filter(name => !declared(clone).includes(name))).toEqual([]);
	}, 60_000);

	it("revives a parked subagent cold on a prompt that lists only the tools it declares", async () => {
		const { cwd, overlay, settings } = await loadSettings();
		// The sync lands while the subagent's first request is in flight; its second request yields.
		let synced: Promise<void> = Promise.resolve();
		let requested = Promise.withResolvers<void>();
		const gateway = mockGatewayFetch(turn => {
			requested.resolve();
			if (turn === 1) {
				synced = (async () => {
					const subagent = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
					await reload(subagent, settings, overlay, GREP_OFF);
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
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools: ["read", "grep"] },
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

		// A restarted process revives it after the deadline the change's notice gave.
		setClock(7 * MINUTE_MS);
		const owner = {
			sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
			effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		} as unknown as AgentSession;
		const ref = AgentRegistry.global().get(AGENT_ID);
		if (!ref) throw new Error(`${AGENT_ID} is not registered`);
		const reviver = await createPersistedSubagentReviverFactory({
			session: owner,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		const revived = localSession(await reviver(ref));
		cleanups.push(() => revived.dispose());
		const before = gateway.requests.length;
		requested = Promise.withResolvers<void>();
		await revived.deliverIrcMessage({ id: "irc-wake", from: "Main", to: AGENT_ID, body: "one more", ts: before });
		await requested.promise;
		await revived.agent.waitForIdle();

		const [first] = gateway.requests;
		const woken = gateway.requests[before];
		if (!woken) throw new Error("Expected the revived subagent's request");
		// Preconditions: the subagent's first prompt lists and declares `grep`; the revived one, under the gate,
		// declares no `grep`.
		expect(inventory(first)).toContain("grep");
		expect(declared(first)).toContain("grep");
		expect(declared(woken)).not.toContain("grep");

		expect(inventory(woken).filter(name => !declared(woken).includes(name))).toEqual([]);
	}, 60_000);
});
