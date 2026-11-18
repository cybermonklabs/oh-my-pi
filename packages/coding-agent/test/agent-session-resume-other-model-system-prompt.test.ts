import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
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

/** The gateway's claude-opus-5-5 and claude-fable-5-2; both bind signed thinking to the prompt prefix. */
const MODELS_YML = `${gatewayModelsYml()}      - {id: claude-fable-5-2, name: Claude Fable 5.2, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

const ROLE = "You review the parser changes of this repository.";

describe("system prompt of a session resumed on another model", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) on `modelId`: sends each prompt, then exits. */
	async function runProcess(
		tempDir: TempDir,
		modelId: string,
		prompts: string[],
		sessionFile?: string,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", modelId);
		if (!model) throw new Error(`Expected the gateway's ${modelId}`);
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
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: "Build with make." }],
			skills: [],
		});
		try {
			for (const text of prompts) await session.prompt(text);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	// A resume onto another model (`--resume <id> --model <other>`) reads no cache entry of the transcript's model,
	// so the stored prompt buys nothing: the new model must get the prompt built for it, as a mid-session switch does.
	it("sends the prompt built for the model the session resumes on, not the transcript's model's", async () => {
		using tempDir = TempDir.createSync("@pi-resume-other-model-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const live = await runProcess(tempDir, "claude-opus-5-5", ["first"]);
		expect(withoutCacheControl(live.requests[0]?.system)).toContain("claude-opus-5-5");

		const resumed = await runProcess(tempDir, "claude-fable-5-2", ["second"], live.sessionFile);

		const system = withoutCacheControl(resumed.requests[0]?.system);
		expect(system).not.toContain("claude-opus-5-5");
		expect(system).toContain("claude-fable-5-2");
	}, 30_000);
});
