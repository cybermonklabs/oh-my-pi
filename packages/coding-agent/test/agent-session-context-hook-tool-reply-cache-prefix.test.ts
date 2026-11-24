import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	streamedAnswer,
} from "./helpers/anthropic-gateway";

/** Indexes of the messages that carry a cache breakpoint. */
function messageBreakpoints(request: MessagesRequest): number[] {
	return request.messages.flatMap((message, index) =>
		Array.isArray(message.content) &&
		message.content.some(
			block =>
				typeof block === "object" && block !== null && "cache_control" in block && block.cache_control != null,
		)
			? [index]
			: [],
	);
}

describe("a context hook that changes nothing, in a conversation that calls tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One session, with `extension` when given: the first reply reads a file, every later one answers in text. */
	async function run(tempDir: TempDir, extension: ExtensionFactory | undefined): Promise<MessagesRequest[]> {
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(modelsPath, gatewayModelsYml());
		await Bun.write(tempDir.join("notes.txt"), "hello");
		const { requests, restore } = mockGatewayFetch(turn =>
			turn === 1
				? streamedAnswer(
						turn,
						{ type: "tool_use", id: "toolu_1", name: "read", input: {} },
						[{ type: "input_json_delta", partial_json: JSON.stringify({ path: tempDir.join("notes.txt") }) }],
						"tool_use",
					)
				: answer(turn),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			toolNames: ["read"],
			extensions: extension ? [extension] : [],
			skills: [],
			contextFiles: [],
		});
		try {
			await session.prompt("first");
			await session.prompt("second");
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
		return requests;
	}

	it("leaves the breakpoints of the request after a tool call where they are without the hook", async () => {
		using hookDir = TempDir.createSync("@pi-context-hook-tool-reply-");
		const hooked = await run(hookDir, pi => {
			pi.on("context", () => undefined);
		});
		using plainDir = TempDir.createSync("@pi-context-hook-tool-reply-");
		const plain = await run(plainDir, undefined);
		expect(hooked).toHaveLength(3);
		expect(plain).toHaveLength(3);
		// The request that sends the tool result replays the tool-call reply the hook left untouched: it is history,
		// so the second rolling breakpoint stays on it instead of moving to the head of the conversation.
		expect(hooked.map(messageBreakpoints)).toEqual(plain.map(messageBreakpoints));
	}, 30_000);
});
