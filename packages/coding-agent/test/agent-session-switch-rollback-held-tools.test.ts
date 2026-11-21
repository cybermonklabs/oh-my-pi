/**
 * A settings change that turns a tool off on a bound prompt is held: the tool stays declared and its calls are refused
 * until the rebuild. On a resumed process that keeps its transcript's stored prompt, a switch to another session leaves
 * that prompt, and the rebuild for the target runs the held change. A switch that then fails puts the stored prompt and
 * the hold back; the tool set must come back with them, or the session keeps the tool set of a transcript it never
 * moved to.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

describe("a session switch that fails after its rebuild ran a held tool change", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps the tool set the session had before the switch", async () => {
		using tempDir = TempDir.createSync("@pi-switch-rollback-held-tools-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionDir = tempDir.join("sessions");
		const start = async (sessionManager: SessionManager, agentsMd: string) => {
			const settings = await Settings.loadIsolated({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				configFiles: [overlay],
			});
			const { session } = await createAgentSession({
				...gatewaySessionOptions(tempDir),
				sessionManager,
				authStorage,
				modelRegistry,
				settings,
				model,
				toolNames: ["read", "todo"],
				contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
				skills: [],
			});
			return { session, settings };
		};
		try {
			const firstManager = SessionManager.create(tempDir.path(), sessionDir);
			const { session: firstProcess } = await start(firstManager, "Build with make.");
			let sessionFile: string | undefined;
			try {
				await firstProcess.prompt("First.");
				sessionFile = firstManager.getSessionFile();
			} finally {
				await firstProcess.dispose();
			}
			if (!sessionFile) throw new Error("Expected a persisted session");
			// The context file changed; the resumed process keeps the stored prompt for the live cache entry.
			const { session, settings } = await start(await SessionManager.open(sessionFile), "Build with ninja.");
			try {
				// Turning `todo` off on the bound prompt is held: the tool stays declared until the rebuild.
				await reloadOverlay({ session, settings, overlay }, `${LONG_ENTRIES}todo:\n  enabled: false\n`, [
					"refreshBaseSystemPrompt",
					"reconcileBuiltinTools",
				]);
				const enabledBefore = session.getEnabledToolNames();
				// Preconditions: the stored prompt is kept and the change is held.
				expect(session.systemPrompt.join("\n")).toContain("Build with make.");
				expect(enabledBefore).toContain("todo");

				// Another session: switching to it leaves the stored prompt, rebuilds with the change, then fails.
				const target = SessionManager.create(tempDir.path(), sessionDir);
				target.appendMessage({ role: "user", content: "Another task.", timestamp: Date.now() });
				await target.flush();
				const targetFile = target.getSessionFile();
				if (!targetFile) throw new Error("Expected the target session's file");
				vi.spyOn(SessionAdvisors.prototype, "restoreCost").mockImplementationOnce(() => {
					throw new Error("forced switch failure");
				});
				await expect(session.switchSession(targetFile)).rejects.toThrow("forced switch failure");

				// The session never left its transcript: the tool set is the one it had, the change still held.
				expect(session.getEnabledToolNames()).toEqual(enabledBefore);
				await session.prompt("Second.");
			} finally {
				await session.dispose();
			}
			const [first, second] = gateway.requests;
			if (!first || !second) throw new Error("Expected two requests");
			expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
			expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		} finally {
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
