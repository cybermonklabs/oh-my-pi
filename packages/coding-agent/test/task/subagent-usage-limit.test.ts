/**
 * A subagent whose turn ends on a provider usage limit must tell its parent
 * the kind of failure and when the limit resets. Codex-style limit errors carry
 * no reset hint in their text, so the reset time exists only in the usage
 * report recovery recorded; a parent that sees only the prose error cannot
 * choose between waiting for the reset and rerouting the work.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { opencodeGoUsageProvider } from "@oh-my-pi/pi-ai/usage/opencode-go";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MOCK_API_SOURCE = "test/subagent-usage-limit";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

/** OpenCode Go keys sharing one usage report; `weeklyResetAtMs` marks the weekly window spent until then. */
async function storageWithUsage(keys: string[], weeklyResetAtMs?: number): Promise<AuthStorage> {
	const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider => (provider === "opencode-go" ? opencodeGoUsageProvider : undefined),
		usageFetch: (async () =>
			new Response(
				JSON.stringify({
					usage: {
						rolling: {
							status: "ok",
							percent: 12,
							resetsAt: new Date(Date.now() + 300_000).toISOString(),
						},
						weekly:
							weeklyResetAtMs === undefined
								? {
										status: "ok",
										percent: 20,
										resetsAt: new Date(Date.now() + 5 * 24 * 3_600_000).toISOString(),
									}
								: { status: "rate-limited", percent: 100, resetsAt: new Date(weeklyResetAtMs).toISOString() },
						monthly: {
							status: "ok",
							percent: 8,
							resetsAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
						},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch,
	});
	await storage.credentials.reload();
	await storage.credentials.set(
		"opencode-go",
		keys.map(key => ({ type: "api_key" as const, key })),
	);
	return storage;
}

/** Runs one subagent whose every request fails with `errorText`. */
async function runSubagentFailingWith(authStorage: AuthStorage, errorText: string): Promise<SingleResult> {
	const cwd = path.join(root, "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const mock = createMockModel({
		provider: "opencode-go",
		id: "usage-limit-probe",
		handler: () => ({ throw: errorText }),
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	return runSubprocess({
		cwd,
		artifactsDir,
		agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
		task: "report done",
		index: 0,
		id: "QuotaSpent",
		modelOverride: "opencode-go/usage-limit-probe",
		authStorage,
		modelRegistry,
		settings: Settings.isolated({
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			modelRoles: { default: "opencode-go/usage-limit-probe" },
		}),
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
	});
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-usage-limit-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	// An ambient provider env key would outrank the stored key the usage report belongs to.
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
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
	await removeWithRetries(root);
});

it("tells the parent a subagent stopped on a usage limit and when that limit resets", async () => {
	const weeklyResetAtMs = Date.now() + 7_200_000;
	const authStorage = await storageWithUsage(["opencode-go-usage-key"], weeklyResetAtMs);
	try {
		// Codex's limit wording names no reset: the reset time lives only in the usage report.
		const result = await runSubagentFailingWith(
			authStorage,
			"Codex error event: The usage limit has been reached (code=usage_limit_reached)",
		);

		expect(result.exitCode).toBe(1);
		expect(result.retryFailure?.kind).toBe("usage-limit");
		expect(result.retryFailure?.resetAtMs).toBe(weeklyResetAtMs);

		const summary = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
		expect(summary).toContain('kind="usage-limit"');
		expect(summary).toContain(`reset-at="${new Date(weeklyResetAtMs).toISOString()}"`);
	} finally {
		authStorage.close();
	}
}, 30_000);

it("reports the provider's stated reset, not a sibling account's guessed block", async () => {
	// Another session's hintless limit left a 30-minute heuristic block on the
	// first key, so recovery would retry when that sibling frees up. That guess
	// is not when the provider accepts the subagent's account again.
	const authStorage = await storageWithUsage(["opencode-go-key-1", "opencode-go-key-2"]);
	try {
		await authStorage.keys.get("opencode-go", "other-session");
		await authStorage.limits.markReached("opencode-go", "other-session", { retryAfterMs: 1_800_000 });

		const startedAtMs = Date.now();
		const result = await runSubagentFailingWith(authStorage, "Weekly usage limit reached. retry-after-ms=7200000");
		const settledAtMs = Date.now();

		expect(result.exitCode).toBe(1);
		const resetAtMs = result.retryFailure?.resetAtMs ?? Number.NaN;
		expect(resetAtMs).toBeGreaterThanOrEqual(startedAtMs + 7_200_000);
		expect(resetAtMs).toBeLessThanOrEqual(settledAtMs + 7_200_000);
	} finally {
		authStorage.close();
	}
}, 30_000);

it("still delivers the parent's task result when the provider states an impossible reset", async () => {
	// A hint past the `Date` range used to crash the envelope and overflow the SDKs' int64 field.
	const authStorage = await storageWithUsage(["opencode-go-usage-key"]);
	try {
		const result = await runSubagentFailingWith(
			authStorage,
			"Weekly usage limit reached. retry-after-ms=99999999999999999999",
		);

		expect(result.exitCode).toBe(1);
		expect(result.retryFailure?.kind).toBe("usage-limit");
		expect(result.retryFailure?.resetAtMs).toBeUndefined();
		const summary = formatTaskResultSummary(result, { totalDurationMs: result.durationMs });
		expect(summary).toContain('status="failed (exit 1)"');
		expect(summary).toContain('kind="usage-limit"');
		expect(summary).not.toContain("reset-at=");
	} finally {
		authStorage.close();
	}
}, 30_000);
