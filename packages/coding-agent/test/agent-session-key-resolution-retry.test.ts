/**
 * A provider key that cannot be resolved for a moment, on the production key
 * path: a real `AgentSession` whose requests resolve keys through
 * `ModelRegistry.turnResolver()` over a real credential store (an auth broker's
 * SQLite store behind its HTTP client, or a local SQLite store), with a
 * scripted provider stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Message, streamSimple, type ToolResultMessage } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, type MockCall, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const MOCK_API_SOURCE = "agent-session-key-resolution-retry-test";
const PROVIDER_SESSION_ID = "key-resolution-retry-session";
const BASE_DELAY_MS = 40;
const FINAL_ANSWER = "finished after the broker answered again";
const BROKER_TOKEN = "key-resolution-retry-broker-bearer";
/** Lifetime of the login's access token; the probe tool outlasts it. */
const ACCESS_TOKEN_LIFETIME_MS = 2 * 60_000;
/** Key lookups of the turn that fail while the broker is down; the next one reaches it. */
const BROKER_DOWN_LOOKUPS = 2;
const LOGIN_DISABLED_CAUSE = 'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}';
const WORKER_NAME = "KeyedWorker";
const NOTES_FILE = "notes.txt";
const WORKER: AgentDefinition = {
	name: "keyed-worker",
	description: "Reads the file it is given",
	systemPrompt: "Read the file you are given and report what it says.",
	tools: ["read"],
	model: ["anthropic/mock-claude"],
	source: "bundled",
};

const probeSchema = type({ value: "string" });

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
/** Disposals of the running test, run newest first by `afterEach`. */
let cleanups: Array<() => unknown> = [];

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
	root = TempDir.createSync("@pi-key-resolution-retry-");
	// Under the isolated HOME, so a subagent's project discovery stops at os.homedir().
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
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	// Subagent sessions opened agent.db and models.db under the isolated HOME.
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
	if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
});

function oauthLogin(account: string, expires = Date.now() + 3_600_000) {
	return {
		type: "oauth" as const,
		access: `access-${account}`,
		refresh: `refresh-${account}`,
		expires,
		accountId: account,
		email: `${account}@example.com`,
	};
}

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") throw new Error("Expected a trailing assistant message");
	return message;
}

/** An origin that refuses connections, as a broker host whose broker process is down does. */
async function refusedOrigin(): Promise<string> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 204 }) });
	const origin = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	return origin;
}

/** What a failed refresh records: every anthropic login of the store is disabled. */
async function disableLoginsAfterFailedRefresh(authStorage: AuthStorage): Promise<void> {
	for (const account of authStorage.oauth.accounts("anthropic")) {
		await authStorage.credentials.disable(account.credentialId, LOGIN_DISABLED_CAUSE);
	}
}

/** The text of the first `toolName` result among `messages`, if any. */
function toolResultText(messages: readonly Message[], toolName: string): string | undefined {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
	return result?.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/** The details of the parent's first `task` result. */
function taskDetails(messages: readonly AgentMessage[]): TaskToolDetails | undefined {
	const result = messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "task",
	);
	return result?.details as TaskToolDetails | undefined;
}

/** Requests that offered `toolName`: the turns of a session, not its label or title requests. */
function turnsOffering(model: MockModel, toolName: string): MockCall[] {
	return model.calls.filter(call => (call.context.tools ?? []).some(tool => tool.name === toolName));
}

/**
 * A parent session on the production SDK path whose model spawns `WORKER` as a
 * task subagent and, when `async`, waits for it. The worker's model is on
 * anthropic, keyed by the store's only OAuth login; once its first request has
 * gone out, a failed refresh disables that login, so no later key lookup of
 * the worker resolves. Settings give the worker a retry budget of two.
 */
