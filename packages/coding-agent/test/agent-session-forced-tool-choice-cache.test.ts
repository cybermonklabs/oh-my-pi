/**
 * A staged preview asks the model to resolve it with `write`; when the model calls another tool, the agent loop forces
 * `write` for one turn. Anthropic keys the cached messages on `tool_choice`, so on a model that takes a forced choice
 * that turn writes messages the next request, back on the default choice, does not read, and refreshes none of the
 * entry the turn before it left: the entry the session tracks (its status, what the warmer keeps warm) must stay that
 * one. A model that takes no forced choice gets the turn with `auto`, which reads and extends the entry as any turn does.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { answer, GATEWAY, gatewaySessionOptions, mockGatewayFetch, toolCallAnswer } from "./helpers/anthropic-gateway";

const MINUTE_MS = 60_000;

/** The gateway's `models.yml` with `id` on its card. */
function modelsYml(id: string, name: string): string {
	return `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: ${id}, name: ${name}, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;
}

describe("a turn the agent loop forces to resolve a staged preview", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{
			row: "keeps the entry of the turn before it on a model that takes a forced choice",
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			forced: true,
		},
		{
			row: "is tracked as any turn on a model that sends it with auto (claude-opus-5-5)",
			id: "claude-opus-5-5",
			name: "Claude Opus 5.5",
			forced: false,
		},
	])(
		"$row",
		async ({ id, name, forced }) => {
			using tempDir = TempDir.createSync("@pi-forced-tool-choice-cache-");
			await Bun.write(tempDir.join("models.yml"), modelsYml(id, name));
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			// When each request went out; the clock moves a minute after each.
			const sentAt: number[] = [];
			let session: AgentSession | undefined;
			let statusAtThird: PromptCacheStatus | undefined;
			const { requests, restore } = mockGatewayFetch(turn => {
				sentAt.push(now);
				now += MINUTE_MS;
				const usage = { cacheWriteTokens: 100 };
				// The model calls `read` instead of resolving the preview, which forces `write` on the next turn.
				if (turn === 1) return toolCallAnswer(turn, "read", { path: "README.md" }, usage);
				// The forced turn: the preview is resolved meanwhile, so the turn after it is back on the default choice.
				if (turn === 2) session?.toolChoiceQueue.clearPendingInvokers();
				if (turn === 3) statusAtThird = session?.getPromptCacheStatus();
				return answer(turn, usage);
			});
			const authStorage = createInMemoryAuthStorage();
			try {
				const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
				const model = modelRegistry.find("anthropic", id);
				if (!model) throw new Error(`Expected the gateway's ${id}`);
				// Precondition: the model takes a forced choice, or the provider sends it as auto.
				expect(model.compat).toMatchObject({ supportsForcedToolChoice: forced });
				({ session } = await createAgentSession({
					...gatewaySessionOptions(tempDir),
					sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
					authStorage,
					modelRegistry,
					settings: Settings.isolated({ "providers.cacheRetention": "long" }),
					model,
					toolNames: ["read", "write"],
					contextFiles: [],
					skills: [],
				}));
				try {
					// A staged preview the model is asked to resolve with a `write` to xd://resolve.
					session.toolChoiceQueue.registerPendingInvoker("preview-1", "ast_edit", () => "applied");
					await session.prompt("apply the staged edit");
				} finally {
					await session.dispose();
				}
			} finally {
				authStorage.close();
				restore();
			}

			const [first, second, third] = requests as unknown as Record<string, unknown>[];
			if (!first || !second || !third) throw new Error("Expected three requests");
			// Preconditions: only the second request carries a tool choice, forced or sent as auto.
			expect(first.tool_choice).toBeUndefined();
			expect(second.tool_choice).toEqual(forced ? { type: "tool", name: "write" } : { type: "auto" });
			expect(third.tool_choice).toBeUndefined();

			// The third request reads the entry the first one left, or the one the second one refreshed.
			expect(statusAtThird).toMatchObject({ state: "warm", touchedAt: forced ? sentAt[0] : sentAt[1] });
		},
		60_000,
	);
});
