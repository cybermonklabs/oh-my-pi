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
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgContextPromotionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
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
		if (
			typeof data === "object" &&
			data !== null &&
			"roster" in data &&
			typeof data.roster === "object" &&
			data.roster &&
			"block" in data &&
			typeof data.block === "string"
		) {
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
	/** Drops the mock's session-bound recordings. */
	release(): void;
	close(): void;
}

/** Runs `AGENT_ID` to a finished keep-alive state. */
async function runKeptAliveSubagent(
	options: { handler?: MockHandler; tools?: string[]; enableIrc?: boolean } = {},
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
	const modelRegistry = new ModelRegistry(authStorage);
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
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { ...TASK_AGENT, tools: options.tools ?? ["read"] },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
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
