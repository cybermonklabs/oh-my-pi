/**
 * A session under Hindsight memory sends its first-turn recall as the system prompt's last block, and records it for
 * the bank it read. Hindsight reuses a recorded recall only for the same server, bank and tags. When the
 * configuration names another bank before the session is resumed, long after its cache entry lapsed, the resumed
 * process recalls from the new bank: the old bank's memories must not ride every request of the resumed process as
 * well, as they do not at the release.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

/** The pods' `memory.yml` on one-hour cache entries, its server the test's, reading `bank`. */
function podMemory(bank: string): string {
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

const HOUR_MS = 60 * 60_000;

describe("a resumed Hindsight session whose configuration names another bank", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) reading `bank`: runs `steps`, then exits. */
	async function runProcess(
		dir: TempDir,
		bank: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("memory.yml");
		await Bun.write(overlay, podMemory(bank));
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

	it("sends none of the old bank's recall once the new bank's recall replaced it", async () => {
		using dir = TempDir.createSync("@pi-resumed-recall-other-bank-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const live = await runProcess(dir, "fleet-bank", undefined, async session => {
			await session.prompt("first");
		});
		// The configuration moves to another bank; the session is resumed three hours on, its one-hour entry lapsed.
		setClock(3 * HOUR_MS);
		const resumed = await runProcess(dir, "other-bank", live.sessionFile, async session => {
			await session.prompt("second");
			await session.prompt("third");
		});

		const [first] = live.requests;
		const [second, third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Preconditions: the first process sent the old bank's recall as a block once, and the resumed process
		// recalled from the new bank and sends that recall once.
		expect(copiesIn(first.system, MEMORIES["fleet-bank"])).toBe(1);
		expect(copiesIn(second, MEMORIES["other-bank"])).toBe(1);

		// The old bank's recall is not the conversation's recall any more: no request of the resumed process sends it.
		expect(copiesIn(second, MEMORIES["fleet-bank"])).toBe(0);
		expect(copiesIn(third, MEMORIES["fleet-bank"])).toBe(0);
	}, 60_000);

	it("reuses the recorded recall when the bank is the same (control)", async () => {
		using dir = TempDir.createSync("@pi-resumed-recall-other-bank-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const live = await runProcess(dir, "fleet-bank", undefined, async session => {
			await session.prompt("first");
		});
		setClock(3 * HOUR_MS);
		const resumed = await runProcess(dir, "fleet-bank", live.sessionFile, async session => {
			await session.prompt("second");
		});

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		expect(copiesIn(second.system, MEMORIES["fleet-bank"])).toBe(1);
		expect(copiesIn(second, MEMORIES["other-bank"])).toBe(0);
	}, 60_000);
});
