/**
 * A first-turn memory recall is recorded with the scope it read: the backend, and for Hindsight the server, account,
 * bank and tag filter. A resumed process reuses a recorded recall, as a system block or as a hidden message, only for
 * the scope its live backend reads, so a configuration that names another bank or backend never sends the other
 * scope's memories again.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	findDeliveredRecallChanges,
	MEMORY_RECALL_CHANGES_MESSAGE_TYPE,
	persistRecall,
} from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The Hindsight server the settings name; the `fetch` spy answers it, so no request leaves the process. */
const HINDSIGHT_URL = "http://127.0.0.1:1";

/** What each bank recalls. */
const MEMORIES: Record<string, string> = {
	"fleet-bank": "The deploy host is alpha-7.",
	"other-bank": "The staging host is beta-3.",
};

const HOUR_MS = 60 * 60_000;

/** A `memory.yml` on one-hour cache entries under Hindsight, its server the test's, reading `bank`. */
function hindsightMemory(bank: string): string {
	return `providers:
  cacheRetention: long
memory:
  backend: hindsight
hindsight:
  apiUrl: ${HINDSIGHT_URL}
  bankId: ${bank}
  scoping: per-project-tagged
  recallTypes: [world, experience, observation]
  recallMaxTokens: 2000
  retainMode: last-turn
  retainEveryNTurns: 1
  retainOverlapTurns: 0
  mentalModelsEnabled: false
`;
}

/** A `memory.yml` on one-hour cache entries under Mnemopi, its store in `dir`, with nothing remembered. */
function mnemopiMemory(dir: TempDir): string {
	return `providers:
  cacheRetention: long
memory:
  backend: mnemopi
mnemopi:
  dbPath: ${dir.join("mnemopi", "mnemopi.db")}
  scoping: global
  noEmbeddings: true
  llmMode: none
`;
}

