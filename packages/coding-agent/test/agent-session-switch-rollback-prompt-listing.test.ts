/**
 * A session switch that rebuilt the prompt for the target transcript and then failed puts the previous prompt back.
 * The roster notice must then compare against what that prompt lists, so a tool change it keeps out of its bytes still
 * reaches the model.
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
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const NOTICE = "No longer available: bash";

/** How many times `request`'s messages carry `text`. */
function copies(request: MessagesRequest, text: string): number {
	return withoutCacheControl(request.messages).split(text).length - 1;
}

describe("a session switch that fails after it rebuilt the prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("restores what the previous prompt lists with it, so the held roster change is still announced", async () => {
		using tempDir = TempDir.createSync("@pi-switch-rollback-listing-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(1_000_000));
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionDir = tempDir.join("sessions");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), sessionDir),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
			model,
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		try {
			// MCP discovery (no servers here) commits a rebuilt prompt before the first reply, as in a session with MCP
			// servers configured.
			await session.refreshMCPTools([]);
			await session.prompt("First.");
			// The reply bound the prompt, which keeps listing bash: the next request tells the model it is gone.
			await session.setActiveToolsByName(["read"]);

			// Another session with no reply yet: switching to it rebuilds the prompt for its tools, then fails.
			const target = SessionManager.create(tempDir.path(), sessionDir);
			target.appendMessage({ role: "user", content: "Another task.", timestamp: Date.now() });
			await target.flush();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected the target session's file");
			vi.spyOn(SessionAdvisors.prototype, "restoreCost").mockImplementationOnce(() => {
				throw new Error("forced switch failure");
			});
			await expect(session.switchSession(targetFile)).rejects.toThrow("forced switch failure");

			await session.prompt("Second.");
			const [first, second] = gateway.requests;
			if (!first || !second) throw new Error("Expected two requests");
			// The previous prompt is back, still listing bash, and the request tells the model bash is gone.
			expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
			expect(copies(second, NOTICE)).toBe(1);
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 30_000);
});
