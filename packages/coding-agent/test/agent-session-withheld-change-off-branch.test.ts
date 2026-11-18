import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** The `--config` overlay every process loads: one-hour cache entries, so requests a minute apart keep them warm. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

const ROLE = "You review the parser changes of this repository.";

const MINUTE_MS = 60_000;

/** The real clock, read before any test moves it. */
const realNow = Date.now.bind(Date);

/** Moves the clock `offsetMs` ahead of real time from now on. */
function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/** The system prompt a request sends, without its cache breakpoints. */
function systemOf(request: MessagesRequest | undefined): string {
	if (!request) throw new Error("Expected a request");
	return withoutCacheControl(request.system);
}

interface ProcessStep {
	session: AgentSession;
	sessionManager: SessionManager;
	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuilds it starts. */
	reload(content: string): Promise<void>;
}

/** The id of the branch's newest message entry with `role`. */
function newestMessageId(sessionManager: SessionManager, role: "user" | "assistant"): string {
	const entry = sessionManager
		.getBranchView()
		.findLast(candidate => candidate.type === "message" && candidate.message.role === role);
	if (!entry) throw new Error(`Expected a ${role} message on the branch`);
	return entry.id;
}

// A change the system prompt withholds to keep the cached prefix goes out at the first request five minutes after the
// change at the latest, a restart included: the branch records when the change began (a `system-prompt-hold` entry),
// and a resumed process that restores the withholding prompt keeps the change no longer than that. `/tree` moves the
// session onto another branch of the same transcript, and the change is still withheld there.
describe("a withheld prompt change after /tree and a restart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its context file `agentsMd` and its settings loaded
	 * from the overlay: runs `steps`, then exits.
	 */
	async function runProcess(
		tempDir: TempDir,
		agentsMd: string,
		sessionFile: string | undefined,
		steps: (step: ProcessStep) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = tempDir.join("overlay.yml");
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		// Each reply writes the prompt cache, so a reopened transcript says what its newest reply left there.
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			await steps({
				session,
				sessionManager,
				reload: content => reloadOverlay({ session, settings, overlay }, content),
			});
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	it("sends this process's own build five minutes after a restore whose record /tree left on another branch", async () => {
		using tempDir = TempDir.createSync("@pi-withheld-off-branch-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		await Bun.write(tempDir.join("overlay.yml"), OVERLAY);
		const live = await runProcess(tempDir, "Build with make.", undefined, async ({ session }) => {
			await session.prompt("first");
		});

		// The context file changed while no process ran. At minute 0 a process resumes the transcript, keeps its stored
		// prompt for the live cache entry, sends one prompt, then the user rewinds to edit that prompt (`/tree` on it)
		// and sends another at minute 1.
		setClock(0);
		const restored = await runProcess(
			tempDir,
			"Build with ninja.",
			live.sessionFile,
			async ({ session, sessionManager }) => {
				await session.prompt("run the parser tests");
				await session.navigateTree(newestMessageId(sessionManager, "user"));
				setClock(MINUTE_MS);
				await session.prompt("run the lexer tests");
			},
		);
		// The process restarts at minute 3 and sends a prompt at minutes 3 and 5.
		setClock(3 * MINUTE_MS);
		const restarted = await runProcess(tempDir, "Build with ninja.", restored.sessionFile, async ({ session }) => {
			await session.prompt("three minutes after the restore");
			setClock(5 * MINUTE_MS);
			await session.prompt("five minutes after the restore");
		});

		const stored = systemOf(live.requests[0]);
		// Precondition: the edited context file was withheld from minute 0, on both branches.
		expect(restored.requests.map(systemOf)).toEqual([stored, stored]);
		expect(systemOf(restarted.requests[0])).toBe(stored);
		// Five minutes after the change began to be withheld, this process's own build goes out.
		const atBound = systemOf(restarted.requests[1]);
		expect(atBound).toContain("Build with ninja.");
		expect(atBound).not.toContain("Build with make.");
	}, 60_000);

	it("sends a held settings change five minutes after it was made when /tree left its record on another branch", async () => {
		using tempDir = TempDir.createSync("@pi-withheld-off-branch-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		await Bun.write(tempDir.join("overlay.yml"), OVERLAY);
		// At minute 0, after two replies, the personality changes under the bound prompt: the rebuild is held. The user
		// then goes back to the first reply (`/tree`) and continues from there at minute 1.
		setClock(0);
		const live = await runProcess(
			tempDir,
			"Build with make.",
			undefined,
			async ({ session, sessionManager, reload }) => {
				await session.prompt("first");
				const firstReply = newestMessageId(sessionManager, "assistant");
				await session.prompt("second");
				await reload(`${OVERLAY}personality: pragmatic\n`);
				await session.navigateTree(firstReply);
				setClock(MINUTE_MS);
				await session.prompt("third, from the first reply");
			},
		);
		// What a process started on the changed settings sends.
		const fresh = await runProcess(tempDir, "Build with make.", undefined, async ({ session }) => {
			await session.prompt("a fresh session");
		});
		// The process restarts at minute 3 and sends a prompt at minutes 3 and 5.
		setClock(3 * MINUTE_MS);
		const resumed = await runProcess(tempDir, "Build with make.", live.sessionFile, async ({ session }) => {
			await session.prompt("three minutes after the change");
			setClock(5 * MINUTE_MS);
			await session.prompt("five minutes after the change");
		});

		const bound = systemOf(live.requests[0]);
		// Precondition: the first process held the change on the bound prompt, on both branches.
		expect(live.requests.map(systemOf)).toEqual([bound, bound, bound]);
		expect(systemOf(fresh.requests[0])).not.toBe(bound);
		expect(systemOf(resumed.requests[0])).toBe(bound);
		// Five minutes after the change it goes out, as it does without the `/tree`.
		expect(systemOf(resumed.requests[1])).toBe(systemOf(fresh.requests[0]));
	}, 60_000);
});
