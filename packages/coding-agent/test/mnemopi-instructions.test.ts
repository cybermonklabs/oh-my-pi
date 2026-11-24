/**
 * The Mnemopi memory instructions tell the agent whether its turns are retained
 * automatically. That is true only when `mnemopi.autoRetain` is on and the session
 * is not a subagent alias, which retains nothing of its own. A real session renders
 * its first system prompt before the Mnemopi state exists, so the line must be right
 * there too, not only once the state is installed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const RETAINED = "Completed turns are also retained automatically.";
const NOT_RETAINED = "Turns are not retained automatically";
const model = getBundledModel("muse-code", "muse-spark-1.3-contributor");

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose({ consolidate: false });
	for (const dir of dirs.splice(0)) await dir.remove();
});

/** A session with its own Mnemopi state; `aliasOf` makes it a subagent alias of that parent. */
function startSession(autoRetain: boolean, aliasOf?: MnemopiSessionState): MnemopiSessionState {
	const dir = TempDir.createSync("@mnemopi-instructions-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.autoRetain": autoRetain,
	});
	const session = {
		sessionId: `session-${states.length}`,
		settings,
		getXdevToolEntries: () => [],
		subscribe: () => () => {},
	};
	const state = new MnemopiSessionState({
		sessionId: session.sessionId,
		config: loadMnemopiConfig(settings, dir.path()),
		session: session as never,
		aliasOf,
		hasRecalledForFirstTurn: aliasOf !== undefined,
	});
	setMnemopiSessionState(session as never, state);
	states.push(state);
	return state;
}

async function instructions(state: MnemopiSessionState): Promise<string> {
	const text = await mnemopiBackend.buildDeveloperInstructions("/tmp", "/tmp", state.session.settings, state.session);
	if (text === undefined) throw new Error("the Mnemopi backend gave no instructions");
	return text;
}

describe("Mnemopi memory instructions", () => {
	it("say completed turns are retained automatically when autoRetain is on", async () => {
		const text = await instructions(startSession(true));
		expect(text).toContain("Completed turns are also retained automatically.");
		expect(text).not.toContain("not retained automatically");
	});

	it("say turns are not retained automatically when autoRetain is off", async () => {
		const text = await instructions(startSession(false));
		expect(text).toContain(
			"Turns are not retained automatically: a memory is kept only when it is stored on purpose, as with `retain`.",
		);
		expect(text).not.toContain("are retained automatically");
	});

	it("say a subagent's turns are not retained automatically even when its parent's are", async () => {
		const parent = startSession(true);
		const text = await instructions(startSession(true, parent));
		expect(text).toContain("Turns are not retained automatically");
		expect(text).not.toContain("are retained automatically");
	});

	it("follow the settings and the task depth before the session's Mnemopi state exists", async () => {
		const render = async (autoRetain: boolean, taskDepth: number) =>
			(await mnemopiBackend.buildDeveloperInstructions(
				"/tmp",
				"/tmp",
				Settings.isolated({ "mnemopi.autoRetain": autoRetain }),
				undefined,
				taskDepth,
			)) ?? "";
		expect(await render(true, 0)).toContain(RETAINED);
		expect(await render(false, 0)).toContain(NOT_RETAINED);
		expect(await render(true, 1)).toContain(NOT_RETAINED);
	});
});

/** Which auto-retain line one request's system prompt carries. */
function retainLine(systemPrompt: readonly string[]): string {
	const text = systemPrompt.join("\n");
	return [RETAINED, NOT_RETAINED].filter(line => text.includes(line)).join(" | ") || "none";
}

/**
 * Real SDK sessions on one Mnemopi store, every model request's system prompt captured.
 * Each session starts Mnemopi in the background, as in production; `started(n)` settles
 * when the n-th start has finished.
 */
