/**
 * A subagent launched while its transcript cannot be written still runs. Its session file lives under
 * a directory that is a dangling link at launch, so every write of the default file store fails, as on
 * a disk or mount that went away. The subagent still asks the model; once the directory is back, its
 * next append writes the whole transcript. The control launches into a directory that exists.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "RefusedStore";
const MOCK_API_SOURCE = "test/executor-refused-first-write";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-refused-first-write-"));
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
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
	await removeWithRetries(root);
});

/** The ids a session file holds, header first, in file order (the title slot line carries none). */
function storedIds(content: string): string[] {
	return content
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as { type: string; id?: string })
		.filter(record => record.type !== "title")
		.map(record => record.id as string);
}

/**
 * Runs `AGENT_ID` to its yield with its transcript under `artifactsDir`; `beforeFirstTurn` runs when the
 * subagent makes its first model request, before the model answers.
 */
async function runSubagent(artifactsDir: string, beforeFirstTurn: () => void) {
	const cwd = path.join(root, "home", "work");
	fs.mkdirSync(cwd, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const turns = { count: 0 };
	const mock = createMockModel({
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
			if (turns.count++ === 0) beforeFirstTurn();
			return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		return { result, turns: turns.count };
	} finally {
		authStorage.close();
	}
}

/** Flushes the kept-alive subagent's transcript and returns what the file holds and what the session holds. */
async function transcriptOf(artifactsDir: string): Promise<{ stored: string[]; held: string[] }> {
	const manager = localSession(AgentRegistry.global().get(AGENT_ID)?.session).sessionManager;
	await manager.flush();
	return {
		stored: storedIds(fs.readFileSync(path.join(artifactsDir, `${AGENT_ID}.jsonl`), "utf8")),
		held: [manager.getHeader()?.id as string, ...manager.getEntries().map(entry => entry.id)],
	};
}

it("a subagent launched while its transcript cannot be written runs, and the transcript is written once writes come back", async () => {
	const store = path.join(root, "store");
	const artifactsDir = path.join(root, "artifacts");
	// Dangling until the subagent's first model request: every write under it fails (ENOENT).
	fs.symlinkSync(store, artifactsDir, "dir");

	const run = await runSubagent(artifactsDir, () => fs.mkdirSync(store));

	expect({ exitCode: run.result.exitCode, error: run.result.error }).toEqual({ exitCode: 0, error: undefined });
	expect(run.turns).toBeGreaterThan(0);
	const { stored, held } = await transcriptOf(artifactsDir);
	expect(stored).toEqual(held);
	expect(held.length).toBeGreaterThan(2);
}, 30_000);

it("a subagent that runs and parks while its transcript cannot be written keeps it, and it is written after the next write that lands", async () => {
	const store = path.join(root, "store");
	const artifactsDir = path.join(root, "artifacts");
	fs.symlinkSync(store, artifactsDir, "dir");

	const run = await runSubagent(artifactsDir, () => {});
	expect({ exitCode: run.result.exitCode, error: run.result.error }).toEqual({ exitCode: 0, error: undefined });
	const manager = localSession(AgentRegistry.global().get(AGENT_ID)?.session).sessionManager;
	// The idle-TTL park: the subagent's session closes while every write still fails.
	await AgentLifecycleManager.global()
		.park(AGENT_ID)
		.catch(() => undefined);
	const sessionFile = path.join(artifactsDir, `${AGENT_ID}.jsonl`);
	expect(fs.existsSync(sessionFile)).toBe(false);

	fs.mkdirSync(store);
	const parent = SessionManager.create(path.join(root, "home", "work"), path.join(root, "parent-sessions"));
	await parent.ensureOnDisk();
	await parent.close();

	const held = [manager.getHeader()?.id as string, ...manager.getEntries().map(entry => entry.id)];
	expect(held.length).toBeGreaterThan(2);
	expect(storedIds(fs.readFileSync(sessionFile, "utf8"))).toEqual(held);
}, 30_000);

it("control: a subagent launched into a directory that accepts writes runs and keeps its whole transcript", async () => {
	const artifactsDir = path.join(root, "artifacts");
	fs.mkdirSync(artifactsDir);

	const run = await runSubagent(artifactsDir, () => {});

	expect({ exitCode: run.result.exitCode, error: run.result.error }).toEqual({ exitCode: 0, error: undefined });
	expect(run.turns).toBeGreaterThan(0);
	const { stored, held } = await transcriptOf(artifactsDir);
	expect(stored).toEqual(held);
	expect(held.length).toBeGreaterThan(2);
}, 30_000);