async function openParentWithKeyedWorker(options: { async: boolean }) {
	const cwd = root.join("home", "work");
	await Bun.write(path.join(cwd, NOTES_FILE), "the notes\n");
	const authStorage = await AuthStorage.create(root.join("testauth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("mock", "test-key");
	await authStorage.credentials.set("anthropic", [oauthLogin("acc-live")]);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));

	const parentWaiting = Promise.withResolvers<void>();
	const parentModel = createMockModel({
		id: "parent-model",
		handler: context => {
			if (!(context.tools ?? []).some(tool => tool.name === "task")) return { content: ["label"] };
			const answered = context.messages.flatMap(message =>
				message.role === "toolResult" ? [message.toolName] : [],
			);
			if (!answered.includes("task")) {
				return {
					content: [
						{
							type: "toolCall",
							id: "call_task",
							name: "task",
							arguments: { agent: WORKER.name, name: WORKER_NAME, task: `Read ${NOTES_FILE} and report it.` },
						},
					],
					stopReason: "toolUse",
				};
			}
			if (options.async && !answered.includes("wait")) {
				parentWaiting.resolve();
				return {
					content: [{ type: "toolCall", id: "call_wait", name: "wait", arguments: {} }],
					stopReason: "toolUse",
				};
			}
			return { content: ["The worker could not read the notes."], stopReason: "stop" };
		},
	});
	// Run as a job, the worker starts its turn once the parent waits on it.
	const workerMayStart = options.async ? parentWaiting.promise : Promise.resolve();
	const workerModel = createMockModel({
		provider: "anthropic",
		id: "mock-claude",
		handler: async context => {
			if (!(context.tools ?? []).some(tool => tool.name === "read")) return { content: ["label"] };
			if (!context.messages.some(message => message.role === "toolResult")) {
				await workerMayStart;
				await disableLoginsAfterFailedRefresh(authStorage);
				return {
					content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: NOTES_FILE } }],
					stopReason: "toolUse",
				};
			}
			return (context.tools ?? []).some(tool => tool.name === "yield")
				? {
						content: [
							{
								type: "toolCall",
								id: "call_yield",
								name: "yield",
								arguments: { type: "result", data: "the notes" },
							},
						],
					}
				: { content: ["the notes"] };
		},
	});
	// Only the scripted models are available, so no label or title request leaves the process.
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [parentModel, workerModel]);
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [WORKER], projectAgentsDir: null });

	const { session } = await createAgentSession({
		cwd,
		agentDir: path.join(root.join("home"), ".omp", "agent"),
		authStorage,
		modelRegistry,
		model: parentModel,
		sessionManager: SessionManager.create(cwd, root.join("sessions")),
		settings: Settings.isolated({
			"async.enabled": options.async,
			"task.batch": false,
			"task.enableLsp": false,
			"task.completionProbe": false,
			"compaction.enabled": false,
			"retry.maxRetries": 2,
			"retry.baseDelayMs": BASE_DELAY_MS,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"autolearn.enabled": false,
		}),
		toolNames: options.async ? ["task", "wait"] : ["task"],
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
	cleanups.push(async () => {
		await Promise.allSettled(session.asyncJobManager?.getAllJobs().map(job => job.promise) ?? []);
		await session.dispose();
	});
	return { parent: session, parentModel, workerModel };
}

describe("AgentSession: a provider key that cannot be resolved for a moment", () => {
	it("row 5: retries a turn whose auth broker cannot be reached while a tool runs, and finishes once it answers", async () => {
		// The wall clock follows the virtual backoff clock, plus the time the probe tool takes.
		const wallStart = Date.now();
		const monotonicStart = performance.now();
		let toolTimeMs = 0;
		vi.spyOn(Date, "now").mockImplementation(() =>
			Math.floor(wallStart + performance.now() - monotonicStart + toolTimeMs),
		);
		mockSchedulerWaitWithClock();

		// The broker: its own SQLite store holds the login; it mints a fresh access token on refresh.
		const brokerStorage = await AuthStorage.create(root.join("broker.db"), {
			usageProviderResolver: () => undefined,
			refreshOAuthCredential: async () => ({
				access: "access-from-broker",
				refresh: "refresh-from-broker",
				expires: Date.now() + 3_600_000,
			}),
		});
		cleanups.push(() => brokerStorage.close());
		await brokerStorage.credentials.set("anthropic", [oauthLogin("acc-live", Date.now() + ACCESS_TOKEN_LIFETIME_MS)]);
		const broker = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [BROKER_TOKEN],
			disableRefresher: true,
		});
		cleanups.push(() => broker.close());

		// The session's store mirrors the broker over HTTP. While the broker is down,
		// every request to it meets a refused connection.
		const downOrigin = await refusedOrigin();
		let brokerDown = false;
		let refusedRefreshes = 0;
		let refreshesAfterOutage = 0;
		const brokerFetch: typeof fetch = Object.assign(
			(input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const refresh = url.includes("/refresh");
				if (!brokerDown) {
					if (refresh && refusedRefreshes > 0) refreshesAfterOutage++;
					return fetch(input, init);
				}
				if (refresh) refusedRefreshes++;
				return fetch(url.replace(broker.url, downOrigin), init);
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: broker.url, token: BROKER_TOKEN, fetchImpl: brokerFetch });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("Expected the broker's snapshot");
		const remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
		});
		const authStorage = new AuthStorage(remote, { usageProviderResolver: () => undefined });
		cleanups.push(() => {
			authStorage.close();
			remote.close();
		});
		await authStorage.credentials.reload();
		const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
		const probeRuns: string[] = [];
		const probe: AgentTool<typeof probeSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute(_toolCallId, params) {
				probeRuns.push(params.value);
				// The tool outlasts the access token, and the broker goes down meanwhile.
				toolTimeMs += ACCESS_TOKEN_LIFETIME_MS;
				brokerDown = true;
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
		let failedLookups = 0;
		const agent = new Agent({
			getApiKey: async requestModel => {
				if (brokerDown) {
					if (failedLookups === BROKER_DOWN_LOOKUPS) brokerDown = false;
					else failedLookups++;
				}
				return modelRegistry.turnResolver(requestModel, PROVIDER_SESSION_ID);
			},
			sessionId: PROVIDER_SESSION_ID,
			initialState: { model, systemPrompt: ["Test"], tools: [probe as AgentTool], messages: [] },
			streamFn: (_requestModel, context, streamOptions) => streamSimple(mock.model, context, streamOptions),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": BASE_DELAY_MS,
			"retry.maxRetries": 5,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			providerSessionId: PROVIDER_SESSION_ID,
		});
		cleanups.push(() => session.dispose());
		const retryStarts: AutoRetryStartEvent[] = [];
		const retryEnds: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStarts.push(event);
			if (event.type === "auto_retry_end") retryEnds.push(event);
		});

		await session.prompt("run the probe");
		await session.waitForIdle();

		const last = lastAssistant(session);
		// One report: how the turn ended, its retries, and whether its key lookups met
		// the refused broker and asked it again once it was back.
		expect({
			stopReason: last.stopReason,
			errorMessage: last.errorMessage,
			retryAttempts: retryStarts.map(event => event.attempt),
			lookupsMetRefusedBroker: refusedRefreshes > 0,
			lookupsAskedBrokerAgain: refreshesAfterOutage > 0,
		}).toEqual({
			stopReason: "stop",
			errorMessage: undefined,
			// Two failed lookups, two backoff retries, then the broker answered.
			retryAttempts: [1, 2],
			lookupsMetRefusedBroker: true,
			lookupsAskedBrokerAgain: true,
		});
		expect(last.content).toContainEqual({ type: "text", text: FINAL_ANSWER });
		expect(retryEnds).toEqual([expect.objectContaining({ success: true, attempt: 2 })]);
		// One request after the tool, with the token the broker minted; the tool did not run again.
		expect(mock.calls).toHaveLength(2);
		expect(mock.calls[1]?.options?.apiKey).toBe("access-from-broker");
		expect(probeRuns).toEqual(["x"]);
	}, 30_000);

	it("row 6: a sync task subagent whose key cannot be resolved returns its failed result to the parent at once", async () => {
		const { parent, parentModel, workerModel } = await openParentWithKeyedWorker({ async: false });

		await parent.prompt("Delegate reading the notes.");
		await parent.waitForIdle();

		// The worker's first request went out; after its login went away, none did.
		expect(turnsOffering(workerModel, "read")).toHaveLength(1);
		const worker = taskDetails(parent.agent.state.messages)?.results[0];
		expect(worker?.exitCode).toBe(1);
		expect(worker?.error).toContain("No API key for provider: anthropic");
		// The parent's next request carries the failed result.
		const next = parentModel.calls.find(call => toolResultText(call.context.messages, "task") !== undefined);
		const carried = next ? toolResultText(next.context.messages, "task") : undefined;
		expect(carried).toContain('status="failed (exit 1)"');
		expect(carried).toContain("No API key for provider: anthropic");
	}, 30_000);

	it("row 7: an async task subagent whose key cannot be resolved hands its failed result to the parent's wait at once", async () => {
		const { parent, parentModel, workerModel } = await openParentWithKeyedWorker({ async: true });

		await parent.prompt("Delegate reading the notes, then wait for the result.");
		await parent.waitForIdle();

		expect(turnsOffering(workerModel, "read")).toHaveLength(1);
		// The parent's request after its wait carries the failed job's result.
		const next = parentModel.calls.find(call => toolResultText(call.context.messages, "wait") !== undefined);
		const waited = next ? toolResultText(next.context.messages, "wait") : undefined;
		expect(waited).toMatch(/\[task\] — failed/);
		expect(waited).toContain('status="failed (exit 1)"');
		expect(waited).toContain("No API key for provider: anthropic");
		// The wait ended on the job, not on its window.
		expect(waited).not.toContain("No job finished");
	}, 30_000);
});
