/**
 * Contract: an assistant turn whose signed thinking held a secret is stored
 * unsigned with the marker, so a session resumed from the store never sends a
 * signature over altered text. To an endpoint that takes no unsigned thinking
 * (`replayUnsignedThinking: false`, as models.yml can set), pi-ai's Anthropic
 * converter sends that thinking as text, and the request holds the marker, not
 * the value.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const ENV_VALUE = "zq9-synthetic-service-4821";
const ENV_MARKER = "[REDACTED:env:SERVICE_API_KEY]";
const NOW = 1_700_000_000_000;

const thought = (value: string): string => `the service key is ${value}`;

const model = buildModel({
	api: "anthropic-messages",
	provider: "custom-anthropic",
	id: "reasoning-model",
	name: "Reasoning Anthropic-Compatible Model",
	baseUrl: "https://llm.example.com/anthropic",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 8_192,
	contextWindow: 200_000,
	reasoning: true,
	compat: { replayUnsignedThinking: false },
});

let tmp: TempDir;
let cwd: string;

beforeEach(async () => {
	tmp = TempDir.createSync("@omp-session-store-masking-replay-");
	cwd = tmp.join("project");
	await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tmp.remove();
});

/** A turn of `model` whose signed thinking holds `ENV_VALUE`. */
function signedTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: thought(ENV_VALUE), thinkingSignature: "opaque-thinking-signature" },
			{ type: "text", text: "Configured." },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		stopReason: "stop",
		timestamp: NOW,
	};
}

describe("session store masking of signed thinking on replay", () => {
	it("sends the resumed turn's thinking as text holding the marker, with no unsigned thinking block", async () => {
		// The process masker holds the test's variable, never this machine's environment.
		spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
			new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: ENV_VALUE }), agentDir: tmp.join("agent") }),
		);
		const sessionDir = tmp.join("sessions");
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(cwd, sessionDir, storage);
		// The session's setting is on.
		manager.setStoreMasking({ enabled: () => true, agentDir: tmp.join("agent") });
		await manager.ensureOnDisk();
		manager.appendMessage({ role: "user", content: "configure the service", timestamp: NOW });
		manager.appendMessage(signedTurn());
		await manager.flush();
		await storage.drain();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		await manager.close();

		const resumed = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage());
		const history = resumed.buildSessionContext().messages;
		await resumed.close();
		const resumedTurn = history.find(message => message.role === "assistant");
		expect(resumedTurn?.role === "assistant" && resumedTurn.content).toEqual([
			{ type: "thinking", thinking: thought(ENV_MARKER) },
			{ type: "text", text: "Configured." },
		]);

		const request = convertAnthropicMessages(
			[...convertToLlm(history), { role: "user", content: "now restart it", timestamp: NOW }],
			model,
			false,
		);
		const sent = request.find(param => param.role === "assistant");
		if (!sent || typeof sent.content === "string") throw new Error("Expected the resumed turn as content blocks");
		expect(sent.content.filter(block => block.type === "thinking")).toEqual([]);
		expect(sent.content.some(block => block.type === "text" && block.text.includes(thought(ENV_MARKER)))).toBe(true);
		expect(JSON.stringify(request).includes(ENV_VALUE)).toBe(false);
	});
});
