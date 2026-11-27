/**
 * A kept-alive subagent that parks must release its AgentSession while its
 * adoption (and therefore revivability) survives. The lifecycle manager holds
 * the agent's revive state for as long as the agent stays adopted, so anything
 * that state keeps reachable is retained for the life of the process; a state
 * that pins the disposed session, its settings overlay or its peer roster leaks
 * them once per spawned subagent. A revive rebuilds what the state does not keep
 * from the live parent and the transcript.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type ModelSpec,
	registerCustomApi,
} from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { artifactsDirsFromRegistry } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	cfgMnemopiEmbeddingApiKey,
	cfgMnemopiLlmApiKey,
	cfgMnemopiLlmBaseUrl,
} from "@oh-my-pi/pi-coding-agent/mnemopi/settings";
import { cfgSecretsMaskSessionStore } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import { cfgContextPromotionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { __resetDirsFromEnvForTests, isRecord, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const AGENT_ID = "ParkedRelease";
const TASK_AGENT: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
const MOCK_API_SOURCE = "test/parked-subagent-session-release";
// After earlier files warm the session code, JSC's optimizing-JIT worklist can
// keep an object referenced by an in-flight compile reachable for a few seconds
// (observed ~4 s locally, >8 s on loaded CI runners); collection is polled past
// that window. A healthy release returns on the first poll that sees it collected,
// so the deadline only bounds how long a real leak takes to fail.
const COLLECT_DEADLINE_MS = 15_000;

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-release-"));
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
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Kept out of the test body so no strong local binding outlives the capture. */
function weakRefToLiveSession(id: string): WeakRef<AgentSession> {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`subagent ${id} has no live session to observe`);
	return new WeakRef(localSession(session));
}

async function collected(ref: WeakRef<object>, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		Bun.gc(true);
		if (ref.deref() === undefined) return true;
		if (Date.now() > deadline) return false;
		await Bun.sleep(100);
	}
}

/** Makes a settings write in the live session's own overlay, then observes the overlay weakly (outside the test body). */
function writeAndObserveLiveSettings(id: string): WeakRef<Settings> {
	const session = localSession(AgentRegistry.global().get(id)?.session);
	cfgContextPromotionEnabled.set(session, true);
	return new WeakRef(session.settings);
}

/**
 * Observes weakly the peer roster the live session's transcript recorded, and returns the key of the prompt block it
 * records (outside the test body).
 */
function observeRecordedRoster(id: string): { roster: WeakRef<object>; block: string } {
	const entries = localSession(AgentRegistry.global().get(id)?.session).sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "subagent-irc-roster") continue;
		const data: unknown = entry.data;
		if (isRecord(data) && isRecord(data.roster) && typeof data.block === "string") {
			return { roster: new WeakRef(data.roster), block: data.block };
		}
	}
	throw new Error(`subagent ${id} recorded no peer roster`);
}

function registerPeer(id: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		session: null,
		sessionFile: null,
		status: "running",
	});
}

/** The run's own model calls (those offering `yield`; the task label call does not), in order. */
function runCalls(mock: MockModel): MockModel["calls"] {
	return mock.calls.filter(call => (call.context.tools ?? []).some(tool => tool.name === "yield"));
}

/** System prompts of the run's own model calls, in order. */
function runPrompts(mock: MockModel): string[][] {
	return runCalls(mock).map(call => [...(call.context.systemPrompt ?? [])]);
}

function userTexts(context: Context): string[] {
	return context.messages.flatMap(message =>
		message.role !== "user"
			? []
			: [
					typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? part.text : "")).join(""),
				],
	);
}

/** Yields `done`, or, on a later turn whose context still holds the original task, what it recalls of it. */
const recallingHandler: MockHandler = context => {
	if (!(context.tools ?? []).some(tool => tool.name === "yield")) return { content: ["label"] };
	const texts = userTexts(context);
	const data = texts.length > 1 && texts.some(text => text.includes("report done")) ? "recalled report done" : "done";
	return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data } }] };
};

interface KeptAliveRun {
	mock: MockModel;
	modelRegistry: ModelRegistry;
	/** Drops the mock's session-bound recordings. */
	release(): void;
	close(): void;
}

/**
 * Runs `AGENT_ID` to a finished keep-alive state, with `options.context` as its task context, on `options.model`
 * or the first model of `options.provider` when given (the mock still labels the task).
 */
