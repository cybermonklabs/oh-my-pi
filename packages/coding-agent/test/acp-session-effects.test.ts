import { afterAll, describe, expect, it } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { redactSensitiveCredentials } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionDisposeOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { turnAbortKind } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const GITHUB_TOKEN = "ghp_AbCd1234EfGh5678IjKl9012MnOp3456QrSt";
const API = "test-acp-session-redaction";
const model = buildModel({
	id: "acp-session-redaction",
	name: "ACP session redaction",
	api: API,
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;
authStorage.keys.setRuntime(model.provider, "test-key");

afterAll(() => {
	clearCustomApis();
	authStorage.close();
});

/**
 * `omp acp`'s session factory over the isolated launch settings of `dir`, which is also the
 * agent and session directory, and the cleanup its persisted settings and agent storage need.
 */
async function isolatedAcpFactory(dir: TempDir) {
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
	const cleanup = () => {
		launchSettings.cancelPendingSaves();
		// The persisted instance opened agent storage under the temp dir removed below.
		AgentStorage.close();
	};
	return { launchSettings, factory, cleanup };
}

// An ACP client keeps several `session/new` sessions alive at once, each possibly for a
// different workspace. Each session's outbound requests must be credential-redacted per its
// own project's `secrets.enabled`, whichever session currently holds process-wide effects.
describe("concurrent ACP sessions", () => {
	it("redact each session's requests per its own project's secrets.enabled", async () => {
		using launchDir = TempDir.createSync("@pi-acp-effects-launch-");
		using projectDir = TempDir.createSync("@pi-acp-effects-project-");
		await Bun.write(projectDir.join(".omp/config.yml"), "secrets:\n  enabled: true\n");
		// What the provider's credential-redaction pass does to a token in each request it builds.
		const requests: Array<{ context: string; credential: string }> = [];
		registerCustomApi(API, (_model, context) => {
			requests.push({
				context: JSON.stringify(context.messages),
				credential: redactSensitiveCredentials(GITHUB_TOKEN),
			});
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const credentialSentBy = (marker: string) =>
			requests.find(request => request.context.includes(marker))?.credential;
		const { launchSettings, factory, cleanup } = await isolatedAcpFactory(launchDir);
		// `omp acp` binds its launch settings the way `Settings.init` does.
		const releaseLaunch = bindEffects(launchSettings);
		const sessions: AgentSession[] = [];
		try {
			const redacting = (await factory(projectDir.path())).session;
			sessions.push(redacting);
			const plain = (await factory(launchDir.path())).session;
			sessions.push(plain);

			// The launch-cwd session opened last and holds process-wide effects…
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
			// …yet the project session's requests stay redacted, and its own stay as configured.
			await redacting.sendUserMessage("from the secrets project");
			await plain.sendUserMessage("from the launch cwd");
			expect(credentialSentBy("from the secrets project")).toBe("[github_token_redacted]");
			expect(credentialSentBy("from the launch cwd")).toBe(GITHUB_TOKEN);

			// Process-wide effects follow the remaining session's project, then the launch settings.
			await plain.dispose();
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe("[github_token_redacted]");
			await redacting.dispose();
			expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
		} finally {
			for (const session of sessions.reverse()) {
				if (!session.isDisposed) await session.dispose();
			}
			releaseLaunch();
			cleanup();
		}
	});
});

describe("an ACP session the factory rejects", () => {
	it("stops its jobs, since the server goes on serving its other sessions", async () => {
		// If this regresses, a rejected `session/new` (a bad flag value, an unknown tool) cuts off the jobs of the idle
		// subagents its lifecycle teardown releases, as the server's exit does: their subagents record a process exit
		// that did not happen, and `omp --restore` relaunches their turns.
		using dir = TempDir.createSync("@pi-acp-session-rejected-");
		const settings = Settings.isolated();
		const disposals: Array<AgentSessionDisposeOptions | undefined> = [];
		const rejectedSession = {
			extensionRunner: undefined,
			model: undefined,
			getAllToolNames: () => ["read"],
			dispose: async (options?: AgentSessionDisposeOptions) => {
				disposals.push(options);
			},
		};
		const factoryFor = (parsedArgs: { invalidFlagValues: string[]; tools?: string[] }) =>
			createAcpSessionFactory({
				baseOptions: {},
				settings,
				sessionDir: dir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs,
				rawArgs: [],
				createSession: async () => ({ session: rejectedSession }) as unknown as CreateAgentSessionResult,
			});

		await expect(factoryFor({ invalidFlagValues: ["--bad needs a value"] })(dir.path())).rejects.toThrow(
			"--bad needs a value",
		);
		await expect(factoryFor({ invalidFlagValues: [], tools: ["no-such-tool"] })(dir.path())).rejects.toThrow(
			"no-such-tool",
		);
		expect(disposals).toEqual([{ ownedJobsEnd: "stop" }, { ownedJobsEnd: "stop" }]);
	});
});

describe("an ACP session/close", () => {
	it("stops a job the closed session still runs, since the server goes on serving its other sessions", async () => {
		// If this regresses, `session/close` aborts the session's running jobs with the job manager's shutdown reason, as
		// the server's exit does: the task executor reads it as a process exit, records one for the job's subagent that
		// did not happen, and `omp --restore` relaunches its turn.
		using dir = TempDir.createSync("@pi-acp-session-close-");
		const { factory, cleanup } = await isolatedAcpFactory(dir);
		const sessions: AgentSession[] = [];
		const connection = {
			sessionUpdate: async () => {},
			extNotification: async () => {},
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async (cwd, options) => {
			const created = await factory(cwd, options);
			sessions.push(created.session);
			return created;
		});
		try {
			await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const { sessionId } = await acp.newSession({ cwd: dir.path(), mcpServers: [] });
			const session = sessions[0];
			const manager = session?.asyncJobManager;
			const ownerId = session?.getAgentId();
			if (!session || !manager || !ownerId) throw new Error("Expected a live ACP session with its own job manager");
			// A background job of the session (its `task` subagent, an eval `agent()` handle) still running at the close.
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

			await acp.closeSession({ sessionId });

			expect(session.isDisposed).toBe(true);
			// `turnAbortKind` reads the shutdown symbol as a stop too, so the reason must not be the shutdown's.
			const reason = await abortReason.promise;
			expect(reason).not.toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
			expect(turnAbortKind(reason)).toBe("stop");
		} finally {
			await acp.dispose();
			cleanup();
		}
	});
});
