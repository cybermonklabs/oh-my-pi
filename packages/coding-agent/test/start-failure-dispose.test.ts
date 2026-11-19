/**
 * A session whose start fails ends while the process goes on: an SDK `createAgentSession` that
 * fails after its session exists, and an ACP `session/new` that fails after its session is
 * created, each stop the jobs that session already runs rather than cut them off, as the server's
 * exit would.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { turnAbortKind } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const model = buildModel({
	id: "start-failure-dispose",
	name: "Start failure dispose",
	api: "test-start-failure-dispose",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;
authStorage.keys.setRuntime(model.provider, "test-key");

afterEach(() => vi.restoreAllMocks());
afterAll(() => authStorage.close());

/** A background job of `session` (a `task` subagent, an eval `agent()` handle) that runs until it is aborted. */
function startOwnJob(session: AgentSession): Promise<unknown> {
	const manager = session.asyncJobManager;
	const ownerId = session.getAgentId();
	if (!manager || !ownerId) throw new Error("Expected a session with its own job manager and agent id");
	const abortReason = Promise.withResolvers<unknown>();
	manager.register(
		"task",
		"background work",
		({ signal }) => {
			const ended = Promise.withResolvers<string>();
			signal.addEventListener(
				"abort",
				() => {
					abortReason.resolve(signal.reason);
					ended.resolve("ended");
				},
				{ once: true },
			);
			return ended.promise;
		},
		{ ownerId },
	);
	return abortReason.promise;
}

describe("a session whose start fails", () => {
	it("stops the jobs it already runs when the SDK start fails after the session exists", async () => {
		// If this regresses, a failed `createAgentSession` (a host that goes on serving others) ends its session's
		// running jobs with the job manager's shutdown reason, as the process exit does: the task executor records a
		// process exit for the jobs' subagents that did not happen, and `omp --restore` relaunches their turns.
		using dir = TempDir.createSync("@pi-sdk-start-failure-");
		let jobAbort: Promise<unknown> | undefined;
		let started: AgentSession | undefined;
		vi.spyOn(AgentSession.prototype, "beginInitialAdvisorCostRestore").mockImplementationOnce(
			function (this: AgentSession) {
				started = this;
				jobAbort = startOwnJob(this);
				throw new Error("start failed after the session existed");
			},
		);

		await expect(
			createAgentSession({
				cwd: dir.path(),
				agentDir: dir.join("agent"),
				model,
				modelRegistry,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			}),
		).rejects.toThrow("start failed after the session existed");

		expect(started?.isDisposed).toBe(true);
		const reason = await jobAbort;
		// `turnAbortKind` reads the shutdown symbol as a stop too, so the reason must not be the shutdown's.
		expect(reason).not.toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		expect(turnAbortKind(reason)).toBe("stop");
	});

	it("stops the jobs it already runs when an ACP session/new fails after its session is created", async () => {
		// If this regresses, a `session/new` whose transcript cannot be written ends the new session's running jobs with
		// the shutdown reason while the server goes on serving its other sessions, so their subagents are relaunched by
		// `omp --restore` as if the server had exited.
		using dir = TempDir.createSync("@pi-acp-open-failure-");
		const launchSettings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.join("agent") });
		const factory = createAcpSessionFactory({
			baseOptions: {
				agentDir: dir.join("agent"),
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableLsp: false,
				skipPythonPreflight: true,
			},
			settings: launchSettings,
			sessionDir: dir.join("sessions"),
			authStorage,
			modelRegistry,
			parsedArgs: { invalidFlagValues: [] },
			rawArgs: [],
			createSession: createAgentSession,
		});
		let created: AgentSession | undefined;
		let jobAbort: Promise<unknown> | undefined;
		const connection = {
			sessionUpdate: async () => {},
			extNotification: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async (cwd, options) => {
			const result = await factory(cwd, options);
			created = result.session;
			jobAbort = startOwnJob(result.session);
			vi.spyOn(result.session.sessionManager, "ensureOnDisk").mockRejectedValueOnce(new Error("disk full"));
			return result;
		});
		try {
			await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
			await expect(acp.newSession({ cwd: dir.path(), mcpServers: [] })).rejects.toThrow("disk full");

			expect(created?.isDisposed).toBe(true);
			const reason = await jobAbort;
			expect(reason).not.toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
			expect(turnAbortKind(reason)).toBe("stop");
		} finally {
			await acp.dispose();
			launchSettings.cancelPendingSaves();
			AgentStorage.close();
		}
	});
});
