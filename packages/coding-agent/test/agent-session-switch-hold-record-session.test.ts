/**
 * A held settings change is recorded in the session whose bound prompt holds it (`system-prompt-hold`), and ended
 * there (`system-prompt-hold-end`) when it goes out with the prompt keeping its bytes. A switch to another session
 * carries the hold along, and it goes out in that session; neither record may be written to the session switched to,
 * whose prompt never held the change.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, gatewaySessionOptions, mockGatewayFetch } from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The hold records a session file holds, by type. */
async function holdRecords(sessionFile: string): Promise<string[]> {
	const manager = await SessionManager.open(sessionFile);
	return manager
		.getEntries()
		.flatMap(entry =>
			entry.type === "custom" && entry.customType.startsWith("system-prompt-hold") ? [entry.customType] : [],
		);
}

describe("hold records after a switch to another session", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes neither record to the session switched to", async () => {
		using tempDir = TempDir.createSync("@pi-switch-hold-record-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionDir = tempDir.join("sessions");
		const sessionManager = SessionManager.create(tempDir.path(), sessionDir);
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("First.");
			const sourceFile = sessionManager.getSessionFile();
			if (!sourceFile) throw new Error("Expected the session's file");
			// A change only the bash definition renders is held on the bound prompt and recorded with its start.
			const hold = vi.spyOn(session, "holdToolDeclarationChange");
			await Bun.write(overlay, `${LONG_ENTRIES}tools:\n  maxTimeout: 120\n`);
			await settings.reloadFromDisk();
			await Promise.resolve();
			await Promise.all(hold.mock.results.map(result => result.value));
			hold.mockRestore();
			await sessionManager.flush();
			// Precondition: the hold is recorded in the session whose prompt holds it.
			expect(await holdRecords(sourceFile)).toEqual(["system-prompt-hold"]);

			const target = SessionManager.create(tempDir.path(), sessionDir);
			target.appendMessage({ role: "user", content: "Another task.", timestamp: Date.now() });
			await target.flush();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected the target session's file");
			await session.switchSession(targetFile);
			// Nothing in the target is bound to the held prompt: the change goes out with its first request.
			await session.prompt("In the other session.");
			await session.sessionManager.flush();
			const [, inTarget] = gateway.requests;
			if (!inTarget) throw new Error("Expected the target session's request");
			expect(await holdRecords(targetFile)).toEqual([]);
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