async function runKeptAliveSubagent(
	options: {
		handler?: MockHandler;
		tools?: string[];
		enableIrc?: boolean;
		context?: string;
		/** Settings beside the test's own, by setting path. */
		settings?: Readonly<Record<string, unknown>>;
		/** A model the model registry does not hold, which the subagent runs on. */
		model?: Model<Api>;
		/** A provider the model registry registers (as an extension does), on whose first model the subagent runs. */
		provider?: { name: string; config: ProviderConfigInput };
	} = {},
): Promise<KeptAliveRun> {
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	if (options.model) authStorage.keys.setRuntime(options.model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	if (options.provider) modelRegistry.registerProvider(options.provider.name, options.provider.config);
	const modelOverride = options.model
		? `${options.model.provider}/${options.model.id}`
		: options.provider
			? `${options.provider.name}/${options.provider.config.models?.[0]?.id}`
			: "mock/mock-model";
	const mock = createMockModel({
		handler:
			options.handler ??
			(context =>
				(context.tools ?? []).some(tool => tool.name === "yield")
					? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
					: { content: ["label"] }),
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [...(options.model ? [options.model] : []), mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { ...TASK_AGENT, tools: options.tools ?? ["read"] },
			task: "report done",
			context: options.context,
			index: 0,
			id: AGENT_ID,
			modelOverride,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				// No TTL timer: the test parks explicitly through the same path the timer takes.
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
				...options.settings,
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: options.enableIrc ?? false,
		});
		expect(result.exitCode).toBe(0);
	} catch (error) {
		authStorage.close();
		throw error;
	}
	return {
		mock,
		modelRegistry,
		// Recorded mock calls carry stream options with closures bound to the session.
		release: () => {
			mock.reset();
			availableSpy.mockRestore();
		},
		close: () => authStorage.close(),
	};
}

it("releases a parked keep-alive subagent's session while the agent stays revivable", async () => {
	const run = await runKeptAliveSubagent();
	try {
		const sessionRef = weakRefToLiveSession(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		expect(AgentRegistry.global().get(AGENT_ID)).toMatchObject({ status: "parked", session: null });
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);

		run.release();
		expect(await collected(sessionRef, COLLECT_DEADLINE_MS)).toBe(true);
		// Still adopted after collection: the release did not come from dropping the reviver.
		expect(AgentLifecycleManager.global().has(AGENT_ID)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

it("parks without retaining the run's settings overlay and revives with the settings it wrote", async () => {
	const run = await runKeptAliveSubagent();
	try {
		// A write the subagent made to its own settings during the run.
		const settingsRef = writeAndObserveLiveSettings(AGENT_ID);

		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		// The reviver held the run's whole overlay — merged view, memoized values, listener buckets —
		// for as long as the parked agent stayed adopted.
		expect(await collected(settingsRef, COLLECT_DEADLINE_MS)).toBe(true);

		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
		expect(cfgContextPromotionEnabled.get(revived)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

// If this regresses, a parked subagent woken for a follow-up answers without the conversation it had, or under
// settings other than the ones it wrote: its revival keeps no copy of either and must rebuild both.
it("revives a parked subagent that answers a follow-up from its earlier messages, with the setting it wrote", async () => {
	const run = await runKeptAliveSubagent({ handler: recallingHandler });
	try {
		writeAndObserveLiveSettings(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();

		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
		expect(cfgContextPromotionEnabled.get(revived)).toBe(true);
		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: TASK_AGENT,
			message: "what did you report?",
			storeMaskCwd: path.join(root, "home", "work"),
		});
		expect(followUp.exitCode).toBe(0);
		expect(followUp.output).toContain("recalled report done");
	} finally {
		run.close();
	}
}, 30_000);

// If this regresses, every parked subagent keeps a copy of its peer roster for the rest of the process, or a revived
// one sends a prompt other than the one it parked with and the provider writes its whole conversation to the
// prompt cache again, or the roster its transcript recorded reaches the model as part of the conversation.
it("revives with the peer roster its transcript recorded, keeping no copy of it while parked", async () => {
	registerPeer("EarlyPeer");
	const run = await runKeptAliveSubagent({ tools: ["read", "write"], enableIrc: true });
	try {
		const parkedPrompt = runPrompts(run.mock).at(-1);
		if (!parkedPrompt) throw new Error("Expected the run to call the model");
		expect(parkedPrompt.join("\n")).toContain("EarlyPeer");
		const recorded = observeRecordedRoster(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		expect(await collected(recorded.roster, COLLECT_DEADLINE_MS)).toBe(true);

		registerPeer("LatePeer");
		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: TASK_AGENT,
			message: "anything else?",
			storeMaskCwd: path.join(root, "home", "work"),
		});
		expect(followUp.exitCode).toBe(0);
		expect(runPrompts(run.mock)[0]).toEqual(parkedPrompt);
		const revivedRequest = runCalls(run.mock)[0];
		if (!revivedRequest) throw new Error("Expected the revived subagent to call the model");
		// The roster lives in the system prompt; its transcript entry carries neither its rows nor its data into the
		// messages, which do carry the conversation the transcript holds.
		const revivedMessages = JSON.stringify(revivedRequest.context.messages);
		expect(revivedMessages).toContain("report done");
		expect(revivedMessages).not.toContain("EarlyPeer");
		expect(revivedMessages).not.toContain(recorded.block);
		expect(revivedMessages).not.toContain("subagent-irc-roster");
	} finally {
		run.close();
	}
}, 30_000);

// If this regresses, an API key, token or password a subagent's run set in its settings is written in plain text to
// its transcript file each time it parks, where whoever can read the session directory finds it; or the subagent
// comes back without it and fails the calls that need it.
it("keeps a credential setting a run wrote out of the transcript and revives with it", async () => {
	const run = await runKeptAliveSubagent();
	try {
		const credential = "zq7Xv2Lp9Wk4Rt6Ny3Hb";
		const overrideCredential = "Jm4Tc8Qf1Ys5Dw0Gx6Ke";
		const baseUrl = "https://llm.example.test/v1";
		const live = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
		cfgMnemopiLlmApiKey.set(live, credential);
		cfgMnemopiLlmBaseUrl.set(live, baseUrl);
		cfgMnemopiEmbeddingApiKey.override(live, overrideCredential);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();

		const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile;
		if (!sessionFile) throw new Error(`subagent ${AGENT_ID} names no session file`);
		const stored = await Bun.file(sessionFile).text();
		// The plain setting the run wrote beside the credential is there: the park recorded the run's writes.
		expect(stored).toContain(baseUrl);
		for (const value of [credential, overrideCredential]) {
			for (let start = 0; start + 8 <= value.length; start++) {
				expect(stored).not.toContain(value.slice(start, start + 8));
			}
		}

		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
		expect(cfgMnemopiLlmApiKey.get(revived)).toBe(credential);
		expect(cfgMnemopiLlmBaseUrl.get(revived)).toBe(baseUrl);
		expect(cfgMnemopiEmbeddingApiKey.get(revived)).toBe(overrideCredential);
	} finally {
		run.close();
	}
}, 30_000);

/** Data of the newest custom entry of `customType` in the transcript text `stored`. */
function storedCustomData(stored: string, customType: string): unknown {
	const entry = Bun.JSONL.parse(stored).findLast(
		entry => isRecord(entry) && entry.type === "custom" && entry.customType === customType,
	);
	return isRecord(entry) ? entry.data : undefined;
}

// If this regresses, a value secrets.yml lists that a subagent was given (in its task context, say) is written in plain
// text to its transcript file each time it parks, although the session store is masked; or a subagent parked under
// masking can no longer be woken for a follow-up.
it("masks the stored revive inputs as other custom data and still revives", async () => {
	const secret = "Pv8Wq3Lz6Tn1Kd5Rx9Bm";
	const context = `Deploy with the key ${secret} to staging.`;
	// The project's secrets.yml, read when the subagent's session first writes in its cwd.
	await Bun.write(
		path.join(root, "home", "work", ".omp", "secrets.yml"),
		`- type: plain\n  content: ${secret}\n  friendlyName: ReviveProbe\n`,
	);
	const run = await runKeptAliveSubagent({ context, settings: { [cfgSecretsMaskSessionStore.id]: true } });
	try {
		// Other custom data holding the same text, written by the same session.
		localSession(AgentRegistry.global().get(AGENT_ID)?.session).sessionManager.appendCustomEntry(
			"revive-mask-probe",
			{ context },
		);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();

		const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile;
		if (!sessionFile) throw new Error(`subagent ${AGENT_ID} names no session file`);
		const stored = await Bun.file(sessionFile).text();
		for (let start = 0; start + 8 <= secret.length; start++) {
			expect(stored).not.toContain(secret.slice(start, start + 8));
		}
		const probe = storedCustomData(stored, "revive-mask-probe");
		const revive = storedCustomData(stored, "subagent-revive-state");
		if (!isRecord(probe) || typeof probe.context !== "string") throw new Error("The probe entry was not stored");
		if (!isRecord(revive) || !isRecord(revive.prompt)) throw new Error("No revive inputs were stored");
		expect(probe.context).not.toBe(context);
		expect(revive.prompt.context).toBe(probe.context);

		// Woken for a follow-up, it revives warm from the stored inputs, which come back from the store masked as
		// every other entry does: its prompt shows the masked context, never the value.
		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: TASK_AGENT,
			message: "anything else?",
			storeMaskCwd: path.join(root, "home", "work"),
		});
		expect(followUp.exitCode).toBe(0);
		const revivedPrompt = runPrompts(run.mock)[0]?.join("\n");
		expect(revivedPrompt).toContain(probe.context);
		expect(revivedPrompt).not.toContain(secret);
	} finally {
		run.close();
	}
}, 30_000);

const SECRET_MODEL_API = "test-parked-release-secret-model";

/** A plain model of {@link SECRET_MODEL_API}, as a models.yml provider's, which the model registry does not hold. */
function providerModel(fields: { baseUrl: string; headers?: Record<string, string> }): Model<Api> {
	const model = buildModel({
		id: "secret-model",
		name: "Secret model",
		api: SECRET_MODEL_API,
		provider: "secret-provider",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 4096,
		...fields,
	} as ModelSpec<Api>) as Model<Api>;
	// Plain JSON data, as a models.yml model is: what the transcript can hold whole.
	return JSON.parse(JSON.stringify(model));
}

/** Streams for {@link SECRET_MODEL_API}: yields when offered `yield`, else answers; records each call's model. */
function answeringStream(models: Model<Api>[]): (model: Model<Api>, context: Context) => AssistantMessageEventStream {
	return (model, context) => {
		models.push(model);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			if (!(context.tools ?? []).some(tool => tool.name === "yield")) {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				return;
			}
			const toolCall = {
				type: "toolCall" as const,
				id: `yield-${models.length}`,
				name: "yield",
				arguments: { type: "result", data: "done" },
			};
			const message: AssistantMessage = {
				...createAssistantMessage(""),
				content: [toolCall],
				stopReason: "toolUse",
			};
			stream.push({ type: "start", partial: message });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
		});
		return stream;
	};
}

const FIXTURE_SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A fresh stand-in for a key, made at run time so that no key-shaped text sits in this file. */
function fixtureSecret(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	return Array.from(bytes, byte => FIXTURE_SECRET_ALPHABET[byte % FIXTURE_SECRET_ALPHABET.length]).join("");
}

const headerSecret = fixtureSecret();
const querySecret = fixtureSecret();

for (const { where, secret, fields } of [
	{
		where: "a request header",
		secret: headerSecret,
		fields: { baseUrl: "https://llm.example.test/v1", headers: { "x-fixture-header": headerSecret } },
	},
	{
		where: "its base URL's query",
		secret: querySecret,
		fields: { baseUrl: `https://llm.example.test/v1?q=${querySecret}` },
	},
]) {
	// If this regresses, the API key of a model a provider is configured with (in a request header or in its URL) is
	// written in plain text to a parked subagent's transcript file each time it parks, where whoever can read the
	// session directory finds it; or the subagent comes back on the model without it and its calls fail.
	it(`keeps a model whose key is in ${where} out of the transcript and revives on it`, async () => {
		const models: Model<Api>[] = [];
		registerCustomApi(SECRET_MODEL_API, answeringStream(models), MOCK_API_SOURCE);
		const run = await runKeptAliveSubagent({ model: providerModel(fields) });
		try {
			expect(models.length).toBeGreaterThan(0);
			await AgentLifecycleManager.global().park(AGENT_ID);
			run.release();

			const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile;
			if (!sessionFile) throw new Error(`subagent ${AGENT_ID} names no session file`);
			const stored = await Bun.file(sessionFile).text();
			// The park recorded the run's revive inputs, without the model.
			expect(isRecord(storedCustomData(stored, "subagent-revive-state"))).toBe(true);
			for (let start = 0; start + 8 <= secret.length; start++) {
				expect(stored).not.toContain(secret.slice(start, start + 8));
			}

			models.length = 0;
			const followUp = await runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: TASK_AGENT,
				message: "anything else?",
				storeMaskCwd: path.join(root, "home", "work"),
			});
			expect(followUp.exitCode).toBe(0);
			expect(models.at(-1)).toMatchObject(fields);
		} finally {
			run.close();
		}
	}, 30_000);
}

/**
 * Changes the newest revive inputs of the transcript at `sessionFile`, as a forged or damaged file would: `edit` changes
 * them in place as JSON.parse reads them, and the file then holds them as JSON.stringify writes them. Returns their line
 * as the park wrote it and as it is now.
 */
async function rewriteNewestReviveEntry(
	sessionFile: string,
	edit: (entry: unknown) => void,
): Promise<{ recorded: string; forged: string }> {
	const lines = (await Bun.file(sessionFile).text()).split("\n");
	const index = lines.findLastIndex(line => line.includes('"customType":"subagent-revive-state"'));
	if (index === -1) throw new Error("The park recorded no revive inputs");
	const recorded = lines[index]!;
	const entry: unknown = JSON.parse(recorded);
	edit(entry);
	const forged = JSON.stringify(entry);
	lines[index] = forged;
	await Bun.write(sessionFile, lines.join("\n"));
	return { recorded, forged };
}

/** Sets `modelUndefinedFields` in the newest revive inputs of the transcript at `sessionFile`, as a forged file would. */
async function forgeModelUndefinedFields(sessionFile: string, fieldPaths: string[][]): Promise<void> {
	await rewriteNewestReviveEntry(sessionFile, entry => {
		if (
			!isRecord(entry) ||
			!isRecord(entry.data) ||
			!isRecord(entry.data.options) ||
			!isRecord(entry.data.options.model)
		) {
			throw new Error("The park recorded no revive inputs holding the model");
		}
		entry.data.modelUndefinedFields = fieldPaths;
	});
}

// If this regresses, a session file whose revive inputs name a model field through `__proto__` (forged or damaged)
// adds that field to every object of the process when its subagent is woken for a follow-up, and settings then fail to
// load with `Unknown setting`.
it("revives from revive inputs naming a model field through `__proto__` without changing Object.prototype", async () => {
	const models: Model<Api>[] = [];
	registerCustomApi(SECRET_MODEL_API, answeringStream(models), MOCK_API_SOURCE);
	const run = await runKeptAliveSubagent({ model: providerModel({ baseUrl: "https://llm.example.test/v1" }) });
	try {
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile;
		if (!sessionFile) throw new Error(`subagent ${AGENT_ID} names no session file`);
		await forgeModelUndefinedFields(sessionFile, [["__proto__", "polluted"]]);

		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: TASK_AGENT,
			message: "anything else?",
			storeMaskCwd: path.join(root, "home", "work"),
		});
		expect(followUp.exitCode).toBe(0);
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	} finally {
		Reflect.deleteProperty(Object.prototype, "polluted");
		run.close();
	}
}, 30_000);

