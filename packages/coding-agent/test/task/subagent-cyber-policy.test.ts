/**
 * After OpenAI refuses a turn's content for cyber policy, every OpenAI route stays closed for the rest of
 * the turn, and a subagent the turn starts is part of it: a subagent configured for an OpenAI model makes
 * no model call and reports why, and a refusal inside a subagent closes the routes of the tree that
 * started it. Synthetic refusals only.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { CyberPolicyClosure } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const MOCK_API_SOURCE = "test/subagent-cyber-policy";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

const CYBER_POLICY: MockResponse = {
	stopReason: "error",
	errorMessage: "cyber_policy: This content was flagged for possible cybersecurity risk.",
};

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-cyber-policy-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
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

async function runSubagent(options: {
	id: string;
	closure: CyberPolicyClosure;
	answer: () => MockResponse;
}): Promise<{ requests: number; exitCode: number; error: string | undefined }> {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: `mock/${options.id}` },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	let requests = 0;
	const mock = createMockModel({
		id: options.id,
		handler: () => {
			requests++;
			return options.answer();
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "Review the change and report.",
			index: 0,
			id: "Reviewer",
			modelOverride: `mock/${options.id}`,
			parentAgentId: MAIN_AGENT_ID,
			authStorage,
			modelRegistry,
			settings,
			cyberPolicyClosure: options.closure,
			structured: false,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		return { requests, exitCode: result.exitCode, error: result.error };
	} finally {
		authStorage.close();
	}
}

const OPENAI_ID = "gpt-5.5";

it("a subagent on an OpenAI model makes no model call while the parent's refusal holds, and says why", async () => {
	expect(createMockModel({ id: OPENAI_ID }).identity.class).toBe("openai");
	const closure = new CyberPolicyClosure();
	closure.record();

	const result = await runSubagent({ id: OPENAI_ID, closure, answer: () => ({ content: ["done"] }) });

	expect(result.requests).toBe(0);
	expect(result.exitCode).toBe(1);
	expect(result.error).toContain("cyber_policy");
}, 30_000);

it("a subagent on an OpenAI model runs when no refusal holds, as before", async () => {
	const result = await runSubagent({
		id: OPENAI_ID,
		closure: new CyberPolicyClosure(),
		answer: () => ({ content: ["done"] }),
	});

	expect(result.requests).toBeGreaterThan(0);
}, 30_000);

it("a subagent's refusal closes the routes of the tree that started it", async () => {
	const closure = new CyberPolicyClosure();

	const result = await runSubagent({ id: OPENAI_ID, closure, answer: () => CYBER_POLICY });

	expect(result.requests).toBe(1);
	expect(closure.isClosed(getBundledModel("openai-codex", "gpt-5.6-sol"))).toBe(true);
	expect(closure.isClosed(getBundledModel("anthropic", "claude-sonnet-4-5"))).toBe(false);
}, 30_000);
