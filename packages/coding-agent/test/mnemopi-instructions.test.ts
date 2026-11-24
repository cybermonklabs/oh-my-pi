/**
 * The Mnemopi memory instructions tell the agent whether its turns are retained
 * automatically. That is true only when `mnemopi.autoRetain` is on and the session
 * is not a subagent alias, which retains nothing of its own.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

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
		expect(text).toContain("Turns are not retained automatically: only what you store with `retain` is kept.");
		expect(text).not.toContain("are retained automatically");
	});

	it("say a subagent's turns are not retained automatically even when its parent's are", async () => {
		const parent = startSession(true);
		const text = await instructions(startSession(true, parent));
		expect(text).toContain("Turns are not retained automatically");
		expect(text).not.toContain("are retained automatically");
	});
});
