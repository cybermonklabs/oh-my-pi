/**
 * The child process of `declared-tools-wire-model.test.ts`, run as `bun <this file>` with `PI_NO_STRICT` set: the
 * providers read it once, when they load. It writes {@link wrappedModelFingerprints} to stdout; the test takes them
 * again under default settings.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { factoryModel } from "../../../ai/test/helpers/factory-droid";
import { Agent } from "../../src/agent";
import type { AgentTool } from "../../src/types";

/**
 * A tool Anthropic declares as strict unless the strict-tools fallback or `PI_NO_STRICT` applies, with a schema strict
 * mode can enforce.
 */
export const edit: AgentTool = {
	name: "edit",
	label: "edit",
	description: "edit tool",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	} as unknown as AgentTool["parameters"],
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

/** Models whose requests a wrapper transport sends as a model of another API. */
function wrappedModels(): Record<"kimiCode" | "factoryDroid" | "cloudflareAiGateway", Model> {
	return {
		// Kimi Code's K3, in the Anthropic format its catalog row resolves: Anthropic's messages API, strict tools.
		kimiCode: getBundledModel("kimi-code", "k3"),
		// Factory Droid's GPT-6.1 Sol on Factory's Responses wire, which marks every tool `strict: false`.
		factoryDroid: factoryModel("gpt-6.1-sol"),
		// Cloudflare AI Gateway's `openai/*` row, an Anthropic row the transport reroutes to chat completions.
		cloudflareAiGateway: getBundledModel("cloudflare-ai-gateway", "openai/gpt-5"),
	};
}

/** Each wrapped model's declared-tools fingerprint with the `edit` tool, from a fresh agent, in this process. */
export function wrappedModelFingerprints(): Record<string, string> {
	const fingerprints: Record<string, string> = {};
	for (const [name, model] of Object.entries(wrappedModels())) {
		const agent = new Agent({ initialState: { model, systemPrompt: [], tools: [edit], messages: [] } });
		fingerprints[name] = agent.declaredToolsFingerprint(model);
	}
	return fingerprints;
}

if (import.meta.main) process.stdout.write(JSON.stringify(wrappedModelFingerprints()));
