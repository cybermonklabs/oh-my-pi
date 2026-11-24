import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const ROLE = "You review the parser changes of this repository.";
/** Past the one-hour lifetime of the long-retention cache entry the transcript's replies wrote. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

describe("a restored transcript prompt once the transcript's cache entry has lapsed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** Moves the clock `offsetMs` ahead of real time from now on. */
	function advanceClock(offsetMs: number): void {
		const realNow = Date.now.bind(Date);
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
	}

	/**
	 * One process on the session file (a new session without one), with `agentsMd` as its context file: runs
	 * `between` before each prompt after the first, sends each prompt, then exits.
	 */
	async function runProcess(
		tempDir: TempDir,
		agentsMd: string,
		prompts: string[],
		sessionFile?: string,
		between?: (session: AgentSession) => void,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
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
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			for (const [index, text] of prompts.entries()) {
				if (index > 0) between?.(session);
				await session.prompt(text);
			}
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	// The stored prompt is kept so the first request after a restart reads the transcript's cache entry. Resumed
	// the next day, that entry is gone: the request writes the whole prompt either way, so the context file edited
	// since must reach the model, as it did before the restore existed.
	it("builds the prompt afresh when the session resumes after its cache entry lapsed", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-lapsed-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, "Build with make.", ["first"]);
		advanceClock(TWO_HOURS_MS);
		const resumed = await runProcess(tempDir, "Build with ninja.", ["second"], live.sessionFile);

		const system = withoutCacheControl(resumed.requests[0]?.system);
		expect(system).not.toContain("Build with make.");
		expect(system).toContain("Build with ninja.");
	}, 30_000);

	// Resumed within the lifetime, the stored prompt stands in for this process's own build. Once the entry lapses
	// the stand-in saves nothing, as a held settings rebuild runs at a lapse: the next request carries the edit.
	it("replaces the restored prompt with this process's own build once the cache entry lapses", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-lapsed-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, "Build with make.", ["first"]);
		const resumed = await runProcess(tempDir, "Build with ninja.", ["second", "third"], live.sessionFile, () =>
			advanceClock(TWO_HOURS_MS),
		);

		// Within the lifetime the restored prompt is sent, as designed.
		expect(withoutCacheControl(resumed.requests[0]?.system)).toContain("Build with make.");
		const afterLapse = withoutCacheControl(resumed.requests[1]?.system);
		expect(afterLapse).not.toContain("Build with make.");
		expect(afterLapse).toContain("Build with ninja.");
	}, 30_000);
});
