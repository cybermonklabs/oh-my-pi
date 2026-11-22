/**
 * A change the base prompt withholds is recorded in the session file whose transcript the prompt withholds it from
 * (`system-prompt-hold`, `system-prompt-held-settings`), and ended there (`system-prompt-hold-end`) when it goes out
 * with the prompt keeping its bytes; a later process that resumes the session dates what it may keep from those
 * records. When the transcript is copied into another session file under a new id (a whole-session `/fork`, a fork at
 * an entry, an automatic move off a file another process owns), the conversation goes on in the copy, so the records
 * must go on in the copy too.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	OwnedElsewhereStorage,
	RELOAD_CALLS,
	reloadOverlay,
	setClock,
} from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries, so requests minutes apart keep them warm. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

const MINUTE_MS = 60_000;

interface ProcessInputs {
	/** The overlay's text. */
	overlay: string;
	/** The context file's text. */
	agentsMd: string;
	/** The session file to resume; a new session without one. */
	sessionFile?: string;
	/** Open the session as a process that may not write the file whose session has this id. */
	ownedElsewhere?: string;
}

describe("hold records of a transcript copied into another session file", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/** One process: runs `steps` on the session, then exits. Returns the requests and the file it ends on. */
	async function runProcess(
		dir: TempDir,
		inputs: ProcessInputs,
		steps: (session: AgentSession, settings: Settings, overlay: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string; sessionId: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, inputs.overlay);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(restore);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = inputs.sessionFile
			? await SessionManager.open(
					inputs.sessionFile,
					dir.join("sessions"),
					inputs.ownedElsewhere ? new OwnedElsewhereStorage(inputs.ownedElsewhere) : undefined,
				)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "bash"],
			contextFiles: [{ path: dir.join("AGENTS.md"), content: inputs.agentsMd }],
			skills: [],
		});
		try {
			await steps(session, settings, overlay);
			await sessionManager.flush();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file, sessionId: sessionManager.getSessionId() };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("ends a hold in a whole-session fork, so a later restart on the fork keeps its stored prompt", async () => {
		using dir = TempDir.createSync("@pi-hold-records-copy-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		// A change only the bash definition renders is held; the session is forked; five minutes on the change goes
		// out with the system prompt as it was.
		const live = await runProcess(
			dir,
			{ overlay: LONG_ENTRIES, agentsMd: "Build with make." },
			async (session, settings, overlay) => {
				setClock(0);
				await session.prompt("first");
				await reloadOverlay({ session, settings, overlay }, `${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`, [
					"holdToolDeclarationChange",
				]);
				setClock(MINUTE_MS);
				await session.prompt("second");
				await session.fork();
				setClock(6 * MINUTE_MS);
				await session.prompt("third");
			},
		);
		// Two minutes after the fork's last reply, the context file changed, a process resumes the fork.
		setClock(8 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			{
				overlay: `${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`,
				agentsMd: "Build with ninja.",
				sessionFile: live.sessionFile,
			},
			async session => {
				await session.prompt("fourth");
			},
		);

		const [first, , third] = live.requests;
		if (!first || !third) throw new Error("Expected the first process's requests");
		// Precondition: the change went out with the system prompt as it was.
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(resumed.requests[0]?.system)).toContain("Build with make.");
	}, 60_000);

	it("records a hold in a fork at the newest reply, so a restart on the fork sends it when it is due", async () => {
		using dir = TempDir.createSync("@pi-hold-records-copy-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		// A `personality` change is held after the newest reply, then the session is forked at that reply: the copy
		// holds the transcript up to the reply, without the records written after it.
		const live = await runProcess(
			dir,
			{ overlay: `${LONG_ENTRIES}personality: default\n`, agentsMd: "Build with make." },
			async (session, settings, overlay) => {
				setClock(0);
				await session.prompt("first");
				await reloadOverlay(
					{ session, settings, overlay },
					`${LONG_ENTRIES}personality: pragmatic\n`,
					RELOAD_CALLS,
				);
				const reply = session.sessionManager
					.getBranch()
					.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
				if (!reply) throw new Error("Expected the newest reply");
				await session.fork(reply.id);
			},
		);
		// Three minutes after the change, a process resumes the fork under the changed setting; six minutes after it,
		// the change is due.
		setClock(3 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			{
				overlay: `${LONG_ENTRIES}personality: pragmatic\n`,
				agentsMd: "Build with make.",
				sessionFile: live.sessionFile,
			},
			async session => {
				await session.prompt("second");
				setClock(6 * MINUTE_MS);
				await session.prompt("third");
			},
		);

		const [first] = live.requests;
		const [second, third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Precondition: the resumed process keeps the transcript's prompt while the change is under five minutes old.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(third.system)).not.toBe(withoutCacheControl(first.system));
	}, 60_000);

	it("ends a hold in the file a resumed session moved to, so a later restart there keeps its stored prompt", async () => {
		using dir = TempDir.createSync("@pi-hold-records-copy-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		// A `personality` change is held and told; the process exits.
		const live = await runProcess(
			dir,
			{ overlay: `${LONG_ENTRIES}personality: default\n`, agentsMd: "Build with make." },
			async (session, settings, overlay) => {
				setClock(0);
				await session.prompt("first");
				await reloadOverlay(
					{ session, settings, overlay },
					`${LONG_ENTRIES}personality: pragmatic\n`,
					RELOAD_CALLS,
				);
				setClock(MINUTE_MS);
				await session.prompt("second");
			},
		);
		// The setting was set back; a process resumes the session while another one owns its file, so its first write
		// moves the session to a sibling file. It sends the transcript's prompt, tells the model of the setting, and
		// six minutes after the change its own build, the same bytes, takes the stored prompt's place.
		setClock(2 * MINUTE_MS);
		const moved = await runProcess(
			dir,
			{
				overlay: `${LONG_ENTRIES}personality: default\n`,
				agentsMd: "Build with make.",
				sessionFile: live.sessionFile,
				ownedElsewhere: live.sessionId,
			},
			async session => {
				await session.prompt("third");
				setClock(6 * MINUTE_MS);
				await session.prompt("fourth");
			},
		);
		// Two minutes later, the context file changed, a process resumes the moved session.
		setClock(8 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			{
				overlay: `${LONG_ENTRIES}personality: default\n`,
				agentsMd: "Build with ninja.",
				sessionFile: moved.sessionFile,
			},
			async session => {
				await session.prompt("fifth");
			},
		);

		const [first] = live.requests;
		const [third, fourth] = moved.requests;
		if (!first || !third || !fourth) throw new Error("Expected the first two processes' requests");
		// Preconditions: the session moved, and the transcript's prompt went out with the same bytes throughout.
		expect(moved.sessionFile).not.toBe(live.sessionFile);
		expect(withoutCacheControl(fourth.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(resumed.requests[0]?.system)).toContain("Build with make.");
	}, 60_000);
});