/** A `__proto__` key's value, as a forged or damaged transcript holds it. */
const FORGED_PROTO = { polluted: true };

/** The field at `keys` (own fields, from the outermost in) within `value`; `undefined` when there is none. */
function fieldAt(value: unknown, ...keys: string[]): unknown {
	let field = value;
	for (const key of keys) field = isRecord(field) && Object.hasOwn(field, key) ? field[key] : undefined;
	return field;
}

/** What `holder` holds for a `__proto__` key: whether it is its own, its value, and whether its prototype is plain. */
function protoKeyOf(holder: unknown): { own: boolean; value: unknown; plainPrototype: boolean } | undefined {
	if (!isRecord(holder)) return undefined;
	return {
		own: Object.hasOwn(holder, "__proto__"),
		value: Object.getOwnPropertyDescriptor(holder, "__proto__")?.value,
		plainPrototype: Object.getPrototypeOf(holder) === Object.prototype,
	};
}

/** Sets `__proto__` as an own field of `holder`, as JSON.parse does for a line that holds the key. */
function defineProtoKey(holder: unknown, value: object): void {
	if (!isRecord(holder)) throw new Error("The park recorded revive inputs without the record to forge");
	Object.defineProperty(holder, "__proto__", { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Gives the newest revive inputs of the transcript at `sessionFile` an own `__proto__` key in their options, their wake
 * inputs and each layer of their settings writes, as a forged or damaged file would. Returns the inputs as the park
 * wrote them.
 */
async function forgeProtoKeys(
	sessionFile: string,
	values: { options: object; wake: object; global: object; overrides: object },
): Promise<unknown> {
	const { recorded, forged } = await rewriteNewestReviveEntry(sessionFile, entry => {
		defineProtoKey(fieldAt(entry, "data", "options"), values.options);
		defineProtoKey(fieldAt(entry, "data", "wake"), values.wake);
		defineProtoKey(fieldAt(entry, "data", "settingsWrites", "global", "set"), values.global);
		const settingsWrites = fieldAt(entry, "data", "settingsWrites");
		const overrides = {};
		defineProtoKey(overrides, values.overrides);
		if (isRecord(settingsWrites)) settingsWrites.overrides = { set: overrides };
	});
	expect(forged.includes('"__proto__":{"polluted":true}')).toBe(true);
	expect(forged.includes('"overrides":{"set":{"__proto__":{}}}')).toBe(true);
	return fieldAt(JSON.parse(recorded), "data");
}

// If this regresses, a session file whose revive inputs hold a `__proto__` key (forged or damaged) gives the subagent
// woken from it spawn options, wake inputs and settings layers whose prototype is the key's value: they read the fields
// they lack from it, the settings it revives with lose the key, and its next park records those fields and not the key.
it("revives from revive inputs holding a `__proto__` key and keeps the key as data through its next park", async () => {
	const run = await runKeptAliveSubagent();
	try {
		writeAndObserveLiveSettings(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile;
		if (!sessionFile) throw new Error(`subagent ${AGENT_ID} names no session file`);
		// The options' and wake inputs' keys name a field they lack. The empty one equals Object.prototype, which a layer
		// without the key reads there.
		const recorded = await forgeProtoKeys(sessionFile, {
			options: { ...FORGED_PROTO, thinkingLevel: "high" },
			wake: { ...FORGED_PROTO, description: "forged" },
			global: FORGED_PROTO,
			overrides: {},
		});

		const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
		const layers = revived.settings.overlayLayers();
		const revivedWith = {
			contextPromotion: cfgContextPromotionEnabled.get(revived),
			global: protoKeyOf(layers.global),
			overrides: protoKeyOf(layers.overrides),
		};
		// A write of the revived run, so that its park records its inputs again.
		const baseUrl = "https://llm.example.test/v1";
		cfgMnemopiLlmBaseUrl.set(revived, baseUrl);
		await AgentLifecycleManager.global().park(AGENT_ID);
		const parked = storedCustomData(await Bun.file(sessionFile).text(), "subagent-revive-state");

		const kept = { own: true, value: FORGED_PROTO, plainPrototype: true };
		expect({
			revivedWith,
			parked: {
				options: fieldAt(parked, "options"),
				wake: fieldAt(parked, "wake"),
				global: protoKeyOf(fieldAt(parked, "settingsWrites", "global", "set")),
				baseUrl: fieldAt(parked, "settingsWrites", "global", "set", ...cfgMnemopiLlmBaseUrl.segments),
				overrides: protoKeyOf(fieldAt(parked, "settingsWrites", "overrides", "set")),
			},
		}).toEqual({
			revivedWith: { contextPromotion: true, global: kept, overrides: { ...kept, value: {} } },
			parked: {
				options: fieldAt(recorded, "options"),
				wake: fieldAt(recorded, "wake"),
				global: kept,
				baseUrl,
				overrides: { ...kept, value: {} },
			},
		});
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	} finally {
		Reflect.deleteProperty(Object.prototype, "polluted");
		run.close();
	}
}, 30_000);

const REGISTRY_MODEL_API = "test-parked-release-registry-model";
const REGISTRY_PROVIDER = "registry-provider";
const REGISTRY_MODEL_ID = "registry-model";

/** An extension's provider: its model is plain data with `undefined` fields, as a models.yml provider's is. */
const registryProvider: ProviderConfigInput = {
	api: REGISTRY_MODEL_API,
	baseUrl: "https://llm.example.test/v1",
	apiKey: fixtureSecret(),
	models: [
		{
			id: REGISTRY_MODEL_ID,
			name: "Registry model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 4096,
		},
	],
};

/**
 * Observes weakly the model registry's object of the provider's model, and copies its fields (outside the test body,
 * so no strong local binding outlives the capture).
 */
function observeRegistryModel(modelRegistry: ModelRegistry): { model: WeakRef<Model<Api>>; fields: Model<Api> } {
	const model = modelRegistry.find(REGISTRY_PROVIDER, REGISTRY_MODEL_ID);
	if (!model) throw new Error(`The model registry holds no ${REGISTRY_PROVIDER}/${REGISTRY_MODEL_ID}`);
	return { model: new WeakRef(model), fields: structuredClone(model) };
}

/** Whether the model registry now holds another object than `model` for the provider's model. */
function registryReplaced(modelRegistry: ModelRegistry, model: WeakRef<Model<Api>>): boolean {
	const current = modelRegistry.find(REGISTRY_PROVIDER, REGISTRY_MODEL_ID);
	return current !== undefined && current !== model.deref();
}

// If this regresses, every subagent parked on a configured model (an extension's or a models.yml provider's) keeps its
// own copy of that model for the rest of the process once the model registry rebuilds its catalog after the park, as
// it does when its configuration or credentials change; or a revived subagent runs on a model other than the one it
// parked with.
it("keeps no model the registry replaced after the park, and revives on the registry's equal one", async () => {
	const models: Model<Api>[] = [];
	registerCustomApi(REGISTRY_MODEL_API, answeringStream(models), MOCK_API_SOURCE);
	const run = await runKeptAliveSubagent({ provider: { name: REGISTRY_PROVIDER, config: registryProvider } });
	try {
		expect(models.length).toBeGreaterThan(0);
		const parked = observeRegistryModel(run.modelRegistry);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		models.length = 0;

		// A catalog rebuild: the registry replaces its model objects with equal copies.
		await run.modelRegistry.refresh("offline", { refreshCommandCredentials: true });
		expect(registryReplaced(run.modelRegistry, parked.model)).toBe(true);
		expect(await collected(parked.model, COLLECT_DEADLINE_MS)).toBe(true);

		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: TASK_AGENT,
			message: "anything else?",
			storeMaskCwd: path.join(root, "home", "work"),
		});
		expect(followUp.exitCode).toBe(0);
		const revivedModel = models.at(-1);
		expect(revivedModel).toBe(run.modelRegistry.find(REGISTRY_PROVIDER, REGISTRY_MODEL_ID));
		expect(Bun.deepEquals(revivedModel, parked.fields, true)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);

/** Answers `done` (through `yield` when the run offers it), or `label` to the task label call, which offers no tools. */
const doneHandler: MockHandler = context => {
	const tools = context.tools ?? [];
	if (tools.some(tool => tool.name === "yield")) {
		return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
	}
	return { content: [tools.some(tool => tool.name === "read") ? "done" : "label"] };
};

/** A skill the parent session loaded, which each of its spawns passes on. */
function skillNamed(name: string): Skill {
	const baseDir = path.join(root, "skills", name);
	return { name, description: `The ${name} skill`, filePath: path.join(baseDir, "SKILL.md"), baseDir, source: "user" };
}

function namesOf(skills: readonly Skill[]): string[] {
	return skills.map(skill => skill.name);
}

/** The mock model a parent's children run on, and the auth and model registry that resolve it. */
interface ChildModel {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	/** Parent settings that run each child once on the mock model and leave it kept alive until the test parks it. */
	settings: Settings;
	/** Drops the mock's recorded calls: their stream options hold closures bound to the children's sessions. */
	releaseRecordings(): void;
}

function childModel(): ChildModel {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const model = createMockModel({ handler: doneHandler });
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const find = modelRegistry.find.bind(modelRegistry);
	vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) =>
		provider === "mock" && id === model.id ? model : find(provider, id),
	);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(() => [model]);
	vi.spyOn(modelRegistry, "getAll").mockImplementation(() => [model]);
	const selector = `mock/${model.id}`;
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.isolation.enabled": false,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		// Vibe workers select their model by role: `good` ones through `task`, `fast` ones through `smol`.
		modelRoles: { default: selector, task: selector, smol: selector },
	});
	return { authStorage, modelRegistry, settings, releaseRecordings: () => model.reset() };
}

/** A parent session, and the spawns of its kept-alive children. */
interface SkillParent {
	/** Runs child `id` to its finished keep-alive state and returns the names of the skills its live session holds. */
	spawn(id: string): Promise<string[]>;
	releaseRecordings(): void;
	close(): void;
}

/** A parent session whose skills are what `skills` returns when a child spawns. */
async function skillParent(skills: () => readonly Skill[]): Promise<SkillParent> {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const { authStorage, modelRegistry, settings, releaseRecordings } = childModel();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [
			{
				name: "skill-agent",
				description: "Runs with its parent's skills",
				systemPrompt: "test",
				source: "project",
				tools: ["read"],
			},
		],
		projectAgentsDir: null,
	});

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		// The children's transcripts go next to it, under the test's root, where they outlive each run for a revive.
		getSessionFile: () => path.join(root, "parent.jsonl"),
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		get skills() {
			return skills();
		},
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		extensionPaths: [],
		customToolPaths: [],
	};
	return {
		spawn: async id => {
			const { result } = await runStructuredSubagent({
				session,
				invocationKind: "task",
				assignment: "report done",
				agent: "skill-agent",
				structured: false,
				identity: { id },
			});
			expect(result.exitCode, result.error).toBe(0);
			return namesOf(localSession(AgentRegistry.global().get(id)?.session).skills);
		},
		releaseRecordings,
		close: () => authStorage.close(),
	};
}

