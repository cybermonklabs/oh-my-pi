/**
 * A session under Hindsight memory sends its first-turn recall as the system prompt's last block and records it with
 * the server, account, bank and tags it read. `fetch` reads `hindsight.apiUrl` as a URL, so a scheme or host in
 * capitals and a default port spelled out reach the server the plain spelling reaches; the request's headers drop the
 * whitespace around the API token, so a token read with a trailing newline (an env file) authenticates as the same
 * account. A process that resumes the session within its cache entry's life under either spelling, from a server that
 * recalls the same memories, must send the prompt the first process sent, byte for byte.
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
const HINDSIGHT_ORIGIN = "http://127.0.0.1";
/** What the bank recalls, for every query. */
const MEMORY = "The deploy host is alpha-7.";
/** The API token, as the first process reads it. */
const TOKEN = "not-a-secret";

/** How one process names the Hindsight server and its token. */
interface ServerSpelling {
	apiUrl: string;
	/** A YAML scalar. */
	apiToken: string;
}

const PLAIN: ServerSpelling = { apiUrl: HINDSIGHT_ORIGIN, apiToken: TOKEN };

/** The pods' `memory.yml` on one-hour cache entries, naming the server and token as `spelling` does. */
function podMemory(spelling: ServerSpelling): string {
	return `providers:
  cacheRetention: long
memory:
  backend: hindsight
hindsight:
  apiUrl: ${spelling.apiUrl}
  apiToken: ${spelling.apiToken}
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

describe("a resumed Hindsight session whose server or token is spelled another way", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) under `spelling`: runs `steps`. */
	async function runProcess(
		dir: TempDir,
		spelling: ServerSpelling,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("memory.yml");
		await Bun.write(overlay, podMemory(spelling));
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
		{
			change: "its scheme in capitals and the default port spelled out",
			resumed: { apiUrl: "HTTP://127.0.0.1:80", apiToken: TOKEN },
		},
		{
			change: "a token read with a trailing newline",
			resumed: { apiUrl: HINDSIGHT_ORIGIN, apiToken: `"${TOKEN}\\n"` },
		},
	])(
		"keeps the cached prompt when the resumed process reads the server with $change",
		async ({ resumed: resumedSpelling }) => {
			using dir = TempDir.createSync("@pi-resumed-recall-server-spelling-");
			await Bun.write(dir.join("models.yml"), gatewayModelsYml());
			setClock(0);
			const live = await runProcess(dir, PLAIN, undefined, async session => {
				await session.prompt("first");
			});
			// The session is resumed two minutes on: its one-hour cache entry is live.
			setClock(2 * 60_000);
			const resumed = await runProcess(dir, resumedSpelling, live.sessionFile, async session => {
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
