/**
 * A change the base prompt withholds is recorded in the session (`system-prompt-hold`) and ended there
 * (`system-prompt-hold-end`) when it goes out with the prompt keeping its bytes; a process that resumes the session
 * dates what it may keep from those records. A copy of the branch cut before the end record (`/fork` at an earlier
 * reply, `/tree` to it and a `/btw` answer promoted into a new file) holds the hold but not its end, so the end must go
 * into the copy too: without it, a process that resumes the copy dates the change from the hold, finds it due, and
 * sends its own build in place of the prompt the copy's cache entry holds.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay, setClock } from "./helpers/agent-session-setup";
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
/** A change only the bash definition renders: the system prompt keeps its bytes when it goes out. */
const CHANGED = `${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`;
const MINUTE_MS = 60_000;

/** A `/btw` answer to promote. */
const BTW_ANSWER: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "It runs make." }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 0,
};

describe("the end of a hold, across a copy of the branch cut before it", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/** One process: runs `steps` on the session, then exits. Returns the requests and the file it ends on. */
	async function runProcess(
		dir: TempDir,
		inputs: { overlay: string; agentsMd: string; sessionFile?: string },
		steps: (session: AgentSession, settings: Settings, overlay: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
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
			? await SessionManager.open(inputs.sessionFile, dir.join("sessions"))
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
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it.each([
		{
			copy: "/fork at the reply before the change went out",
			make: async (session: AgentSession, replyId: string) => {
				expect(await session.fork(replyId)).toBe(true);
			},
		},
		{
			copy: "/tree to that reply and a /btw answer promoted into a new file",
			make: async (session: AgentSession, replyId: string) => {
				await session.navigateTree(replyId);
				const promoted = await session.branchFromBtw(
					"which build tool?",
					{ ...BTW_ANSWER, timestamp: Date.now() },
					replyId,
					session.sessionManager.getSessionId(),
				);
				expect(promoted.cancelled).toBe(false);
			},
		},
	])(
		"keeps the copy's stored prompt in a process that resumes it after $copy",
		async ({ make }) => {
			using dir = TempDir.createSync("@pi-hold-end-copy-");
			await Bun.write(dir.join("models.yml"), gatewayModelsYml());
			// A change only the bash definition renders is held; five minutes on it goes out with the system prompt as it
			// was, which ends the hold. The branch is then copied up to the reply before that.
			const live = await runProcess(
				dir,
				{ overlay: LONG_ENTRIES, agentsMd: "Build with make." },
				async (session, settings, overlay) => {
					setClock(0);
					await session.prompt("first");
					await reloadOverlay({ session, settings, overlay }, CHANGED, ["holdToolDeclarationChange"]);
					setClock(MINUTE_MS);
					await session.prompt("second");
					const reply = session.sessionManager
						.getBranch()
						.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
					if (!reply) throw new Error("Expected the second reply");
					setClock(6 * MINUTE_MS);
					await session.prompt("third");
					await make(session, reply.id);
				},
			);
			// Two minutes later, the context file changed, a process resumes the copy while its cache entry is live, under
			// the setting the copy's last request declared its tools with, so that request's entry is the one it reads.
			setClock(8 * MINUTE_MS);
			const resumed = await runProcess(
				dir,
				{ overlay: LONG_ENTRIES, agentsMd: "Build with ninja.", sessionFile: live.sessionFile },
				async session => {
					await session.prompt("fourth");
				},
			);

			const [first, , third] = live.requests;
			if (!first || !third) throw new Error("Expected the first process's requests");
			// Precondition: the change went out with the system prompt as it was.
			expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(resumed.requests[0]?.system)).toContain("Build with make.");
		},
		60_000,
	);
});
