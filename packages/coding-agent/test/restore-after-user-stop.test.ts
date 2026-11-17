/**
 * `omp --restore` and a turn that ended because no request could resolve its
 * provider key (the `credentialUnavailable` marker): the marker makes such a turn
 * restorable after a normal exit, but never one the user stopped. Two ways the
 * user stops it: an abort, or Esc (`abortRetry`), while the turn waits out a retry
 * backoff; and a `/clear` of the parent conversation whose subagent was stranded.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type Model, streamSimple, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { hasRestorableTurn, SESSION_EXIT_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import type { SingleResult, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { restoreEnvValue } from "./helpers/settings-test-state";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const MOCK_API_SOURCE = "restore-after-user-stop-test";
const PROVIDER_SESSION_ID = "restore-after-user-stop-session";
const FINAL_ANSWER = "finished after the key came back";
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const probeSchema = type({ value: "string" });

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-restore-after-user-stop-");
	const home = root.join("home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	const failures: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		await AgentLifecycleManager.global().dispose();
	} catch (error) {
		failures.push(error);
	}
	setSystemTime();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
	if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
});

function oauthLogin(account: string) {
	return {
		type: "oauth" as const,
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires: Date.now() + 3_600_000,
		accountId: account,
		email: `${account}@example.com`,
	};
}

function anthropicModel(): Model<Api> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
	return model;
}

interface KeyContext {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

/** The test's credential store, holding one anthropic OAuth login, and its model registry. */
async function setUp(): Promise<KeyContext> {
	const authStorage = await AuthStorage.create(root.join("testauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	return { authStorage, modelRegistry };
}

/**
 * A session on the production key path (`ModelRegistry.turnResolver`, as sdk.ts wires it)
 * whose model calls `probe` once and then answers; `onProbe` runs while the tool runs.
 */
async function openSession(
	ctx: KeyContext,
	options: { baseDelayMs: number; sessionManager: SessionManager; onProbe?: () => Promise<void> },
) {
	const model = anthropicModel();
	let probeRuns = 0;
	const probe: AgentTool<typeof probeSchema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			probeRuns++;
			if (probeRuns === 1) await options.onProbe?.();
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	const mock = createMockModel({
		id: model.id,
		provider: model.provider,
		handler: context =>
			context.messages.some(message => message.role === "toolResult")
				? { content: [FINAL_ANSWER], stopReason: "stop" }
				: {
						content: [{ type: "toolCall", id: "call_probe", name: "probe", arguments: { value: "x" } }],
						stopReason: "toolUse",
					},
	});
	const agent = new Agent({
		getApiKey: async requestModel => ctx.modelRegistry.turnResolver(requestModel, PROVIDER_SESSION_ID),
		sessionId: PROVIDER_SESSION_ID,
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [probe as AgentTool],
			messages: options.sessionManager.buildSessionContext().messages,
		},
		streamFn: (_requestModel, context, streamOptions) => streamSimple(mock.model, context, streamOptions),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": options.baseDelayMs,
		"retry.maxRetries": 3,
		"retry.modelFallback": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const session = new AgentSession({
		agent,
		sessionManager: options.sessionManager,
		settings,
		modelRegistry: ctx.modelRegistry,
		providerSessionId: PROVIDER_SESSION_ID,
	});
	cleanups.push(() => session.dispose());
	const retryStarts: AutoRetryStartEvent[] = [];
	const retryEnds: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") retryStarts.push(event);
		if (event.type === "auto_retry_end") retryEnds.push(event);
	});
	return { session, mock, retryStarts, retryEnds };
}

describe("omp --restore after the user stopped a turn whose key could not be resolved", () => {
	const stops: Record<string, (session: AgentSession) => Promise<void> | void> = {
		"an abort (RPC abort)": session => session.abort(),
		"Esc (abortRetry)": session => session.abortRetry(),
	};
	for (const [stop, stopTurn] of Object.entries(stops)) {
		it(`does not go on with a turn the user stopped during its retry backoff: ${stop}`, async () => {
			// If this regresses, the stopped turn keeps its marked error as the session's tail, and a later
			// `omp --restore` sends the request the user stopped.
			const ctx = await setUp();
			const worker = await openSession(ctx, {
				baseDelayMs: 5_000,
				sessionManager: SessionManager.create(root.path(), root.join("sessions")),
				// A failed refresh disables the login while the tool runs, so the next request has no key.
				onProbe: async () => {
					for (const account of ctx.authStorage.oauth.accounts("anthropic")) {
						await ctx.authStorage.credentials.disable(account.credentialId, LOGIN_DISABLED_CAUSE);
					}
				},
			});
			// The backoff (the only wait of a second or more) holds until it is aborted; the short
			// waits that schedule continuations pass at once.
			const backoffStarted = Promise.withResolvers<void>();
			const wait = vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
				options?.signal?.throwIfAborted();
				if (delayMs < 1_000) return;
				backoffStarted.resolve();
				const held = Promise.withResolvers<void>();
				options?.signal?.addEventListener("abort", () => held.reject(options.signal?.reason), { once: true });
				await held.promise;
			});

			// A stop may reject the prompt; how the turn ended is read from the session file.
			const prompting = worker.session.prompt("run the probe").catch(() => undefined);
			await backoffStarted.promise;
			await stopTurn(worker.session);
			await prompting;
			await worker.session.waitForIdle();

			// The stop met the first backoff.
			expect(worker.retryStarts.map(event => event.attempt)).toEqual([1]);
			expect(worker.retryEnds).toEqual([expect.objectContaining({ success: false, finalError: "Retry cancelled" })]);
			const sessionFile = worker.session.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file");
			// The process exits normally after the stop.
			await worker.session.dispose();
			wait.mockRestore();

			// The key is readable again; a new process opens the session with `--restore`.
			await ctx.authStorage.credentials.set("anthropic", [oauthLogin("acc-relogin")]);
			mockSchedulerWaitWithClock();
			const reopened = await SessionManager.open(sessionFile);
			expect(hasRestorableTurn(reopened.getBranch())).toBe(false);
			const restarted = await openSession(ctx, { baseDelayMs: 40, sessionManager: reopened });
			await expect(restarted.session.restoreInterruptedTurn()).resolves.toBe(false);
			await restarted.session.waitForIdle();
			expect(restarted.mock.calls).toHaveLength(0);
		});
	}
});

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

