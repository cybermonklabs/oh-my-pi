/**
 * `omp --restore` and a subagent whose turn ended on a key it could not resolve, after its parent
 * got that failure and went on. A parent that got it from a `task` call holds it, so `--restore`
 * leaves the subagent (the control). A parent whose JavaScript eval cell got it through
 * `tool.task` holds it the same way, and `--restore` leaves that subagent too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hasRestorableTurn } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import * as piUtils from "@oh-my-pi/pi-utils";
import { $which, __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MOCK_API_SOURCE = "restore-after-eval-cell-result-test";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const NOTES_FILE = "notes.txt";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-after-eval-cell-result-");
	const home = root.join("home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	registerMockApi(MOCK_API_SOURCE);
	// Every wait passes at once. Turn recovery's backoff sleeps through sleepLong/sleepUntil, which recheck
	// the real clock: with only scheduler.wait replaced they call it again and again until the real
	// deadline, and the spy keeps every call (millions, many GiB).
	vi.spyOn(scheduler, "wait").mockImplementation(async (_delayMs, options) => {
		options?.signal?.throwIfAborted();
	});
	vi.spyOn(piUtils, "sleepLong").mockImplementation(async (_delayMs, signal) => {
		signal?.throwIfAborted();
	});
	vi.spyOn(piUtils, "sleepUntil").mockImplementation(async (_deadlineMs, signal) => {
		signal?.throwIfAborted();
	});
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
});

const WORKER: AgentDefinition = {
	name: "keyed-worker",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};

const TASK_ARGS = {
	context: "The notes need a review.",
	tasks: [{ name: "Worker", agent: WORKER.name, task: `Read ${NOTES_FILE} and report it.` }],
};

/** A cell that runs the worker as an `agent()` job and takes its result with `wait()`. */
const AGENT_CELL = [
	`const handle = await agent(${JSON.stringify(TASK_ARGS.tasks[0]!.task)}, { agent: ${JSON.stringify(WORKER.name)} });`,
	"try { print(await wait([handle])); } catch (error) { print(String(error)); }",
].join("\n");

const DELEGATIONS = {
	"a task call": { type: "toolCall" as const, id: "call_task", name: "task", arguments: TASK_ARGS },
	"an eval cell's tool.task": {
		type: "toolCall" as const,
		id: "call_eval",
		name: "eval",
		arguments: { language: "js", code: `print(await tool.task(${JSON.stringify(TASK_ARGS)}))`, timeout: 0 },
	},
	"a Python eval cell's tool.task": {
		type: "toolCall" as const,
		id: "call_python_eval",
		name: "eval",
		arguments: { language: "py", code: `print(await tool.task(${JSON.stringify(TASK_ARGS)}))`, timeout: 0 },
	},
	"an eval cell's agent() and wait()": {
		type: "toolCall" as const,
		id: "call_agent_eval",
		name: "eval",
		arguments: { language: "js", code: AGENT_CELL, timeout: 0 },
	},
	"a backgrounded eval cell's agent() and wait()": {
		type: "toolCall" as const,
		id: "call_agent_background_eval",
		name: "eval",
		arguments: { language: "js", code: AGENT_CELL, timeout: 0 },
	},
};

