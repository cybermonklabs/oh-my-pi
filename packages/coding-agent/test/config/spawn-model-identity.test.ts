/**
 * A revive turns the model identity a subagent's spawn spec stores back into the model the spawn
 * started on, for every kind of model a spawn can start on.
 */
import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import {
	formatModelStringWithRouting,
	resolveExactModelIdentity,
	resolveModelOverride,
	resolveSpawnModelIdentity,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";

const models: Model<Api>[] = [
	buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "z-ai/glm-4.7",
		name: "GLM 4.7",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: DEFAULT_MODEL_PER_PROVIDER["amazon-bedrock"],
		name: "Claude Opus (US)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	}),
];

/** The model the spawn's resolver starts a subagent on for `pattern`, with every provider credentialed. */
function spawnedModel(pattern: string): Model<Api> {
	const { model } = resolveModelOverride([pattern], { getAvailable: () => models });
	if (!model) throw new Error(`${pattern} resolved to no model`);
	return model;
}

describe("resolveSpawnModelIdentity", () => {
	// Each kind is rebuilt from its identity alone: the spawn spec stores no field beside `model` for any of them.
	test.each([
		["a catalog model", "anthropic/claude-sonnet-4-5"],
		["an @upstream pin", "openrouter/z-ai/glm-4.7@cerebras"],
		["an OpenRouter requested-id clone", "openrouter/z-ai/glm-4.7-20251222:nitro"],
		[
			"a Bedrock inference-profile model",
			"amazon-bedrock/arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48",
		],
	])("rebuilds %s from the identity the spawn stored", (_kind, pattern) => {
		const model = spawnedModel(pattern);
		const identity = formatModelStringWithRouting(model);

		const revived = resolveSpawnModelIdentity(identity, { getAll: () => models });

		expect(revived).toEqual(model);
		expect(revived && formatModelStringWithRouting(revived)).toBe(identity);
	});

	test("rebuilds a model whose provider has no credentials at the revive", () => {
		const model = spawnedModel("anthropic/claude-sonnet-4-5");
		const identity = formatModelStringWithRouting(model);
		const uncredentialed = { getAll: () => models, getAvailable: (): Model<Api>[] => [] };

		expect(resolveExactModelIdentity(identity, uncredentialed)).toBeUndefined();
		expect(resolveSpawnModelIdentity(identity, uncredentialed)).toEqual(model);
	});

	test.each([
		["a model id", "anthropic/claude-retired-1"],
		["the base of an @upstream pin", "openrouter/z-ai/retired-model@cerebras"],
	])("resolves to nothing when the registry no longer holds %s", (_missing, identity) => {
		expect(resolveSpawnModelIdentity(identity, { getAll: () => models })).toBeUndefined();
	});
});
