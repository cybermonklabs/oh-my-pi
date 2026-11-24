/**
 * A session switch that fails after it moved the prompt for the target transcript puts the previous prompt back. A
 * restored transcript prompt that prompt kept for the transcript's live cache entry must come back with it: the
 * session never left its transcript, so its next request reads the same cache entry.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const ROLE = "You review the parser changes of this repository.";

describe("a session switch that fails after it moved the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the restored transcript prompt of the session it never left", async () => {
		using tempDir = TempDir.createSync("@pi-declhold-rollback-restored-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const sessionDir = tempDir.join("sessions");
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const options = (sessionManager: SessionManager, agentsMd: string) => ({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			// One-hour cache entries.
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			toolNames: ["read"],
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			const firstManager = SessionManager.create(tempDir.path(), sessionDir);
			const { session: firstProcess } = await createAgentSession(options(firstManager, "Build with make."));
			let sessionFile: string | undefined;
			try {
				await firstProcess.prompt("first");
				sessionFile = firstManager.getSessionFile();
			} finally {
				await firstProcess.dispose();
			}
			if (!sessionFile) throw new Error("Expected a persisted session");
			// The context file changed; a restarted process resumes the transcript and keeps its stored prompt for
			// the live cache entry.
			const { session } = await createAgentSession(
				options(await SessionManager.open(sessionFile), "Build with ninja."),
			);
			try {
				// Precondition: the stored prompt is restored.
				expect(session.systemPrompt.join("\n")).toContain("Build with make.");
				// Another session of the directory with no reply yet: switching to it rebuilds the prompt, then fails.
				const target = SessionManager.create(tempDir.path(), sessionDir);
				target.appendMessage({ role: "user", content: "Another task.", timestamp: Date.now() });
				await target.flush();
				const targetFile = target.getSessionFile();
				if (!targetFile) throw new Error("Expected the target session's file");
				vi.spyOn(SessionAdvisors.prototype, "restoreCost").mockImplementationOnce(() => {
					throw new Error("forced switch failure");
				});
				await expect(session.switchSession(targetFile)).rejects.toThrow("forced switch failure");
				await session.prompt("second");
			} finally {
				await session.dispose();
			}
			const [first, second] = gateway.requests;
			if (!first || !second) throw new Error("Expected two requests");
			// The session is back on its transcript: the request continues the cached prompt.
			expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		} finally {
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