async function runParent(call: (typeof DELEGATIONS)[keyof typeof DELEGATIONS]) {
	const python = "language" in call.arguments && call.arguments.language === "py";
	const interpreter = Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "";
	if (python && !interpreter) throw new Error("The Python eval case needs python3 or python on PATH, or PYTHON set");
	const cwd = root.join("home", "work");
	await Bun.write(path.join(cwd, NOTES_FILE), "the notes\n");
	const authStorage = await AuthStorage.create(root.join("parentauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	await authStorage.credentials.set("anthropic", [
		{
			type: "oauth",
			access: "access-acc-live",
			refresh: "refresh-acc-live",
			expires: Date.now() + 3_600_000,
			accountId: "acc-live",
			email: "acc-live@example.com",
		},
	]);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	const parentModel = createMockModel({
		id: "parent-model",
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "task")) return { content: ["label"] };
			if (context.messages.some(message => message.role === "toolResult")) {
				return { content: ["The worker could not read the notes."] };
			}
			return { content: [call], stopReason: "toolUse" };
		},
	});
	const workerModel = createMockModel({
		provider: "anthropic",
		id: "mock-claude",
		handler: async context => {
			if (!(context.tools ?? []).some(tool => tool.name === "read")) return { content: ["label"] };
			if (!context.messages.some(message => message.role === "toolResult")) {
				for (const account of authStorage.oauth.accounts("anthropic")) {
					await authStorage.credentials.disable(account.credentialId, LOGIN_DISABLED_CAUSE);
				}
				return {
					content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: NOTES_FILE } }],
					stopReason: "toolUse",
				};
			}
			return { content: ["the notes"] };
		},
	});
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [parentModel, workerModel]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [WORKER], projectAgentsDir: null });
	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("parent-sessions")),
		settings: Settings.isolated({
			"async.enabled": call.id.startsWith("call_agent"),
			"task.batch": true,
			"task.enableLsp": false,
			"task.completionProbe": false,
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": 5_000,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"autolearn.enabled": false,
			"eval.py": python,
			"python.interpreter": interpreter,
			"eval.autoBackground.enabled": call.id === "call_agent_background_eval",
			"eval.autoBackground.thresholdMs": 1,
		}),
		toolNames: call.name === "eval" ? ["eval", "task"] : ["task"],
		spawns: "*",
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	cleanups.push(() => session.dispose());
	if (call.name === "eval") cleanups.push(() => disposeAllVmContexts());
	await session.prompt("Delegate reading the notes.");
	await session.waitForIdle();
	// A backgrounded cell finishes as a job, and its result reaches the parent as a delivery.
	await Promise.allSettled((session.asyncJobManager?.getRunningJobs() ?? []).map(job => job.promise));
	await session.asyncJobManager?.drainDeliveries({ timeoutMs: 10_000 });
	await session.waitForIdle();
	return session;
}

async function restoreInNewProcess(parent: AgentSession) {
	const parentFile = parent.sessionManager.getSessionFile();
	if (!parentFile) throw new Error("Expected a persisted parent session file");
	const parentText = parent.agent.state.messages
		.filter(message => message.role === "assistant")
		.flatMap(message => message.content.filter(part => part.type === "text").map(part => part.text));
	// A cell that moved to the background answers its call with the job marker (`details.async`).
	const backgrounded = parent.agent.state.messages.some(
		message =>
			message.role === "toolResult" &&
			message.toolName === "eval" &&
			(message.details as { async?: unknown } | undefined)?.async !== undefined,
	);
	await parent.dispose();
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	const reopened = await SessionManager.open(parentFile, undefined, undefined, { suppressBreadcrumb: true });
	const parentEntries = reopened.getEntries();
	const leafId = reopened.getLeafId();
	await reopened.close();
	const manager = new AsyncJobManager({});
	cleanups.push(() => manager.dispose({ timeoutMs: 1000 }));
	manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
	vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(
		async options => ({ index: 0, id: options.id, exitCode: 0, output: "the notes" }) as SingleResult,
	);
	const outcome = await restoreSession({
		sessionManager: { getSessionFile: () => parentFile, getEntries: () => parentEntries, getLeafId: () => leafId },
		asyncJobManager: manager,
		settings: Settings.isolated(),
		restoreInterruptedTurn: vi.fn(async () => false),
	} as unknown as AgentSession);
	for (const id of outcome.subagents) await manager.getJob(id)?.promise;
	const subagents = Object.values(await collectSubSessions(parentFile)).map(sub => ({
		id: sub.agentId,
		restorableAlone: hasRestorableTurn(sub.entries),
	}));
	return { backgrounded, outcome, parentText, subagents };
}

describe("omp --restore after the parent got its subagent's failed key turn and went on", () => {
	for (const [name, call] of Object.entries(DELEGATIONS)) {
		it(`leaves the subagent when the parent got the failure from ${name}`, async () => {
			const parent = await runParent(call);
			const { backgrounded, outcome, parentText, subagents } = await restoreInNewProcess(parent);
			expect(backgrounded).toBe(call.id === "call_agent_background_eval");
			expect(subagents).toEqual([{ id: expect.any(String), restorableAlone: true }]);
			expect(parentText).toContain("The worker could not read the notes.");
			expect(outcome.subagents).toEqual([]);
		}, 60_000);
	}
});