/** A Vibe parent session with a session file under the test's root, and the spawns of its workers. */
interface VibeParent {
	/** Spawns a `good` worker named `name`, waits for its first turn to settle, and returns the worker's id. */
	spawn(name: string): Promise<string>;
	releaseRecordings(): void;
	/** The `omp-vibe-*` directories made in the temp dir, and the temp dirs still registered as artifact dirs. */
	tempArtifactDirs(): Promise<{ made: string[]; registered: string[] }>;
	close(): Promise<void>;
}

/** A Vibe parent session whose skills are what `skills` returns when a worker spawns. */
async function vibeParent(skills: () => readonly Skill[]): Promise<VibeParent> {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	// A worker spawned without a parent session file gets an `omp-vibe-*` artifact dir in the temp dir, registered for
	// the life of the process. The temp dir is moved under the test's root so that any such dir is seen and removed.
	const tmp = path.join(root, "tmp");
	await fs.mkdir(tmp, { recursive: true });
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	const { authStorage, modelRegistry, settings, releaseRecordings } = childModel();
	// The workers' transcripts and artifacts go next to the parent's session file, under the test's root.
	const sessionManager = SessionManager.create(cwd, path.join(root, "sessions"));
	const asyncJobManager = new AsyncJobManager({ onJobComplete: () => {} });
	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		authStorage,
		modelRegistry,
		asyncJobManager,
		sessionManager,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		taskDepth: 0,
		enableLsp: false,
		get skills() {
			return skills();
		},
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		extensionPaths: [],
		customToolPaths: [],
	};
	return {
		spawn: async name => {
			const { id, jobId } = await VibeSessionRegistry.global().spawn(session, {
				cli: "good",
				name,
				prompt: "report done",
			});
			const job = asyncJobManager.getJob(jobId);
			await job?.promise;
			expect(job?.status, job?.errorText).toBe("completed");
			return id;
		},
		releaseRecordings,
		tempArtifactDirs: async () => ({
			made: (await fs.readdir(tmp)).filter(name => name.startsWith("omp-vibe-")),
			registered: artifactsDirsFromRegistry().filter(dir => dir.startsWith(tmp)),
		}),
		close: async () => {
			await asyncJobManager.dispose({ timeoutMs: 1_000 });
			VibeSessionRegistry.resetGlobalForTests();
			await sessionManager.close();
			authStorage.close();
		},
	};
}

