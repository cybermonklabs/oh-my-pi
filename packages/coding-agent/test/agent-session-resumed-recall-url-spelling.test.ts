/**
 * A session under Hindsight memory sends its first-turn recall as the system prompt's last block and records it with
 * the server, bank and tags it read. The Hindsight client strips a trailing slash from `hindsight.apiUrl`, so
 * `http://host:port` and `http://host:port/` reach the same server and read the same bank. A process that resumes the
 * session within its cache entry's life under the second spelling, from a server that recalls the same memories, must
 * send the prompt the first process sent, byte for byte, as it does at the release.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, setClock } from "./helpers/agent-session-setup";
import {
	continuesCachedPrompt,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockHindsightGatewayFetch,
} from "./helpers/anthropic-gateway";

/** The Hindsight server; the `fetch` spy answers it, so no request leaves the process. */
const HINDSIGHT_ORIGIN = "http://127.0.0.1:1";
/** What the bank recalls, for every query. */
const MEMORY = "The deploy host is alpha-7.";

/** The pods' `memory.yml` on one-hour cache entries, its server named as `apiUrl`. */
function podMemory(apiUrl: string): string {
	return `providers:
  cacheRetention: long
memory:
  backend: hindsight
hindsight:
  apiUrl: ${apiUrl}
  bankId: fleet-bank
  scoping: per-project-tagged
  recallTypes: [world, experience, observation]
  recallMaxTokens: 2000
  retainMode: last-turn
  retainEveryNTurns: 1
  retainOverlapTurns: 0
  mentalModelsEnabled: false
`;
}

describe("a resumed Hindsight session whose server URL gained a trailing slash", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) naming the server as `apiUrl`: runs `steps`. */
	async function runProcess(
		dir: TempDir,
		apiUrl: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("memory.yml");
		await Bun.write(overlay, podMemory(apiUrl));
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const gateway = mockHindsightGatewayFetch([{ id: "m1", text: MEMORY, type: "world" }], {
			origin: HINDSIGHT_ORIGIN,
		});
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
			return { requests: gateway.requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}

	it.each([
		{ spelling: "with a trailing slash", resumedUrl: `${HINDSIGHT_ORIGIN}/` },
		{ spelling: "as before (control)", resumedUrl: HINDSIGHT_ORIGIN },
	])(
		"keeps the cached prompt when the resumed process names the server $spelling",
		async ({ resumedUrl }) => {
			using dir = TempDir.createSync("@pi-resumed-recall-url-spelling-");
			await Bun.write(dir.join("models.yml"), gatewayModelsYml());
			setClock(0);
			const live = await runProcess(dir, HINDSIGHT_ORIGIN, undefined, async session => {
				await session.prompt("first");
			});
			// The session is resumed two minutes on: its one-hour cache entry is live.
			setClock(2 * 60_000);
			const resumed = await runProcess(dir, resumedUrl, live.sessionFile, async session => {
				await session.prompt("second");
			});

			const [first] = live.requests;
			const [second] = resumed.requests;
			if (!first || !second) throw new Error("Expected the two processes' requests");
			// Preconditions: the first process sent the recall as the prompt's block, and the resumed process sends it once.
			expect(copiesIn(first.system, MEMORY)).toBe(1);
			expect(copiesIn(second, MEMORY)).toBe(1);

			expect({
				continues: continuesCachedPrompt(first, second),
				blockRecall: copiesIn(second.system, MEMORY),
			}).toEqual({
				continues: true,
				blockRecall: 1,
			});
		},
		60_000,
	);
});
