import { describe, expect, it } from "bun:test";
import type { Api, Model, ModelSpec, OpenAICompat } from "@oh-my-pi/pi-ai";
import { NO_STRICT } from "@oh-my-pi/pi-ai/utils/schema/adapt";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Agent } from "../src/agent";
import { normalizeTools } from "../src/agent-loop";
import { toolSpecsFingerprint } from "../src/append-only-context";
import type { AgentTool } from "../src/types";

/**
 * A process that resumes a transcript an earlier release wrote compares that release's declared-tools fingerprint
 * with its own. Earlier releases hashed the normalized tools as they are on an OpenAI API; under default settings
 * (`PI_NO_STRICT` unset, no strict-tools fallback) the fingerprint must stay that hash, or every OpenAI session resumed
 * across the upgrade reads as cold and drops its stored prompt.
 */

function tool(name: string, parameters: Record<string, unknown>, strict?: boolean): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: parameters as AgentTool["parameters"],
		...(strict === undefined ? {} : { strict }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

const pathSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
// Strict mode cannot enforce a property with no type: under `all_strict` chat completions then sends no tool strict.
const looseSchema = { type: "object", properties: { value: {} }, required: ["value"] };
const tools = [
	tool("plain", pathSchema),
	tool("marked", pathSchema, true),
	tool("unmarked", pathSchema, false),
	tool("loose", looseSchema),
];

function model(api: Api, provider: string, baseUrl: string, compat?: OpenAICompat): Model {
	return buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(compat ? { compat } : {}),
	} as ModelSpec<Api>);
}

const GATEWAY = "https://gateway.example.test/v1";

describe("Agent.declaredToolsFingerprint on an OpenAI API under default settings", () => {
	it.each([
		["chat completions, mixed", model("openai-completions", "gateway", GATEWAY, { supportsStrictMode: true })],
		[
			"chat completions, all_strict",
			model("openai-completions", "gateway", GATEWAY, { supportsStrictMode: true, toolStrictMode: "all_strict" }),
		],
		["chat completions, no strict support", model("openai-completions", "gateway", GATEWAY)],
		["Responses", model("openai-responses", "openai", "https://api.openai.com/v1")],
		["Codex", model("openai-codex-responses", "openai-codex", "https://chatgpt.com/backend-api")],
		["OpenRouter", model("openrouter", "openrouter", "https://openrouter.ai/api/v1")],
	])("is the hash earlier releases take on %s", (_api, openAIModel) => {
		// Precondition: the process runs under default settings.
		expect(NO_STRICT).toBe(false);
		const agent = new Agent({ initialState: { model: openAIModel, systemPrompt: [], tools, messages: [] } });

		// What earlier releases' `declaredToolsFingerprint` returns for a model off Anthropic's messages API.
		const before = toolSpecsFingerprint(normalizeTools(tools, { injectIntent: false }) ?? []);
		expect(agent.declaredToolsFingerprint(openAIModel)).toBe(before);
	});
});