/** Parks kept-alive child `id` and returns what its registry entry still holds. */
async function park(id: string): Promise<{ status: string | undefined; live: boolean }> {
	await AgentLifecycleManager.global().park(id);
	const ref = AgentRegistry.global().get(id);
	return { status: ref?.status, live: ref?.session != null };
}

async function revivedSkillNames(id: string): Promise<string[]> {
	return namesOf(localSession(await AgentLifecycleManager.global().ensureLive(id)).skills);
}

/** Observes weakly the skill list child `id`'s live session holds (outside the test body). */
function weakRefToLiveSkills(id: string): WeakRef<readonly Skill[]> {
	return new WeakRef(localSession(AgentRegistry.global().get(id)?.session).skills);
}

// If this regresses, a child spawned once its parent replaced its skill list (as a skill refresh does) gets the old
// skills, or a parked child comes back with its parent's current skills instead of the ones it was spawned with.
it("spawns a child with its parent's replaced skill list and revives parked siblings with their own", async () => {
	let parentSkills = ["alpha", "beta", "gamma"].map(skillNamed);
	const parent = await skillParent(() => parentSkills);
	try {
		const siblings = [await parent.spawn("ReplacedFirst"), await parent.spawn("ReplacedSecond")];
		const parked = [await park("ReplacedFirst"), await park("ReplacedSecond")];
		parentSkills = ["delta", "epsilon"].map(skillNamed);
		const third = await parent.spawn("ReplacedThird");
		const revived = [await revivedSkillNames("ReplacedFirst"), await revivedSkillNames("ReplacedSecond")];
		expect({ siblings, parked, third, revived }).toEqual({
			siblings: [
				["alpha", "beta", "gamma"],
				["alpha", "beta", "gamma"],
			],
			parked: [
				{ status: "parked", live: false },
				{ status: "parked", live: false },
			],
			third: ["delta", "epsilon"],
			revived: [
				["alpha", "beta", "gamma"],
				["alpha", "beta", "gamma"],
			],
		});
	} finally {
		parent.close();
	}
}, 60_000);

