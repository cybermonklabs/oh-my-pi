/**
 * A session under Hindsight memory as the agent fleet's pods run it (`memory.yml`: recall and retain on, mental models off)
 * sends its first-turn recall as a system block after the base prompt. A process that resumes the session while its
 * cache entry is warm sends that stored prompt again, and its first prompt reuses the recall the transcript recorded.
 * Nothing changed but the restart: the prompt must stay as cached for as long as the entry lives, as it does at the
 * release, not be rewritten five minutes after the resume.
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
	continuesCachedPrompt,
	copiesIn,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The Hindsight server the settings name; the `fetch` spy answers it, so no request leaves the process. */
const HINDSIGHT_URL = "http://127.0.0.1:1";

/** The one memory the bank recalls. */
const MEMORY = "The deploy host is alpha-7.";

/** The pods' `memory.yml` on one-hour cache entries, its server the test's. */
const POD_MEMORY = `providers:
  cacheRetention: long
memory:
  backend: hindsight
hindsight:
  apiUrl: ${HINDSIGHT_URL}
  bankId: fleet-bank
  scoping: per-project-tagged
  recallTypes: [world, experience, observation]
  recallMaxTokens: 2000
  retainMode: last-turn
  retainEveryNTurns: 1
  retainOverlapTurns: 0
  mentalModelsEnabled: false
`;

const MINUTE_MS = 60_000;

describe("a resumed session under the pods' Hindsight memory that reuses its first-turn recall", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one): runs `steps`, then exits. */
	async function runProcess(
		dir: TempDir,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("memory.yml");
		await Bun.write(overlay, POD_MEMORY);
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
				if (url.pathname.endsWith("/memories/recall")) {
					return Response.json({ results: [{ id: "m1", text: MEMORY, type: "world" }] });
				}
				const bank = /^\/v1\/default\/banks\/([^/]+)$/.exec(url.pathname);
				if (bank) return Response.json({ bank_id: decodeURIComponent(bank[1]) });
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

	it("keeps the cached prompt past five minutes after the resume", async () => {
		using dir = TempDir.createSync("@pi-resumed-recall-prompt-kept-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const live = await runProcess(dir, undefined, async session => {
			await session.prompt("first");
		});
		// The pod restarts at once; the resumed process answers twice, the second time six minutes on, well inside
		// the one-hour entry.
		const resumed = await runProcess(dir, live.sessionFile, async session => {
			await session.prompt("second");
			setClock(6 * MINUTE_MS);
			await session.prompt("third");
		});

		const [first] = live.requests;
		const [second, third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Preconditions: the first-turn recall went out in the system prompt once, and the resumed process sent the
		// prompt the transcript was sent with.
		expect(copiesIn(first.system, MEMORY)).toBe(1);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(continuesCachedPrompt(first, second)).toBe(true);

		// Nothing changed since: the request six minutes on reads the whole cached prompt.
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(second.system));
		expect(continuesCachedPrompt(second, third)).toBe(true);
	}, 60_000);
});
