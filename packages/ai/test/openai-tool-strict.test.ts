import { describe, expect, it } from "bun:test";
import {
	openAIFunctionTools,
	openAIStrictnessHashedTools,
	type OpenAIToolsApi,
	openAIToolsRequest,
} from "@oh-my-pi/pi-ai/providers/openai-tool-strict";
import type { Model, ModelSpec, OpenAICompat, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** A tool whose schema strict mode can enforce, marked `strict` as given. */
function strictable(name: string, strict?: boolean): Tool {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		...(strict === undefined ? {} : { strict }),
	};
}

/** A tool whose schema strict mode cannot enforce: a property with no type. */
const loose: Tool = {
	name: "loose",
	description: "loose tool",
	parameters: { type: "object", properties: { value: {} }, required: ["value"] },
};

function gatewayModel<TApi extends "openai-completions" | "openrouter">(api: TApi, compat?: OpenAICompat): Model<TApi> {
	return buildModel({
		id: "gateway-model",
		name: "Gateway Model",
		api,
		provider: api === "openrouter" ? "openrouter" : "gateway",
		baseUrl: api === "openrouter" ? "https://openrouter.ai/api/v1" : "https://gateway.example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(compat ? { compat } : {}),
	} as ModelSpec<TApi>);
}

describe("openAIFunctionTools under PI_NO_STRICT", () => {
	// Codex proxies reject the `strict` key, so the global bypass keeps it off their wire; chat completions keeps a
	// tool's own `strict: false`, which some backends read otherwise than no flag (#4336).
	it.each([
		["openai-codex-responses", [undefined, undefined, undefined]],
		["openai-responses", [undefined, undefined, undefined]],
		["openai-completions", [undefined, false, undefined]],
	] satisfies [OpenAIToolsApi, (boolean | undefined)[]][])(
		"asks %s for no strict tool, flags %j for tools marked true, false and neither",
		(api, flags) => {
			const declared = openAIFunctionTools(
				{ api, compat: { supportsStrictMode: true, toolStrictMode: "mixed" }, noStrict: true },
				[strictable("marked", true), strictable("unmarked", false), strictable("plain")],
			);
			expect(declared.map(tool => tool?.strict)).toEqual(flags);
		},
	);

	it("declares an openrouter model's tools for the API its requests go out on", () => {
		const openrouter = gatewayModel("openrouter");
		const previous = Bun.env.PI_OPENROUTER_RESPONSES;
		try {
			delete Bun.env.PI_OPENROUTER_RESPONSES;
			expect(openAIToolsRequest(openrouter).api).toBe("openai-responses");
			Bun.env.PI_OPENROUTER_RESPONSES = "0";
			expect(openAIToolsRequest(openrouter).api).toBe("openai-completions");
		} finally {
			if (previous === undefined) delete Bun.env.PI_OPENROUTER_RESPONSES;
			else Bun.env.PI_OPENROUTER_RESPONSES = previous;
		}
	});
});

describe("openAIStrictnessHashedTools", () => {
	const byDefault = { noStrict: false, disableStrictTools: false };

	// Under `all_strict` chat completions sends every tool strict or none: with one tool strict mode cannot enforce, it
	// sends none whatever the settings, so turning them on changes neither the wire nor the hash.
	it.each([
		{ mode: "mixed", tools: [strictable("plain"), loose], settings: { noStrict: true }, wireChanges: true },
		{ mode: "all_strict", tools: [strictable("plain"), loose], settings: { noStrict: true }, wireChanges: false },
		{
			mode: "all_strict",
			tools: [strictable("plain"), loose],
			settings: { disableStrictTools: true },
			wireChanges: false,
		},
		{
			mode: "all_strict",
			tools: [strictable("plain"), strictable("other")],
			settings: { noStrict: true },
			wireChanges: true,
		},
	] as const)(
		"changes under $mode with $settings exactly when the wire does ($wireChanges)",
		({ mode, tools, settings, wireChanges }) => {
			const model = gatewayModel(
				"openai-completions",
				mode === "all_strict" ? { supportsStrictMode: true, toolStrictMode: mode } : { supportsStrictMode: true },
			);
			const wire = (setting: { noStrict?: boolean; disableStrictTools?: boolean }) =>
				JSON.stringify(openAIFunctionTools({ ...openAIToolsRequest(model), ...byDefault, ...setting }, tools));
			const hashed = (setting: { noStrict?: boolean; disableStrictTools?: boolean }) =>
				JSON.stringify(openAIStrictnessHashedTools(model, tools, { ...byDefault, ...setting }));

			expect(wire(settings) !== wire(byDefault)).toBe(wireChanges);
			expect(hashed(settings) !== hashed(byDefault)).toBe(wireChanges);
		},
	);
});