// If this regresses, an SDK caller that edits the array it handed its session (replaces an entry, or empties and
// refills it) still spawns children with the skills it held before the edit, or a parked child comes back with the
// edited skills instead of the ones it was spawned with.
it("spawns a child with its parent's skill list as edited in place and revives a parked child with its own", async () => {
	// The SDK keeps the caller's array as the session's skills.
	const parentSkills = ["alpha", "beta", "gamma"].map(skillNamed);
	const parent = await skillParent(() => parentSkills);
	try {
		const first = await parent.spawn("EditedFirst");
		const parked = await park("EditedFirst");
		parentSkills[1] = skillNamed("zeta");
		const replacedEntry = await parent.spawn("EditedSecond");
		parentSkills.length = 0;
		const emptied = await parent.spawn("EditedThird");
		parentSkills.push(skillNamed("alpha"), skillNamed("eta"), skillNamed("gamma"));
		const refilled = await parent.spawn("EditedFourth");
		const revived = await revivedSkillNames("EditedFirst");
		expect({ first, parked, replacedEntry, emptied, refilled, revived }).toEqual({
			first: ["alpha", "beta", "gamma"],
			parked: { status: "parked", live: false },
			replacedEntry: ["alpha", "zeta", "gamma"],
			emptied: [],
			refilled: ["alpha", "eta", "gamma"],
			revived: ["alpha", "beta", "gamma"],
		});
	} finally {
		parent.close();
	}
}, 60_000);