describe("a resumed session's recall of another scope", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) loading `memoryYml`: runs `steps`, then exits. */
	async function runProcess(
		dir: TempDir,
		memoryYml: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("memory.yml");
		await Bun.write(overlay, memoryYml);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const requests: MessagesRequest[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = new URL(String(input));
				if (url.href === `${GATEWAY}/v1/messages`) {
					requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
					return answer(requests.length, { cacheWriteTokens: 100 });
				}
				if (url.origin !== HINDSIGHT_URL) throw new Error(`Unexpected request to ${url.href}`);
				const recall = /^\/v1\/default\/banks\/([^/]+)\/memories\/recall$/.exec(url.pathname);
				if (recall) {
					const text = MEMORIES[decodeURIComponent(recall[1])];
					return Response.json({ results: text ? [{ id: "m1", text, type: "world" }] : [] });
				}
				const found = /^\/v1\/default\/banks\/([^/]+)$/.exec(url.pathname);
				if (found) return Response.json({ bank_id: decodeURIComponent(found[1]) });
				return Response.json({});
			}),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.settleMemoryBackend();
			await steps(session);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			fetchSpy.mockRestore();
		}
	}

	it("sends a bank's own recall as the prompt's block, not as the other bank's hidden one, after a bank and back", async () => {
		using dir = TempDir.createSync("@pi-recall-scope-hidden-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const first = await runProcess(dir, hindsightMemory("fleet-bank"), undefined, async session => {
			await session.prompt("first");
		});
		setClock(3 * HOUR_MS);
		const second = await runProcess(dir, hindsightMemory("other-bank"), first.sessionFile, async session => {
			await session.prompt("second");
		});
		setClock(6 * HOUR_MS);
		const third = await runProcess(dir, hindsightMemory("fleet-bank"), first.sessionFile, async session => {
			await session.prompt("third");
		});

		const [firstRequest] = first.requests;
		const [secondRequest] = second.requests;
		const [thirdRequest] = third.requests;
		if (!firstRequest || !secondRequest || !thirdRequest) throw new Error("Expected each process's request");
		// Preconditions: the first process sent its bank's recall as the prompt's block, and the second its own bank's
		// as a hidden message after the conversation.
		expect(copiesIn(firstRequest.system, MEMORIES["fleet-bank"])).toBe(1);
		expect(copiesIn(secondRequest.system, MEMORIES["other-bank"])).toBe(0);
		expect(copiesIn(secondRequest.messages, MEMORIES["other-bank"])).toBe(1);

		// Back on the first bank, its recorded recall goes out as the block the first request sent, never as a hidden
		// message because the other bank's went out hidden.
		expect({
			system: copiesIn(thirdRequest.system, MEMORIES["fleet-bank"]),
			messages: copiesIn(thirdRequest.messages, MEMORIES["fleet-bank"]),
		}).toEqual({ system: 1, messages: 0 });
	}, 90_000);

	it("sends none of the old bank's recall from a stored prompt restored within the live entry", async () => {
		using dir = TempDir.createSync("@pi-recall-scope-restore-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const first = await runProcess(dir, hindsightMemory("fleet-bank"), undefined, async session => {
			await session.prompt("first");
		});
		// The configuration moves to another bank; the session is resumed a minute on, its one-hour entry live.
		setClock(60_000);
		const resumed = await runProcess(dir, hindsightMemory("other-bank"), first.sessionFile, async session => {
			await session.prompt("second");
		});

		const [firstRequest] = first.requests;
		const [secondRequest] = resumed.requests;
		if (!firstRequest || !secondRequest) throw new Error("Expected the two processes' requests");
		// Precondition: the first process sent its bank's recall as the prompt's block.
		expect(copiesIn(firstRequest.system, MEMORIES["fleet-bank"])).toBe(1);
		// The resumed process sends its own build, not the stored prompt that carries the old bank's recall.
		expect(copiesIn(secondRequest, MEMORIES["fleet-bank"])).toBe(0);
	}, 60_000);

	it("sends none of Hindsight's recall from a session resumed under Mnemopi", async () => {
		using dir = TempDir.createSync("@pi-recall-scope-backend-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const first = await runProcess(dir, hindsightMemory("fleet-bank"), undefined, async session => {
			await session.prompt("first");
		});
		setClock(3 * HOUR_MS);
		const resumed = await runProcess(dir, mnemopiMemory(dir), first.sessionFile, async session => {
			await session.prompt("second");
		});

		const [firstRequest] = first.requests;
		const [secondRequest] = resumed.requests;
		if (!firstRequest || !secondRequest) throw new Error("Expected the two processes' requests");
		// Precondition: the first process sent Hindsight's recall as the prompt's block.
		expect(copiesIn(firstRequest.system, MEMORIES["fleet-bank"])).toBe(1);
		// Mnemopi recalls for itself: Hindsight's recall is not the conversation's under it.
		expect(copiesIn(secondRequest, MEMORIES["fleet-bank"])).toBe(0);
	}, 60_000);
});

describe("the change reports a reused recall carries", () => {
	it("are the reports of the scope the live backend reads, since its own newest recall", () => {
		const sessionManager = SessionManager.inMemory();
		const report = (scope: string, content: string) =>
			sessionManager.appendCustomMessageEntry(MEMORY_RECALL_CHANGES_MESSAGE_TYPE, content, false, {
				scope,
				memories: [],
			});
		sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		persistRecall(sessionManager, "scope-x", { text: "recall of x", memories: [] });
		report("scope-x", "x changed");
		persistRecall(sessionManager, "scope-y", { text: "recall of y", memories: [] });
		report("scope-y", "y changed");

		const branch = sessionManager.getBranch();
		// Scope X's recall is reused after scope Y's newer one: only X's report says what changed in it.
		expect(findDeliveredRecallChanges(branch, () => "scope-x").map(change => change.content)).toEqual(["x changed"]);
		expect(findDeliveredRecallChanges(branch, () => "scope-y").map(change => change.content)).toEqual(["y changed"]);
		// A backend whose recall reads no recorded scope carries no report.
		expect(findDeliveredRecallChanges(branch, () => undefined)).toEqual([]);
	});
});