function subagentResult(id: string, exitCode: number, error?: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "user",
		task: `${id} task`,
		exitCode,
		output: exitCode === 0 ? "finished after the restart" : "",
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 0,
		requests: 1,
		...(error === undefined ? {} : { error }),
	};
}

/** The parent's sync `task` call to subagent `id`, the failed result it got back at once, and its answer. */
function appendParentTaskTurn(main: SessionManager, id: string): void {
	const callId = `call_${id}`;
	const error = "Retry budget exhausted after 2 retries: No API key for provider: anthropic";
	main.appendMessage({ role: "user", content: `Delegate the ${id} work.`, timestamp: Date.now() });
	main.appendMessage(
		assistant({
			content: [{ type: "toolCall", id: callId, name: "task", arguments: { agent: "worker", task: `${id} task` } }],
			stopReason: "toolUse",
		}),
	);
	const details: TaskToolDetails = {
		projectAgentsDir: null,
		results: [subagentResult(id, 1, error)],
		totalDurationMs: 5,
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "task",
		content: [
			{
				type: "text",
				text: `<task-result id="${id}" agent="worker" status="failed (exit 1)"><output>${error}</output></task-result>`,
			},
		],
		details,
		isError: false,
		timestamp: Date.now(),
	};
	main.appendMessage(result);
	main.appendMessage(assistant({ content: [{ type: "text", text: `${id} could not run.` }] }));
}

/** Subagent `id`'s transcript under `mainFile`: its turn ended because its key could not be resolved, then a normal exit. */
async function writeStrandedSubagent(mainFile: string, cwd: string, id: string): Promise<void> {
	const sub = await SessionManager.open(path.join(mainFile.slice(0, -6), `${id}.jsonl`), undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	sub.appendSessionInit({ systemPrompt: ["sub prompt"], task: `${id} task`, tools: ["read", "yield"] });
	sub.appendMessage({ role: "user", content: `${id} task`, timestamp: Date.now() });
	sub.appendMessage(
		assistant({
			stopReason: "error",
			errorMessage: "Retry budget exhausted after 2 retries: No API key for provider: anthropic",
			credentialUnavailable: true,
		}),
	);
	sub.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
		reason: "dispose",
		kind: "normal",
		recordedAt: new Date().toISOString(),
	});
	await sub.close();
}

describe("omp --restore after the user cleared the parent conversation", () => {
	let manager: AsyncJobManager | undefined;

	afterEach(async () => {
		for (const id of ["Before", "After"]) AgentRegistry.global().unregister(id);
		await manager?.dispose({ timeoutMs: 1000 });
		manager = undefined;
	});

	it("does not relaunch a subagent stranded before the parent's /clear, and relaunches one stranded after it", async () => {
		// If this regresses, `--restore` relaunches a subagent of the conversation the user cleared, and its
		// result arrives in the new conversation as a job the parent never started there.
		const start = Date.parse("2026-11-17T12:00:00.000Z");
		setSystemTime(new Date(start));
		const cwd = root.path();
		const main = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const mainFile = main.getSessionFile();
		if (!mainFile) throw new Error("Expected a persisted session file");
		appendParentTaskTurn(main, "Before");
		await writeStrandedSubagent(mainFile, cwd, "Before");
		// The user clears the parent's conversation, then starts new work in it.
		setSystemTime(new Date(start + 60_000));
		main.appendResetBoundary();
		setSystemTime(new Date(start + 120_000));
		appendParentTaskTurn(main, "After");
		await writeStrandedSubagent(mainFile, cwd, "After");
		main.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, {
			reason: "dispose",
			kind: "normal",
			recordedAt: new Date().toISOString(),
		});
		await main.close();
		setSystemTime();

		manager = new AsyncJobManager({});
		manager.registerDeliverySink(MAIN_AGENT_ID, () => {});
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options =>
			subagentResult(options.id, 0),
		);
		const session = {
			sessionManager: await SessionManager.open(mainFile),
			asyncJobManager: manager,
			settings: Settings.isolated(),
			restoreInterruptedTurn: vi.fn(async () => false),
		} as unknown as AgentSession;

		const outcome = await restoreSession(session);

		expect(outcome.subagents).toEqual(["After"]);
		for (const id of outcome.subagents) await manager.getJob(id)?.promise;
	});
});
