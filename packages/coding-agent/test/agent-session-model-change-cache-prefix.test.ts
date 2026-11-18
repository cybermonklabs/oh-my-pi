import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** The gateway's claude-opus-5-5 and the claude-fable-5-2 a model fallback switches to. */
const MODELS_YML = `${gatewayModelsYml()}      - {id: claude-fable-5-2, name: Claude Fable 5.2, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

describe("system prompt after a model change on a prefix-bound model", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the first request on the new model with the prompt rebuilt for it", async () => {
		using tempDir = TempDir.createSync("@pi-model-change-cache-prefix-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const registryMutation = Promise.withResolvers<void>();
		// The rebuild for the new model waits for a registry mutation in flight; a request it did not wait for lets it go.
		const gateway = mockGatewayFetch(turn => {
			if (turn === 2) registryMutation.resolve();
			return answer(turn);
		});
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const opus = modelRegistry.find("anthropic", "claude-opus-5-5");
		const fable = modelRegistry.find("anthropic", "claude-fable-5-2");
		if (!opus || !fable) throw new Error("Expected the gateway's claude-opus-5-5 and claude-fable-5-2");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model: opus,
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			// An extension's turn-end handler switches the model (a model fallback after a refusal) while the next
			// prompt is on its way, and the prompt rebuild for the new model is still running when that prompt starts.
			void session.runToolRegistryMutation(() => registryMutation.promise);
			const modelChanged = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (event.type === "model_changed") modelChanged.resolve();
			});
			const switched = session.setModel(fable);
			await modelChanged.promise;
			unsubscribe();
			// A request that waits for the rebuild emits nothing until it is sent, so only a timer can end the mutation
			// the rebuild waits behind; a request that does not wait ends it as it is sent.
			void Bun.sleep(1_000).then(() => registryMutation.resolve());
			await session.prompt("second");
			await switched;
			await session.prompt("third");

			const [, second, third] = gateway.requests;
			if (!second || !third) throw new Error("Expected three requests");
			expect(withoutCacheControl(third.system)).toContain("claude-fable-5-2");
			// The model change ended the cached prompt's span; the second request on the new model reads all of the first.
			expect(continuesCachedPrompt(second, third)).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 30_000);
});
