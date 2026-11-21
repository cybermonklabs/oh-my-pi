/**
 * A refused automatic snapcompact pass is recorded in the session, and each process reads the records once for each
 * session it holds. These cases leave a session with `/new`, let another process resume it, branch it and have a pass
 * of its own refused, then `/resume` it again in the first process, and compare the first process's next request with
 * the other process's last one.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The threshold sits this far below the transcript's context. */
const THRESHOLD_MARGIN = 3_000;
/** Each of the last main requests' prompts grew this much over the one before it. */
const GROWTH = 20_000;
/** How many replies before the final one say what their request sent. */
const SIZED_REPLIES = 3;
const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(64);
const TURNS = 64;

/** A reply of the transcript, its request's prompt size unset. */
function reply(index: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `reply ${index}: ${FILLER}` }],
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
		timestamp,
	};
}

/** Sets what `message`'s request sent, read from the cache. */
function sentFromCache(message: AssistantMessage, promptTokens: number): void {
	message.usage.cacheRead = promptTokens;
	message.usage.output = 100;
	message.usage.totalTokens = promptTokens + 100;
}

/** Ends a turn with `final`, which runs the session's post-turn maintenance. */
async function endTurn(session: AgentSession, final: AgentMessage): Promise<void> {
	session.agent.emitExternalEvent({ type: "message_end", message: final });
	session.agent.emitExternalEvent({ type: "agent_end", messages: [final] });
	await session.waitForIdle();
}

describe("a refused snapcompact pass after another process continued a session this process left", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One omp process: its session on `sessionManager`, built as the CLI builds it, over `thresholdTokens`. */
	async function openProcess(
		tempDir: TempDir,
		sessionManager: SessionManager,
		thresholdTokens: number,
	): Promise<{ session: AgentSession; authStorage: AuthStorage }> {
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"providers.cacheRetention": "long",
				"compaction.methodOrder": ["snapcompact"],
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 4000,
				"compaction.thresholdTokens": thresholdTokens,
			}),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		return { session, authStorage };
	}

	it("sends the other process's last prompt as it sent it at the first request after the switch back", async () => {
		using tempDir = TempDir.createSync("@pi-snapcompact-refusal-switch-back-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(CONTEXT_WINDOW));
		const now = Date.now();
		const transcript: (UserMessage | AssistantMessage)[] = [];
		const replies: AssistantMessage[] = [];
		for (let i = 0; i < TURNS; i++) {
			transcript.push({
				role: "user",
				content: [{ type: "text", text: `turn ${i}: ${FILLER}` }],
				timestamp: now - 60_000,
			});
			const message = reply(i, i < TURNS - 1 ? now - 59_000 : now);
			replies.push(message);
			transcript.push(message);
		}

		// The context the transcript sends, tools and system prompt included: the final reply's request sent it all,
		// read from a live one-hour entry, and the last few requests before it grew GROWTH tokens each.
		const sizing = await openProcess(tempDir, SessionManager.inMemory(tempDir.path()), CONTEXT_WINDOW / 2);
		const contextTokens =
			computeNonMessageTokens(sizing.session, sizing.session.agent.tokenizer, sizing.session.settings.revision) +
			sizing.session.agent.tokenizer.countMessages(transcript, { excludeEncryptedReasoning: true });
		await sizing.session.dispose();
		sizing.authStorage.close();
		const final = replies[TURNS - 1];
		sentFromCache(final, contextTokens);
		for (let offset = 1; offset <= SIZED_REPLIES; offset++) {
			sentFromCache(replies[TURNS - 1 - offset], contextTokens - offset * GROWTH);
		}
		const thresholdTokens = contextTokens - THRESHOLD_MARGIN;

		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: contextTokens }));
		const render = vi.spyOn(snapcompact, "compact");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		for (const message of transcript) sessionManager.appendMessage(message);
		const first = await openProcess(tempDir, sessionManager, thresholdTokens);
		try {
			// The context is past the threshold and far below the prompt budget: the pass renders, and the archive does
			// not pay for rewriting itself and the kept turns, so the rule refuses it and nothing is committed.
			await endTurn(first.session, final);
			const sessionFile = first.session.sessionFile;
			if (!sessionFile) throw new Error("Expected a persisted session");
			expect(render.mock.calls.length).toBe(1);
			// `/new`: this process leaves the session, and gives up its file.
			await first.session.newSession();

			// Another omp process resumes the session, continues it from the reply before the final one (`/tree`), and
			// sends a prompt: its branch does not carry the reply the first refusal was weighed on, so its pass renders,
			// is refused in turn, and is recorded.
			const other = await openProcess(tempDir, await SessionManager.open(sessionFile), thresholdTokens);
			let compactedByOther: boolean;
			try {
				const earlier = other.session.sessionManager
					.getBranch()
					.filter(entry => entry.type === "message" && entry.message.role === "assistant")
					.at(-2);
				if (!earlier) throw new Error("Expected the reply before the final one");
				await other.session.navigateTree(earlier.id);
				await other.session.prompt("go on from here");
				compactedByOther = other.session.sessionManager.getBranch().some(entry => entry.type === "compaction");
			} finally {
				await other.session.dispose();
				other.authStorage.close();
			}
			const lastOfOther = requests.at(-1);
			if (!lastOfOther) throw new Error("Expected the other process's request");
			expect({ renders: render.mock.calls.length, compacted: compactedByOther }).toEqual({
				renders: 2,
				compacted: false,
			});

			// `/resume` the session again in the first process, and ask about it.
			expect(await first.session.switchSession(sessionFile)).toBe(true);
			await first.session.prompt("what changed?");
			const next = requests.at(-1);
			if (!next || next === lastOfOther) throw new Error("Expected the request after the switch back");

			// Its request sends the other process's last prompt as it sent it: nothing was cut. The switch back read the
			// other process's refusal too, so this process weighed its figures and rendered no archive of its own.
			expect({
				continues: continuesCachedPrompt(lastOfOther, next),
				compacted: first.session.sessionManager.getBranch().some(entry => entry.type === "compaction"),
				renders: render.mock.calls.length,
			}).toEqual({ continues: true, compacted: false, renders: 2 });
		} finally {
			await first.session.dispose();
			first.authStorage.close();
			restore();
		}
	}, 120_000);
});
