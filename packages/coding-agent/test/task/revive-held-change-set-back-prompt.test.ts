/**
 * A configuration sync turns `grep.enabled` on under a parked-to-be subagent whose prompt is bound: the session holds
 * the change, and as it parks it stores the prompt that goes out with the change (one that lists `grep`) for a cold
 * revive. A later sync sets the change back before the revive. The revive sends the stored prompt as its fixed prompt
 * and declares the tools its settings give, which no longer include `grep`, so its prompt tells the model of a tool
 * it can never call, on every request it makes. A session that made no model call after the change and stored the
 * prompt it last sent lists only what it declares. The same holds for a change the pods' sync makes to the task
 * agents (`task.disabledAgents` disabling `scout`): set back, the revived prompt still tells the model `scout` cannot
 * be spawned although its settings allow it.
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
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
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

/** {@link INITIAL} with `grep` gated off: where the subagent starts, and what the second sync sets back. */
const GREP_OFF = `${INITIAL}grep:\n  enabled: false\n`;

/** {@link INITIAL} with the `scout` agent disabled, a change the pods' sync makes to the task agents. */
const SCOUT_OFF = INITIAL.replace("agentIdleTtlMs: 0", "agentIdleTtlMs: 0\n  disabledAgents: [scout]");

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

describe("a cold revive after a held change is set back", () => {
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-revive-set-back-"));
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

	/**
	 * Starts a subagent under `start`, lets a sync write `changed` while it waits on a bound prompt, parks it, sets the
	 * change back, and revives it cold at +7 min. Returns the subagent's first request and the revived one's.
	 */
	async function parkSetBackRevive(
		start: string,
		changed: string,
		tools: string[],
	): Promise<{ first: MessagesRequest | undefined; woken: MessagesRequest }> {
		const { cwd, overlay, settings } = await loadSettings();
		await Bun.write(overlay, start);
		await settings.reloadFromDisk();
		let requested = Promise.withResolvers<void>();
		const gateway = mockGatewayFetch(turn => {
			requested.resolve();
			if (turn === 1) {
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
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools, spawns: "*" },
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
		expect(result.exitCode).toBe(0);
		// The sync changes the setting while the subagent waits with a bound prompt; it parks holding the change.
		setClock(MINUTE_MS);
		const subagent = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
		await reload(subagent, settings, overlay, changed);
		await AgentLifecycleManager.global().park(AGENT_ID);
		// A later sync sets the change back before anything revives the subagent.
		await Bun.write(overlay, start);
		await settings.reloadFromDisk();

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
		return { first, woken };
	}

	it("revives a parked subagent on a prompt that lists only the tools it declares", async () => {
		const { first, woken } = await parkSetBackRevive(GREP_OFF, INITIAL, ["read", "grep"]);
		// Preconditions: the subagent started without `grep`, and the revived one, under the gate set back, declares no
		// `grep`.
		expect(declared(first)).not.toContain("grep");
		expect(inventory(first)).not.toContain("grep");
		expect(declared(woken)).not.toContain("grep");

		expect(inventory(woken).filter(name => !declared(woken).includes(name))).toEqual([]);
	}, 60_000);

	it("revives a parked subagent on the prompt its settings give once a held task.disabledAgents change is set back", async () => {
		const { first, woken } = await parkSetBackRevive(INITIAL, SCOUT_OFF, ["read", "grep", "task"]);
		const firstLines = textOf(first?.system).split("\n");
		// Preconditions: the subagent started with `scout` available and the revived one declares the tools it started with.
		expect(firstLines.some(line => line.includes("read-only `scout`"))).toBe(true);
		expect(declared(woken)).toEqual(declared(first));

		// The settings are those it started under again, so its prompt is the one it started on.
		expect(
			textOf(woken.system)
				.split("\n")
				.filter(line => !firstLines.includes(line)),
		).toEqual([]);
	}, 60_000);
});
