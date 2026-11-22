/**
 * One process of `agent-session-mnemopi-transcript-construct.test.ts`. It constructs a session over a session file as
 * `omp render` does (`new AgentSession` on an opened file, without `createAgentSession`'s startup build), under settings
 * that select Mnemopi. Nothing in this process loads Mnemopi's core module before the session is constructed. Run as
 * `bun <this file> <input JSON>`; it writes {@link MnemopiTranscriptRun} to the input's `out` path.
 */
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { requireMnemopiCore } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

/** What the test gives the process. */
export interface MnemopiTranscriptInput {
	/** The working and agent directory. */
	dir: string;
	/** The settings overlay that selects Mnemopi. */
	overlay: string;
	/** The session file to open. */
	sessionFile: string;
	/** Where the process writes its {@link MnemopiTranscriptRun}. */
	out: string;
}

/** What the process saw. */
export interface MnemopiTranscriptRun {
	/** Whether Mnemopi's core module was loaded before the session was constructed. */
	coreLoadedBefore: boolean;
	/** The error constructing the session threw, if any. */
	error?: string;
}

function coreLoaded(): boolean {
	try {
		requireMnemopiCore();
		return true;
	} catch {
		return false;
	}
}

const input = JSON.parse(process.argv[2] ?? "{}") as MnemopiTranscriptInput;
const settings = await Settings.loadIsolated({ cwd: input.dir, agentDir: input.dir, configFiles: [input.overlay] });
const sessionManager = await SessionManager.open(input.sessionFile);
const authStorage = createInMemoryAuthStorage();
const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
const run: MnemopiTranscriptRun = { coreLoadedBefore: coreLoaded() };
try {
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	await session.dispose();
} catch (error) {
	run.error = error instanceof Error ? error.message : String(error);
	await sessionManager.close();
} finally {
	authStorage.close();
}
await Bun.write(input.out, JSON.stringify(run));
