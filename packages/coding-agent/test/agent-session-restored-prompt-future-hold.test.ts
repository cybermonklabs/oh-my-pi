import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

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

// The branch records when a change the restored prompt withholds began (`system-prompt-hold`), in the clock of the
// process that wrote it. A clock set back since (an NTP correction, a transcript moved from a machine whose clock ran
// fast) leaves that time in the future: the change still goes out within five minutes of this process's restore, not
// five minutes after a moment this process has not reached.
describe("a restored transcript prompt whose recorded change lies in the future", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one), with `agentsMd` as its context file. */
	async function runProcess(
		tempDir: TempDir,
		agentsMd: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string; holds: unknown[] }> {
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
			// One-hour cache entries, so requests a minute apart keep them warm.
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			toolNames: ["read"],
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			await steps(session);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			const holds = sessionManager
				.getBranchView()
				.flatMap(entry =>
					entry.type === "custom" && entry.customType === "system-prompt-hold" ? [entry.data] : [],
				);
			return { requests, sessionFile: file, holds };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	it("sends this process's own build at the first request five minutes after its restore", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-future-hold-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, "Build with make.", undefined, async session => {
			await session.prompt("first");
		});
		// The context file changed; a process whose clock runs 30 minutes fast resumes the transcript, keeps its stored
		// prompt for the live cache entry and records when that began, by its clock.
		setClock(30 * MINUTE_MS);
		const fastClock = await runProcess(tempDir, "Build with ninja.", live.sessionFile, async session => {
			await session.prompt("run the parser tests");
		});
		// The clock is corrected. At minute 1 of the real clock a process resumes the transcript and sends a prompt
		// every minute, which keeps the one-hour entry warm.
		setClock(MINUTE_MS);
		const restarted = await runProcess(tempDir, "Build with ninja.", fastClock.sessionFile, async session => {
			for (let minute = 1; minute <= 6; minute++) {
				setClock(minute * MINUTE_MS);
				await session.prompt(`a call at minute ${minute}`);
			}
		});

		const stored = systemOf(live.requests[0]);
		// Precondition: the fast process withheld the edited context file and recorded a start ahead of the real clock.
		expect(systemOf(fastClock.requests[0])).toBe(stored);
		expect(fastClock.holds).toEqual([{ digest: expect.any(String), since: expect.any(Number) }]);
		const [{ since }] = fastClock.holds as [{ since: number }];
		expect(since).toBeGreaterThan(realNow() + 20 * MINUTE_MS);
		// The request at minute 6, five minutes after this process restored the stored prompt, sends its own build.
		const atBound = systemOf(restarted.requests[5]);
		expect(atBound).toContain("Build with ninja.");
		expect(atBound).not.toContain("Build with make.");
	}, 60_000);
});
