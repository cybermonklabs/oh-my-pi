/**
 * The spawn spec a task subagent's `session_init` stores: every input of the subagent build has a
 * class in the inventory, the stored spec is plain data a revive reads back part by part, and a
 * seance consult or a `/tan` clone stores none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalToolDescriptor } from "@oh-my-pi/pi-coding-agent/eval/types";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extractSessionInit, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import { type ExecutorOptions, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { type InputClass, readSpawnSpec, SPAWN_INPUT_CLASSES } from "@oh-my-pi/pi-coding-agent/task/spawn-spec";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, isRecord, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";
import { sessionInitRecords } from "./revive-harness";

const MOCK_API_SOURCE = "test/subagent-spawn-spec";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const AGENT_SYSTEM_PROMPT = "You report done.";
const LOOKUP_TOOL: EvalToolDescriptor = {
	name: "lookup_rows",
	description: "Looks up rows by key.",
	parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
	language: "python",
};

let savedEnv: Record<string, string | undefined> = {};
let root: string;
let cwd: string;
let artifactsDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spawn-spec-"));
	const home = path.join(root, "home");
	cwd = path.join(home, "work");
	artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);

	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	// Every run yields at once; the turn after the yield result (if any) ends with text.
	const mock = createMockModel({
		handler: context =>
			context.messages.at(-1)?.role === "toolResult"
				? { content: ["done"] }
				: { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	authStorage.close();
	await removeWithRetries(root);
});

/** Runs subagent `id` to its result on the mock model; returns its transcript file. */
async function spawn(id: string, extra: Partial<ExecutorOptions> = {}): Promise<string> {
	const result = await runSubprocess({
		cwd,
		artifactsDir,
		agent: { name: "task", description: "test", systemPrompt: AGENT_SYSTEM_PROMPT, source: "bundled" },
		task: "report done",
		index: 0,
		id,
		modelOverride: "mock/mock-model",
		authStorage,
		modelRegistry,
		settings,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
		...extra,
	});
	expect(result.exitCode).toBe(0);
	return path.join(artifactsDir, `${id}.jsonl`);
}

/** A transcript's records, as its lines hold them. */
async function transcriptLines(file: string): Promise<Array<Record<string, unknown>>> {
	const records: unknown[] = Bun.JSONL.parse(await Bun.file(file).text());
	return records.filter(isRecord);
}

async function peekInit(file: string) {
	const init = (await SessionManager.peekSessionInit(file))?.init;
	if (!init) throw new Error(`${file} holds no session_init`);
	return init;
}