async function sdkHarness(dir: TempDir, overrides: Record<string, unknown>) {
	const auth = await AuthStorage.create(dir.join("auth.db"));
	auth.keys.setRuntime("muse-code", "test-key");
	const systemPrompts: string[][] = [];
	const mock = createMockModel({ handler: { content: [{ type: "text", text: "ok" }] } });
	const realStreamFactory = settingsStream.createSettingsAwareStreamFn;
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in this test"));
	vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
		realStreamFactory(
			settings,
			(streamModel, context, options) => {
				systemPrompts.push([...(context.systemPrompt ?? [])]);
				return mock.stream(streamModel, context, options);
			},
			slow,
		),
	);
	const starts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const pending = [...starts];
	const realStart = mnemopiBackend.start;
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await realStart.call(mnemopiBackend, options);
		pending.shift()?.resolve();
	});
	const settings = Settings.isolated({
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		...overrides,
	});
	const sessions: AgentSession[] = [];
	const open = async (name: string, subagentOf?: AgentSession): Promise<AgentSession> => {
		const parentState = subagentOf ? getMnemopiSessionState(subagentOf) : undefined;
		if (subagentOf && !parentState) throw new Error("the parent session has no Mnemopi state");
		const { session } = await sdk.createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage: auth,
			model,
			settings,
			sessionManager: SessionManager.create(dir.path(), dir.join(name)),
			toolNames: [],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			...(subagentOf ? { taskDepth: 1, parentMnemopiSessionState: parentState } : {}),
		});
		sessions.push(session);
		return session;
	};
	return {
		systemPrompts,
		open,
		started: (n: number) => starts[n]!.promise,
		async close() {
			for (const session of sessions.reverse()) await session.dispose();
			auth.close();
		},
	};
}

/** Sends one prompt and waits for the turn's auto-retain, so `lastRetainedTurn` shows whether it ran. */
async function promptAndRetain(session: AgentSession, text: string): Promise<void> {
	const state = getMnemopiSessionState(session);
	if (!state) throw new Error("the session has no Mnemopi state");
	const retains: Promise<void>[] = [];
	const realRetain = state.maybeRetainOnAgentEnd.bind(state);
	state.maybeRetainOnAgentEnd = messages => {
		const retain = realRetain(messages);
		retains.push(retain);
		return retain;
	};
	await session.prompt(text);
	await Promise.all(retains);
}

describe("The system prompt a real session sends", () => {
	it("says turns are retained automatically in a top-level session with the default settings", async () => {
		using dir = TempDir.createSync("@mnemopi-instructions-sdk-");
		// Every turn is a retain turn, so the test sees the first turn retained.
		const harness = await sdkHarness(dir, { "mnemopi.retainEveryNTurns": 1 });
		try {
			const session = await harness.open("main");
			await harness.started(0);
			await promptAndRetain(session, "Say ok.");
			expect(getMnemopiSessionState(session)?.lastRetainedTurn).toBe(1);
			await promptAndRetain(session, "Say ok again.");
			expect(harness.systemPrompts.map(retainLine)).toEqual([RETAINED, RETAINED]);
		} finally {
			await harness.close();
		}
	}, 60_000);

	it("says turns are not retained automatically with autoRetain off", async () => {
		using dir = TempDir.createSync("@mnemopi-instructions-sdk-");
		const harness = await sdkHarness(dir, { "mnemopi.autoRetain": false, "mnemopi.retainEveryNTurns": 1 });
		try {
			const session = await harness.open("main");
			await harness.started(0);
			await promptAndRetain(session, "Say ok.");
			expect(getMnemopiSessionState(session)?.lastRetainedTurn).toBe(0);
			expect(harness.systemPrompts.map(retainLine)).toEqual([NOT_RETAINED]);
		} finally {
			await harness.close();
		}
	}, 60_000);

	it("says a subagent's turns are not retained automatically while its parent's are", async () => {
		using dir = TempDir.createSync("@mnemopi-instructions-sdk-");
		const harness = await sdkHarness(dir, { "mnemopi.retainEveryNTurns": 1 });
		try {
			const parent = await harness.open("main");
			await harness.started(0);
			const child = await harness.open("child", parent);
			await harness.started(1);
			expect(getMnemopiSessionState(child)?.aliasOf).toBe(getMnemopiSessionState(parent));
			await child.prompt("Say ok.");
			expect(harness.systemPrompts.map(retainLine)).toEqual([NOT_RETAINED]);
		} finally {
			await harness.close();
		}
	}, 60_000);
});
