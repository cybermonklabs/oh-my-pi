/**
 * The cut rule's "waits" for an automatic model-summary compaction keeps every maintenance point from starting a
 * background summary (compaction speculation) for a cut that cannot run. A process that may not write the session
 * file it resumed (another omp process writes it) moves the session to a sibling file under a new session id, with the
 * same entries and the same provider prompt-cache key: its requests read the same cache entry, so the compaction still
 * cannot run there. This case resumes a session whose compaction the rule waits on while another process owns its
 * file, in the band below the resumed process's threshold, where the rule is not asked again and the wait the session
 * holds is all that keeps a summary from being requested.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager, type SessionPersistenceNotice } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { computeNonMessageTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { continuesCachedPrompt, gatewayModelsYml, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { processSettings, recordGateway, SUMMARY_COMPACTION_WAITS, transcript } from "./helpers/compaction-wait";

/** A 400,000-token window: its prompt budget is far above the configured threshold, so no cut is forced. */
const CONTEXT_WINDOW = 400_000;
/** The first process's threshold sits this far below the transcript's context: the rule is asked and waits. */
const THRESHOLD_MARGIN = 2_000;
/**
 * The resumed process's threshold sits this far above the transcript's context: the context is in the band below it
 * where a background summary starts, and the prompts the process sends keep it there.
 */
const BAND_MARGIN = 4_000;

/** Session storage of a process that may not write the session another omp process owns. */
class OwnedElsewhereStorage extends FileSessionStorage {
	readonly #ownedId: string;

	constructor(ownedId: string) {
		super();
		this.#ownedId = ownedId;
	}

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		return sessionId === this.#ownedId ? null : super.claimSession(sessionId, sessionPath);
	}
}

describe("a model-summary compaction the cut rule waits on, across a move off a session file another process owns", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts no background summary in the band below the threshold after the move while the wait holds", async () => {
		using tempDir = TempDir.createSync("@pi-compaction-wait-move-off-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(CONTEXT_WINDOW));
		const messages = transcript();
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const options = {
			...gatewaySessionOptions(tempDir),
			authStorage,
			modelRegistry,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		};

		// The context the transcript sends: the tools and system prompt of a session built as the process builds its
		// own, and the messages.
		const { session: sizing } = await createAgentSession({
			...options,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: processSettings(CONTEXT_WINDOW / 2),
		});
		const contextTokens =
			computeNonMessageTokens(sizing, sizing.agent.tokenizer, sizing.settings.revision) +
			sizing.agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		await sizing.dispose();

		const { requests, timeline, send } = recordGateway(contextTokens);

		// The process before this one: its compaction waits once its second prompt's reply wrote the whole context to a
		// one-hour entry. It exits.
		const written = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		for (const message of messages) written.appendMessage(message);
		const { session: before } = await createAgentSession({
			...options,
			sessionManager: written,
			settings: processSettings(contextTokens - THRESHOLD_MARGIN),
		});
		let sessionFile: string | undefined;
		try {
			await send(before, "first prompt");
			await send(before, "second prompt");
			sessionFile = written.getSessionFile();
			await written.flush();
		} finally {
			await before.dispose();
		}
		if (!sessionFile) throw new Error("Expected a persisted session");
		const lastBefore = requests.findLast(request => request.kind === "main");
		if (!lastBefore) throw new Error("Expected the earlier process's main requests");
		// Precondition: the earlier process waited on the compaction.
		expect(timeline).toContain(SUMMARY_COMPACTION_WAITS);
		requests.length = 0;
		timeline.length = 0;

		// omp resumes the session a moment later, with a higher threshold, while another omp process owns its file:
		// its first write moves the session to a sibling file under a new id.
		const originalId = written.getSessionId();
		const resumedManager = await SessionManager.open(
			sessionFile,
			tempDir.join("sessions"),
			new OwnedElsewhereStorage(originalId),
		);
		const notices: SessionPersistenceNotice[] = [];
		resumedManager.onPersistenceNotice(notice => notices.push(notice));
		const { session } = await createAgentSession({
			...options,
			sessionManager: resumedManager,
			settings: processSettings(contextTokens + BAND_MARGIN),
		});
		try {
			await send(session, "resumed prompt");
			await send(session, "next prompt");
			const resumedMain = requests.find(request => request.kind === "main");
			if (!resumedMain) throw new Error("Expected the resumed process's main request");
			// Preconditions: the session moved off the file another process owns, under a new id, and its first request
			// sends the prompt the earlier process's last request sent, so it reads the entry the rule waited on.
			expect({
				moved: notices.map(notice => notice.reason),
				newId: resumedManager.getSessionId() !== originalId,
				continues: continuesCachedPrompt(lastBefore.body, resumedMain.body),
				compacted: resumedManager.getBranch().some(entry => entry.type === "compaction"),
			}).toEqual({ moved: ["open-elsewhere"], newId: true, continues: true, compacted: false });
			// Below the threshold the rule is not asked again: the wait the session holds is all that keeps the moved
			// session from requesting a summary, a model call for a cut that cannot run.
			expect(timeline).not.toContain("summary request");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 180_000);
});