describe("subagent spawn spec", () => {
	it("every input of a subagent build has one class in the spawn spec inventory", async () => {
		const create = vi.spyOn(sdkModule, "createAgentSession");
		const file = await spawn("Inventory", {
			context: "shared background",
			planReference: { path: "local://PLAN.md", content: "the plan" },
			customTools: createEvalCustomTools({ settings } as unknown as ToolSession, [LOOKUP_TOOL]),
		});
		await AgentLifecycleManager.global().park("Inventory");

		const options = create.mock.calls[0]?.[0];
		if (!options) throw new Error("the spawn built no session");
		const optionClasses: Readonly<Record<string, InputClass>> = SPAWN_INPUT_CLASSES.createAgentSessionOptions;
		expect(Object.keys(options).filter(key => !Object.hasOwn(optionClasses, key))).toEqual([]);
		// A key classed N is one no subagent build sets, so the SDK default holds on every path.
		const setKeys = Object.entries(options).flatMap(([key, value]) => (value === undefined ? [] : [key]));
		expect(setKeys.filter(key => optionClasses[key] === "N")).toEqual([]);

		// The prompt inputs and wake options the spec stores are exactly members classed S.
		const parts = readSpawnSpec(await peekInit(file));
		const promptClasses: Readonly<Record<string, InputClass>> = SPAWN_INPUT_CLASSES.subagentPromptInputs;
		const wakeClasses: Readonly<Record<string, InputClass>> = SPAWN_INPUT_CLASSES.ircWakeTurnMonitorOptions;
		expect(Object.keys(parts.prompt ?? {}).filter(key => promptClasses[key] !== "S")).toEqual([]);
		expect(Object.keys(parts.wake ?? {}).filter(key => wakeClasses[key] !== "S")).toEqual([]);
	});

	it("the stored spawn spec is plain data that survives a JSON round trip", async () => {
		const file = await spawn("PlainData", {
			context: "shared background",
			customTools: createEvalCustomTools({ settings } as unknown as ToolSession, [LOOKUP_TOOL]),
		});
		const session = localSession(AgentRegistry.global().get("PlainData")?.session);
		const held = extractSessionInit(session.sessionManager.getEntries())?.spawnSpec;
		await AgentLifecycleManager.global().park("PlainData");

		expect(held).toBeDefined();
		expect(held).toStrictEqual(JSON.parse(JSON.stringify(held)));
		const records = await sessionInitRecords(file);
		expect(records.length).toBeGreaterThan(0);
		// Each record on disk, the spawn's and any later one, holds the spec the session holds.
		for (const record of records) expect(record.spawnSpec).toStrictEqual(held);

		const parts = readSpawnSpec(await peekInit(file));
		expect(parts.stored).toBe(true);
		// Every part reads back; a spawn that armed no prewalk stores none, which reads as an absent part.
		expect(Object.entries(parts).filter(([name, part]) => part === undefined && name !== "prewalk")).toEqual([]);
		expect(parts.prewalk).toBeUndefined();
		expect(parts.model?.model).toBe("mock/mock-model");
		// The eval tool's descriptor is recovered from the tool object the spawn was handed.
		expect(parts.tools?.customTools).toEqual([LOOKUP_TOOL]);
		// The agent prompt is stored once, in the prompt inputs, and read back into the wake's agent.
		expect(parts.wake?.agent.systemPrompt).toBe(AGENT_SYSTEM_PROMPT);
	});

	describe("a seance consult and a /tan clone store no spawn spec", () => {
		it("a seance consult of a subagent transcript", async () => {
			const source = await spawn("SeanceSource");
			await AgentLifecycleManager.global().park("SeanceSource");
			const seance = getBundledAgent("seance");
			if (!seance) throw new Error("Expected the bundled seance agent");

			const file = await spawn("SeanceConsult", {
				agent: seance,
				task: "What did the source session do?",
				preparedSession: { fork: { sourceFile: source }, promptSuffix: () => "Consult the source session." },
			});
			await AgentLifecycleManager.global().park("SeanceConsult");

			// The consulted transcript's own record, spec included, is kept inert in the fork.
			const inherited = (await transcriptLines(file)).find(entry => entry.customType === "source_session_init");
			expect(inherited?.data).toHaveProperty("spawnSpec");
			const init = await peekInit(file);
			expect(init.agent).toBe("seance");
			expect(init.spawnSpec).toBeUndefined();
		});

		it("a /tan clone of a session whose transcript holds a spawn spec", async () => {
			const parentFile = await spawn("TanParent");
			await AgentLifecycleManager.global().park("TanParent");
			type JobRun = (ctx: { signal: AbortSignal }) => Promise<string>;
			const captured: { cloneManager?: SessionManager; job?: JobRun } = {};
			vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
				const manager = options?.sessionManager;
				if (!manager) throw new Error("the /tan clone got no session manager");
				captured.cloneManager = manager;
				const clone = {
					agent: { appendMessage: () => {}, state: { messages: [] } },
					sessionManager: manager,
					systemPrompt: ["tan prompt"],
					setTodoPhases: () => {},
					getEnabledToolNames: () => ["read"],
					getMountedXdevToolNames: () => [],
					setActiveToolPresentation: async () => {},
					subscribe: () => () => {},
					prompt: async () => {},
					waitForIdle: async () => {},
					hasPendingAsyncWork: () => false,
					settleAsyncWork: async () => {},
					getLastAssistantMessage: () => undefined,
					abort: () => {},
					dispose: () => manager.close(),
				};
				return { session: clone } as unknown as CreateAgentSessionResult;
			});
			const ctx = {
				session: {
					isStreaming: false,
					agent: {},
					model: { provider: "mock", id: "mock-model" },
					asyncJobManager: {
						register: (_type: string, _label: string, run: JobRun) => {
							captured.job = run;
							return "job-1";
						},
					},
					sessionId: "parent-session",
					configuredThinkingLevel: () => undefined,
					systemPrompt: ["parent prompt"],
					getActiveToolNames: () => ["read"],
					getEnabledToolNames: () => ["read"],
					getMountedXdevToolNames: () => [],
					modelRegistry,
					getAgentId: () => undefined,
					sendCustomMessage: async () => {},
				},
				sessionManager: {
					getHeader: () => undefined,
					getSessionFile: () => parentFile,
					getCwd: () => cwd,
					getArtifactsDir: () => parentFile.slice(0, -".jsonl".length),
					getSessionId: () => "parent-local-session",
					ensureOnDisk: async () => {},
					flush: async () => {},
				},
				settings,
				showStatus: () => {},
				showWarning: () => {},
				showError: (message: string) => {
					throw new Error(message);
				},
				rebuildChatFromMessages: () => {},
			} as unknown as InteractiveModeContext;

			expect(await new TanCommandController(ctx).start("look elsewhere")).toBe(true);
			const job = captured.job;
			if (!job) throw new Error("/tan registered no job");
			await job({ signal: new AbortController().signal });

			const cloneFile = captured.cloneManager?.getSessionFile();
			if (!cloneFile) throw new Error("the /tan clone has no session file");
			// The fork copies the parent's record with its spec; the clone's own record, the latest, has none.
			const records = await sessionInitRecords(cloneFile);
			expect(records[0]?.spawnSpec).toBeDefined();
			const init = await peekInit(cloneFile);
			expect(init.task).toBe("look elsewhere");
			expect(init.spawnSpec).toBeUndefined();
		});
	});
});