// If this regresses, a parent that empties its skill list in place keeps its copy of the old list in memory for as long
// as the list lives, even once no child holds that copy.
it("lets the copy of a parent's skill list go once a child spawns from the emptied list", async () => {
	const alpha = skillNamed("alpha");
	const beta = skillNamed("beta");
	const parentSkills = [alpha, beta];
	const parent = await skillParent(() => parentSkills);
	try {
		const first = await parent.spawn("EvictedFirst");
		const copyRef = weakRefToLiveSkills("EvictedFirst");
		// End the only child holding the copy, with its reviver.
		const released = await AgentLifecycleManager.global().release("EvictedFirst");
		parentSkills.length = 0;
		const emptied = await parent.spawn("EvictedSecond");
		parent.releaseRecordings();
		// The parent's list is still live here, so the copy is collected only if nothing keeps it for that list.
		const copyCollected = await collected(copyRef, COLLECT_DEADLINE_MS);
		// Refilled with the same skills, in the same order.
		parentSkills.push(alpha, beta);
		const refilled = await parent.spawn("EvictedThird");
		expect({ first, released, emptied, copyCollected, refilled }).toEqual({
			first: ["alpha", "beta"],
			released: true,
			emptied: [],
			copyCollected: true,
			refilled: ["alpha", "beta"],
		});
	} finally {
		parent.close();
	}
}, 60_000);

/** Skills of the parent in the retention tests: enough that no list in the heap holds as many unless it is a copy. */
const FIXTURE_SKILLS = 128;
/** Children parked before the first census, so the second one sees only what further children add. */
const WARMUP_CHILDREN = 8;
/** Children parked between the two censuses. */
const MEASURED_CHILDREN = 32;
/**
 * Lists a census may count that no parked child keeps: an object let go just before a census can stay reachable for a
 * few seconds (see {@link COLLECT_DEADLINE_MS}). A copy for each child adds {@link MEASURED_CHILDREN} lists.
 */
const TRANSIENT_LISTS = MEASURED_CHILDREN / 4;

function fixtureSkills(): Skill[] {
	return Array.from({ length: FIXTURE_SKILLS }, (_, index) => skillNamed(`skill-${index}`));
}

/**
 * How many lists in the heap hold {@link FIXTURE_SKILLS} skills or more: the parent's own list and each copy of it.
 * `Bun.generateHeapSnapshot()` returns JavaScriptCore's heap snapshot, in JavaScriptCore's own format, not V8's: each
 * node is [id, size, class name index, flags] and each edge is [from id, to id, edge type index, property name index or
 * element index]. It counts lists, not bytes: the snapshot does not size the storage of a frozen array's entries.
 */
