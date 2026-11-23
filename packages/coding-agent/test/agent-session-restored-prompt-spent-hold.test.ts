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

/** One-hour cache entries, so requests minutes apart keep them warm. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

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

interface ProcessStep {
	session: AgentSession;
	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the hold it starts. */
	reload(content: string): Promise<void>;
}

// A `tools.maxTimeout` change renders only into the bash definition. Held on the bound prompt, it is recorded on the
// branch (`system-prompt-hold`, with its start); five minutes on the rebuild sends it, and the system prompt comes out
// with the same bytes, so the branch records no other prompt after the hold. A later restart that restores that
// prompt for its live cache entry withholds a change of its own, made at the restart; the old, already sent change
// must not make it look five minutes old.
describe("a restored transcript prompt after a held tool definition change went out", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one), with `agentsMd` as its context file. */
	async function runProcess(
		tempDir: TempDir,
		agentsMd: string,
		sessionFile: string | undefined,
		steps: (step: ProcessStep) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string; holds: unknown[] }> {
		const overlay = tempDir.join("overlay.yml");
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
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
			settings,
			model,
			toolNames: ["read", "bash"],
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		const reload = async (content: string): Promise<void> => {
			const spy = vi.spyOn(session, "holdToolDeclarationChange");
			await Bun.write(overlay, content);
			await settings.reloadFromDisk();
			await Promise.resolve();
			await Promise.all(spy.mock.results.map(result => result.value));
			spy.mockRestore();
		};
		try {
			await steps({ session, reload });
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			const holds = sessionManager
				.getEntries()
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

	it("keeps the stored prompt at the first request after a restart a few minutes later", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-spent-hold-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		await Bun.write(tempDir.join("overlay.yml"), LONG_ENTRIES);
		const live = await runProcess(tempDir, "Build with make.", undefined, async ({ session, reload }) => {
			setClock(0);
			await session.prompt("first");
			await reload(`${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`);
			setClock(MINUTE_MS);
			await session.prompt("second");
			setClock(6 * MINUTE_MS);
			await session.prompt("third");
		});
		// The context file changed; at minute 8, two minutes after the last reply wrote its one-hour entry, a process
		// on the same settings resumes the transcript.
		setClock(8 * MINUTE_MS);
		const restarted = await runProcess(tempDir, "Build with ninja.", live.sessionFile, async ({ session }) => {
			await session.prompt("fourth");
		});

		const [first, second, third] = live.requests;
		if (!first || !second || !third) throw new Error("Expected three requests of the first process");
		// Preconditions: the change was held, recorded, and went out five minutes on with the system prompt as it was.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(live.holds).toEqual([{ digest: expect.any(String), since: expect.any(Number) }]);
		expect(withoutCacheControl(third.tools)).not.toBe(withoutCacheControl(first.tools));
		expect(systemOf(third)).toBe(systemOf(first));
		// The restarted process keeps the stored prompt for the live entry: its own change is minutes from due.
		const resumed = systemOf(restarted.requests[0]);
		expect(resumed).toContain("Build with make.");
		expect(resumed).not.toContain("Build with ninja.");
	}, 60_000);
});
