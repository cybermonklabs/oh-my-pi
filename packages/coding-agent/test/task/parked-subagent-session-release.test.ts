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
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { __resetDirsFromEnvForTests, isRecord, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";
import { COLLECT_DEADLINE_MS, collected } from "../helpers/gc";

const AGENT_ID = "ParkedRelease";
const TASK_AGENT: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
const MOCK_API_SOURCE = "test/parked-subagent-session-release";
/**
 * Set only in the process {@link checkReleaseInItsOwnProcess} starts, as `<what>:<reference>`: which release its probe
 * row checks (`roster`: the peer roster the transcript recorded; `settings`: the run's settings overlay), and which
 * reference the row keeps to it (`dropped`: none; `held`: one of its own, the control).
 */
const RELEASE_PROBE = process.env.OMP_TEST_PARKED_RELEASE_PROBE;
/** The probe rows' own references, with `held`. */
const heldByProbe: object[] = [];

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

/**
 * Runs this file's probe row for `what` in a process of its own with concurrent JIT compilation off, and checks that
 * the row ran and passed. In a process whose earlier test files warmed the subagent code, an optimizing-JIT compile
 * plan on a background thread can keep the parked subagent's roster, or its settings overlay through the extension
 * runner that holds it, reachable past any deadline the check sets. So a collection there says nothing about what the
 * parked state holds: in whole `bun test` runs each check failed or passed with the set of test files before it.
 */
async function checkReleaseInItsOwnProcess(what: "roster" | "settings", reference: "dropped" | "held"): Promise<void> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	// The probe's own beforeEach makes its own home; it starts from the environment this file's beforeEach replaced.
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	env.BUN_JSC_useConcurrentJIT = "0";
	env.OMP_TEST_PARKED_RELEASE_PROBE = `${what}:${reference}`;
	const child = Bun.spawn(
		[process.execPath, "test", import.meta.path, "--test-name-pattern", `parked ${what} probe`],
		{
			cwd: path.join(import.meta.dir, "../.."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const output = `${stdout}\n${stderr}`;
	expect(exitCode, output).toBe(0);
	// Exactly the probe row ran, and passed: a pattern that matched no row would exit 0 too.
	expect(output).toMatch(/^\s*1 pass$/m);
	expect(output).toMatch(/^\s*0 fail$/m);
}

/** A WeakRef target read in a job stays alive until that job ends: collect from fresh event-loop turns. */
async function collectFromFreshTurns(): Promise<void> {
	for (let pass = 0; pass < 3; pass++) {
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		Bun.gc(true);
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
	/** The settings the run spawned under, as its parent session's. */
	settings: Settings;
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
	const settings = Settings.isolated({
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
	});

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
			settings,
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
		settings,
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

it("parks and revives with the settings it wrote", async () => {
	const run = await runKeptAliveSubagent();
	try {
		// A write the subagent made to its own settings during the run.
		writeAndObserveLiveSettings(AGENT_ID);

		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();

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

// If this regresses, a revived subagent sends a prompt other than the one it parked with and the provider writes its
// whole conversation to the prompt cache again, or the roster its transcript recorded reaches the model as part of the
// conversation.
it("revives with the peer roster its transcript recorded", async () => {
	registerPeer("EarlyPeer");
	const run = await runKeptAliveSubagent({ tools: ["read", "write"], enableIrc: true });
	try {
		const parkedPrompt = runPrompts(run.mock).at(-1);
		if (!parkedPrompt) throw new Error("Expected the run to call the model");
		expect(parkedPrompt.join("\n")).toContain("EarlyPeer");
		const recorded = observeRecordedRoster(AGENT_ID);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();

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

// If this regresses, every parked subagent keeps a copy of its peer roster for the rest of the process.
it.skipIf(RELEASE_PROBE !== undefined)(
	"keeps no copy of the peer roster its transcript recorded while parked",
	async () => {
		await checkReleaseInItsOwnProcess("roster", "dropped");
	},
	60_000,
);

it.skipIf(RELEASE_PROBE !== undefined)(
	"finds a recorded roster alive while something else still holds it (control)",
	async () => {
		await checkReleaseInItsOwnProcess("roster", "held");
	},
	60_000,
);

// Runs only in the process checkReleaseInItsOwnProcess starts. With `held`, the row keeps the roster itself and must
// find it alive, so a check that cannot see a reference fails.
it.skipIf(!RELEASE_PROBE?.startsWith("roster:"))(
	"parked roster probe",
	async () => {
		registerPeer("EarlyPeer");
		const run = await runKeptAliveSubagent({ tools: ["read", "write"], enableIrc: true });
		try {
			const recorded = observeRecordedRoster(AGENT_ID);
			if (RELEASE_PROBE === "roster:held") heldByProbe.push(recorded.roster.deref() ?? {});
			await AgentLifecycleManager.global().park(AGENT_ID);
			run.release();
			await collectFromFreshTurns();
			expect(recorded.roster.deref() === undefined).toBe(RELEASE_PROBE === "roster:dropped");
		} finally {
			run.close();
		}
	},
	30_000,
);

// If this regresses, every parked subagent keeps its run's whole settings overlay (merged view, memoized values,
// listener buckets) for as long as it stays adopted.
it.skipIf(RELEASE_PROBE !== undefined)(
	"keeps no copy of the run's settings overlay while parked",
	async () => {
		await checkReleaseInItsOwnProcess("settings", "dropped");
	},
	60_000,
);

it.skipIf(RELEASE_PROBE !== undefined)(
	"finds a run's settings overlay alive while something else still holds it (control)",
	async () => {
		await checkReleaseInItsOwnProcess("settings", "held");
	},
	60_000,
);

// Runs only in the process checkReleaseInItsOwnProcess starts. With `held`, the row keeps the overlay itself and must
// find it alive, so a check that cannot see a reference fails.
it.skipIf(!RELEASE_PROBE?.startsWith("settings:"))(
	"parked settings probe",
	async () => {
		const run = await runKeptAliveSubagent();
		try {
			const settingsRef = writeAndObserveLiveSettings(AGENT_ID);
			if (RELEASE_PROBE === "settings:held") heldByProbe.push(settingsRef.deref() ?? {});
			await AgentLifecycleManager.global().park(AGENT_ID);
			run.release();
			await collectFromFreshTurns();
			expect(settingsRef.deref() === undefined).toBe(RELEASE_PROBE === "settings:dropped");
		} finally {
			run.close();
		}
	},
	30_000,
);

/** Data of the newest custom entry of `customType` in the transcript text `stored`. */
function storedCustomData(stored: string, customType: string): unknown {
	const entry = Bun.JSONL.parse(stored).findLast(
		entry => isRecord(entry) && entry.type === "custom" && entry.customType === customType,
	);
	return isRecord(entry) ? entry.data : undefined;
}

/** The spawn spec of the newest `session_init` in the transcript text `stored`. */
function storedSpawnSpec(stored: string): Record<string, unknown> | undefined {
	const entry = Bun.JSONL.parse(stored).findLast(entry => isRecord(entry) && entry.type === "session_init");
	const spec = isRecord(entry) ? entry.spawnSpec : undefined;
	return isRecord(spec) ? spec : undefined;
}

/** The overlay layers the spawn spec in `stored` holds, which a revive rebuilds the subagent's settings from. */
function storedSpecLayers(stored: string): { global: Record<string, unknown>; overrides: Record<string, unknown> } {
	const settings = storedSpawnSpec(stored)?.settings;
	const layers = isRecord(settings) ? settings.layers : undefined;
	if (!isRecord(layers) || !isRecord(layers.global) || !isRecord(layers.overrides)) {
		throw new Error("The spawn spec holds no settings layers");
	}
	return { global: layers.global, overrides: layers.overrides };
}

// If this regresses, an API key, token or password a subagent's run set in its settings is written in plain text to
// its transcript file, where whoever can read the session directory finds it; or the subagent comes back without it
// and fails the calls that need it.
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
		// The control: the spawn's own settings writes are in the spec the transcript holds, so a credential
		// setting among them would be written here too; what keeps one out is the filter, not an empty record.
		// The runs' own writes are the parked subagent's to keep in memory, the plain one beside the credentials.
		expect(Object.keys(storedSpecLayers(stored).overrides).length).toBeGreaterThan(0);
		for (const value of [credential, overrideCredential, baseUrl]) {
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

// If this regresses, a value secrets.yml lists that a subagent was given (in its task context, say) is written in plain
// text to its transcript file when it spawns, although the session store is masked; or a subagent parked under
// masking can no longer be woken for a follow-up.
it("masks the stored spawn spec as other custom data and still revives", async () => {
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
		const spec = storedSpawnSpec(stored);
		if (!isRecord(probe) || typeof probe.context !== "string") throw new Error("The probe entry was not stored");
		if (!spec || !isRecord(spec.prompt)) throw new Error("No spawn spec was stored");
		expect(probe.context).not.toBe(context);
		expect(spec.prompt.context).toBe(probe.context);

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
	// written in plain text to a parked subagent's transcript file, where whoever can read the session directory
	// finds it; or the subagent comes back on the model without it and its calls fail.
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
			// The spawn recorded the spec, which names the model by its identity and never holds the model itself.
			expect(isRecord(storedSpawnSpec(stored))).toBe(true);
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

/** Names a settings layer of the spawn spec in the transcript at `sessionFile` through `__proto__`, as a forged file would. */
async function forgeSpecSettingsKey(sessionFile: string, key: string): Promise<void> {
	const lines = (await Bun.file(sessionFile).text()).split("\n");
	const index = lines.findLastIndex(line => line.includes('"type":"session_init"'));
	const entry: unknown = index === -1 ? undefined : JSON.parse(lines[index]!);
	const spec = isRecord(entry) ? entry.spawnSpec : undefined;
	const settings = isRecord(spec) ? spec.settings : undefined;
	const layers = isRecord(settings) ? settings.layers : undefined;
	if (!isRecord(layers) || !isRecord(layers.overrides)) {
		throw new Error("The spawn recorded no spec holding its settings layers");
	}
	// An own key, as JSON.parse makes one: assigning `__proto__` would swap the object's prototype, and the
	// written line would not hold the key at all.
	Object.defineProperty(layers.overrides, key, {
		value: { polluted: true },
		enumerable: true,
		writable: true,
		configurable: true,
	});
	lines[index] = JSON.stringify(entry);
	if (!lines[index].includes(`${JSON.stringify(key)}:{"polluted":true}`)) {
		throw new Error(`The forged spawn spec does not hold the key ${key}`);
	}
	await Bun.write(sessionFile, lines.join("\n"));
}

/**
 * Installs the persisted reviver factory as the top-level session does (`main.ts`), over the run's auth storage, model
 * registry and settings and a root session in the run's cwd on `model`, and counts the revivers asked of it: `count`
 * is how many cold revives the lifecycle began. The file's `afterEach` disposes the lifecycle, which drops the factory.
 */
function installColdReviver(run: KeptAliveRun, model: Model<Api>): { count: number } {
	// What a cold revive reads of a root session that holds no tool session: its cwd, its artifacts, its extension
	// policy, and its model, which a subagent whose model the registry does not hold revives on.
	const rootSession = {
		sessionManager: { getCwd: () => path.join(root, "home", "work"), getArtifactManager: () => undefined },
		effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
		model,
	} as unknown as AgentSession;
	const factory = createPersistedSubagentReviverFactory({
		session: rootSession,
		authStorage: run.modelRegistry.authStorage,
		modelRegistry: run.modelRegistry,
		settings: run.settings,
		enableLsp: false,
	});
	const coldRevivers = { count: 0 };
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		async ref => {
			coldRevivers.count++;
			return factory(ref);
		},
		() => 0,
	);
	return coldRevivers;
}

// If this regresses, a session file whose spawn spec names a settings layer through `__proto__` (forged or damaged)
// adds that field to every object of the process when its subagent is woken for a follow-up, or the subagent cannot
// be woken. An edited spec never revives warm (it is not the spec the park wrote), so the subagent revives cold, as
// the top-level session's reviver revives it, on the settings of an older record where the stored ones do not load.
it("revives from a spawn spec naming a settings layer through `__proto__` without changing Object.prototype", async () => {
	const models: Model<Api>[] = [];
	registerCustomApi(SECRET_MODEL_API, answeringStream(models), MOCK_API_SOURCE);
	const model = providerModel({ baseUrl: "https://llm.example.test/v1" });
	const run = await runKeptAliveSubagent({ model });
	try {
		const coldRevivers = installColdReviver(run, model);
		await AgentLifecycleManager.global().park(AGENT_ID);
		run.release();
		const sessionFile = AgentRegistry.global().get(AGENT_ID)?.sessionFile;
		if (!sessionFile) throw new Error(`subagent ${AGENT_ID} names no session file`);
		await forgeSpecSettingsKey(sessionFile, "__proto__");

		const followUp = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: TASK_AGENT,
			message: "anything else?",
			storeMaskCwd: path.join(root, "home", "work"),
		});
		expect(followUp.exitCode).toBe(0);
		expect(coldRevivers.count).toBe(1);
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
		// Equal in every field to the row the registry holds: the revive takes the model from the registry under
		// the identity its spawn spec stores, and keeps none of its own. Not the same object, because session
		// startup recomposes the catalog after the build resolved it; that copy dies with the revived session,
		// and its next park keeps no model the registry holds an equal one of (the collection above).
		expect(Bun.deepEquals(revivedModel, run.modelRegistry.find(REGISTRY_PROVIDER, REGISTRY_MODEL_ID), true)).toBe(
			true,
		);
		expect(Bun.deepEquals(revivedModel, parked.fields, true)).toBe(true);
	} finally {
		run.close();
	}
}, 30_000);