function fixtureListCensus(): number {
	Bun.gc(true);
	const { edges, edgeTypes, edgeNames } = Bun.generateHeapSnapshot();
	const property = edgeTypes.indexOf("Property");
	const baseDir = edgeNames.indexOf("baseDir");
	expect([property, baseDir]).not.toContain(-1);
	// A skill is an object with a `baseDir` property.
	const skills = new Set<number>();
	for (let at = 0; at < edges.length; at += 4) {
		if (edges[at + 2] === property && edges[at + 3] === baseDir) skills.add(edges[at]);
	}
	// A plain array holds its entries itself; a frozen one, through the sparse map it points to.
	const skillsHeld = new Map<number, number>();
	for (let at = 0; at < edges.length; at += 4) {
		if (skills.has(edges[at + 1])) skillsHeld.set(edges[at], (skillsHeld.get(edges[at]) ?? 0) + 1);
	}
	let lists = 0;
	for (const held of skillsHeld.values()) if (held >= FIXTURE_SKILLS) lists++;
	return lists;
}

/** Censuses of the lists that hold the fixture's skills, taken as a parent's children park. */
interface ParkedRetention {
	/** After {@link WARMUP_CHILDREN} children parked. */
	before: number;
	/** After {@link MEASURED_CHILDREN} more children parked. */
	after: number;
	/** Census control: after `after`, while the test also holds one plain and one frozen copy of the fixture. */
	withTwoKnownLists: number;
}

/**
 * Spawns children through `spawnChild`, which returns each child's id, and parks each one: its session is disposed
 * (`session: null`) and only its reviver keeps what it needs to come back. Takes a census once
 * {@link WARMUP_CHILDREN} children are parked and again once {@link MEASURED_CHILDREN} more are.
 */
async function parkedChildRetention(
	fixture: readonly Skill[],
	spawnChild: (name: string) => Promise<string>,
	releaseRecordings: () => void,
): Promise<ParkedRetention> {
	let spawned = 0;
	const parkChildren = async (count: number) => {
		const parked: Array<{ status: string | undefined; live: boolean }> = [];
		for (let child = 0; child < count; child++) parked.push(await park(await spawnChild(`Parked${spawned++}`)));
		expect(parked).toEqual(Array.from({ length: count }, () => ({ status: "parked", live: false })));
		releaseRecordings();
	};
	await parkChildren(WARMUP_CHILDREN);
	const before = fixtureListCensus();
	await parkChildren(MEASURED_CHILDREN);
	const after = fixtureListCensus();
	const known = [[...fixture], Object.freeze([...fixture])];
	const withTwoKnownLists = fixtureListCensus();
	// Uses `known` after the census, so that the two lists are live while it runs.
	expect(known).toHaveLength(2);
	return { before, after, withTwoKnownLists };
}

/** Requires that the census saw the lists the test held, and that the measured children added no list each. */
function expectNoListPerChild(retention: ParkedRetention): void {
	const counts = JSON.stringify(retention);
	expect(retention.withTwoKnownLists - retention.after, counts).toBe(2);
	expect(retention.after - retention.before, counts).toBeLessThan(TRANSIENT_LISTS);
}

/** Requires that the census saw the lists the test held, and one more list for each measured child. */
function expectListPerChild(retention: ParkedRetention): void {
	const counts = JSON.stringify(retention);
	expect(retention.withTwoKnownLists - retention.after, counts).toBe(2);
	expect(retention.after - retention.before, counts).toBeGreaterThan(MEASURED_CHILDREN - TRANSIENT_LISTS);
}

// If this regresses, each `task` child a parent spawns on its thread gets a copy of the parent's whole skill list of its
// own, and a parked one keeps it for as long as it can be revived.
it("keeps no copy of its parent's skill list for each parked task child", async () => {
	const fixture = fixtureSkills();
	const parent = await skillParent(() => fixture);
	try {
		const spawnChild = async (id: string) => {
			await parent.spawn(id);
			return id;
		};
		expectNoListPerChild(await parkedChildRetention(fixture, spawnChild, parent.releaseRecordings));
	} finally {
		parent.close();
	}
}, 120_000);

// Control for the case above: if the census missed the copies parked children keep, both cases would pass.
it("counts one skill list for each parked task child given a copy of its own", async () => {
	const fixture = fixtureSkills();
	// A new array on each read, as when each spawn copies the list: each child keeps a copy of its own.
	const parent = await skillParent(() => [...fixture]);
	try {
		const spawnChild = async (id: string) => {
			await parent.spawn(id);
			return id;
		};
		expectListPerChild(await parkedChildRetention(fixture, spawnChild, parent.releaseRecordings));
	} finally {
		parent.close();
	}
}, 120_000);

// If this regresses, each vibe worker a parent spawns on its thread gets a copy of the parent's whole skill list of its
// own, and a parked one keeps it for as long as it can be revived.
it("keeps no copy of its parent's skill list for each parked vibe worker", async () => {
	const fixture = fixtureSkills();
	const parent = await vibeParent(() => fixture);
	try {
		expectNoListPerChild(await parkedChildRetention(fixture, parent.spawn, parent.releaseRecordings));
		expect(await parent.tempArtifactDirs()).toEqual({ made: [], registered: [] });
	} finally {
		await parent.close();
	}
}, 120_000);

// Control for the case above: if the census missed the copies parked workers keep, both cases would pass.
it("counts one skill list for each parked vibe worker given a copy of its own", async () => {
	const fixture = fixtureSkills();
	// A new array on each read, as when each spawn copies the list: each worker keeps a copy of its own.
	const parent = await vibeParent(() => [...fixture]);
	try {
		expectListPerChild(await parkedChildRetention(fixture, parent.spawn, parent.releaseRecordings));
		expect(await parent.tempArtifactDirs()).toEqual({ made: [], registered: [] });
	} finally {
		await parent.close();
	}
}, 120_000);
