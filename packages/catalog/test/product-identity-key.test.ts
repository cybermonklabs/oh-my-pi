import { describe, expect, test } from "bun:test";
import { classifyModel } from "../src/compat/taxonomy";
import { productIdentityKey } from "../src/identity/product";

/** Builds `provider/id` from its catalog identity and returns its product key. */
function keyOf(model: string, requestModelId?: string): string | undefined {
	const slash = model.indexOf("/");
	const provider = model.slice(0, slash);
	const id = model.slice(slash + 1);
	return productIdentityKey({ provider, id, identity: classifyModel(provider, id), requestModelId });
}

function expectOneKey(base: string, others: readonly string[]): void {
	const baseKey = keyOf(base);
	expect(baseKey).toBeDefined();
	for (const other of others) {
		expect({ model: other, key: keyOf(other) }).toEqual({ model: other, key: baseKey });
	}
}

function expectSeparateKeys(models: readonly string[]): void {
	const keys = models.map(model => keyOf(model));
	expect(keys).not.toContain(undefined);
	expect(new Set(keys).size).toBe(models.length);
}

describe("productIdentityKey", () => {
	test("builds the key from the class, family, revision and product words", () => {
		expect(keyOf("anthropic/claude-opus-4-8")).toBe("anthropic/opus/4.8.0/");
		expect(keyOf("openai/gpt-5.6-sol")).toBe("openai/gpt/5.6.0/sol");
	});

	test("gives Claude Opus 4.8 one key under every provider's spelling", () => {
		expectOneKey("anthropic/claude-opus-4-8", [
			"google-vertex/claude-opus-4-8@default",
			"amazon-bedrock/us.anthropic.claude-opus-4-8",
			"amazon-bedrock/us-gov.anthropic.claude-opus-4-8",
			"github-copilot/claude-opus-4.8",
			"cursor/claude-opus-4-8-high",
			"nanogpt/anthropic/claude-opus-4.8:thinking",
		]);
	});

	test("gives Claude Sonnet 4.5 one key in Cursor's and Bedrock's spellings", () => {
		expectOneKey("anthropic/claude-sonnet-4-5", [
			"cursor/claude-4.5-sonnet",
			"amazon-bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
		]);
	});

	test("gives GPT-5.6 one key through a gateway", () => {
		expectOneKey("openai/gpt-5.6", ["cloudflare-ai-gateway/openai/gpt-5.6"]);
	});

	test("gives each GPT-5.6 product its own key", () => {
		expectSeparateKeys([
			"openai/gpt-5.6",
			"openai/gpt-5.6-sol",
			"openai/gpt-5.6-luna",
			"openai/gpt-5.6-terra",
			"openai/gpt-5.6-cyber",
		]);
	});

	test("gives o3-mini and o3-pro separate keys", () => {
		expectSeparateKeys(["openai/o3-mini", "openai/o3-pro"]);
	});

	test("gives gpt-4.1-mini and gpt-4.1-nano separate keys", () => {
		expectSeparateKeys(["openai/gpt-4.1-mini", "openai/gpt-4.1-nano"]);
	});

	test("gives Grok 4 and Grok 4 Fast Reasoning separate keys", () => {
		expectSeparateKeys(["xai/grok-4", "xai/grok-4-fast-reasoning"]);
	});

	test("returns undefined for an identity with no revision", () => {
		expect(classifyModel("openai", "gpt-4o").revision).toBeUndefined();
		expect(keyOf("openai/gpt-4o")).toBeUndefined();
	});

	test("reads the served id from requestModelId", () => {
		expect(keyOf("openai/gpt-5.6-sol-pro", "gpt-5.6-sol")).toBe(keyOf("openai/gpt-5.6-sol"));
		expect(keyOf("openai/gpt-5.6-sol-pro")).not.toBe(keyOf("openai/gpt-5.6-sol"));
	});

	test("drops the route words of a Claude id", () => {
		expectOneKey("anthropic/claude-opus-4-8", [
			"openrouter/anthropic/claude-opus-4.8-fast",
			"openrouter/anthropic/claude-opus-4.8:batch",
			"openrouter/anthropic/claude-opus-4.8-flex",
			"anthropic/claude-opus-4-8-latest",
			"openrouter/anthropic/claude-opus-4.8-discounted",
		]);
	});

	test("keeps fast as a product word of a Grok id", () => {
		expectSeparateKeys(["xai/grok-4", "xai/grok-4-fast"]);
	});

	test("drops highspeed from an id", () => {
		expectOneKey("kimi-code/k3.1-pro", ["kimi-code/k3.1-pro-highspeed"]);
	});

	test("drops turbo from a Qwen id and keeps it in an OpenAI id", () => {
		expectOneKey("deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct", [
			"deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
		]);
		expectSeparateKeys(["openai/gpt-4", "openai/gpt-4-turbo"]);
	});

	test("drops nothinking from an id", () => {
		expectOneKey("google/gemini-2.5-flash", ["nanogpt/gemini-2.5-flash-nothinking"]);
	});

	test("drops non-reasoning as one route word and keeps a bare non", () => {
		expectOneKey("xai/grok-4-fast-reasoning", ["xai/grok-4-fast-non-reasoning"]);
		expectSeparateKeys(["xai/grok-4", "xai/grok-4-non"]);
	});

	test("keeps preview as a product word", () => {
		expectSeparateKeys(["anthropic/claude-opus-4-8", "anthropic/claude-opus-4-8-preview"]);
		expectSeparateKeys(["google/gemini-3.1-pro", "google/gemini-3.1-pro-preview"]);
	});
});
