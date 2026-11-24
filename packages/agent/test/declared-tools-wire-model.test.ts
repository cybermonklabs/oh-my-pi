import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { anthropicProviderSessionStateKey } from "@oh-my-pi/pi-ai/providers/anthropic-state";
import { NO_STRICT } from "@oh-my-pi/pi-ai/utils/schema/adapt";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveGitLabDuoModelIdentity } from "@oh-my-pi/pi-catalog/provider-models";
import { Agent } from "../src/agent";
import { edit, wrappedModelFingerprints } from "./fixtures/declared-tools-wire-process";
import { runUnderNoStrict } from "./helpers";

/**
 * A wrapper transport sends its requests as a model of its own: GitLab Duo as the upstream model, Kimi Code as the
 * model of its API format, Factory Droid as its route's model, Cloudflare AI Gateway as the model it reroutes. The
 * declared-tools fingerprint must read the strict flags and the strict-tools fallback on that model, or a resumed
 * process takes a cache entry the changed tools no longer read for live, or one they still read for lost.
 */

describe("Agent.declaredToolsFingerprint on a GitLab Duo model routed to Anthropic", () => {
	it("counts the strict-tools fallback Anthropic keeps under the upstream id", () => {
		const model: Model = getBundledModel("gitlab-duo", "duo-chat-opus-4-6");
		const upstreamModelId = resolveGitLabDuoModelIdentity(model.id)?.upstreamModelId;
		if (!upstreamModelId) throw new Error("expected the upstream id GitLab Duo sends for duo-chat-opus-4-6");
		// Precondition: the request goes out under another id than the catalog alias.
		expect(upstreamModelId).not.toBe(model.id);
		// The state the Anthropic provider keeps once the proxy rejected strict tools, keyed by the id it sent.
		const fallback = { strictToolsDisabled: true, close() {} };
		const providerSessionState = new Map<string, ProviderSessionState>([
			[
				anthropicProviderSessionStateKey("https://cloud.gitlab.com/ai/v1/proxy/anthropic/", upstreamModelId),
				fallback,
			],
		]);
		const initialState = { model, systemPrompt: [], tools: [edit], messages: [] };
		const fallen = new Agent({ initialState, providerSessionState });
		const strict = new Agent({ initialState });

		expect(fallen.declaredToolsFingerprint(model)).not.toBe(strict.declaredToolsFingerprint(model));
	});
});

const WIRE_PROCESS = path.join(import.meta.dir, "fixtures/declared-tools-wire-process.ts");

/**
 * Under `PI_NO_STRICT` Kimi Code's Anthropic format sends `edit` without the strict flag Anthropic gives it, and
 * Factory Droid's Responses wire drops the `strict: false` it marks every tool with; Cloudflare AI Gateway's
 * `openai/*` rows go out on chat completions, which sends no strict flag there either way. `PI_NO_STRICT` is read
 * once, when the providers load, so the fingerprints under it are taken in a process of its own.
 */
describe("Agent.declaredToolsFingerprint on a wrapped model under PI_NO_STRICT", () => {
	it("changes exactly where the tools the request goes out with change", async () => {
		// Precondition: this process runs under default settings.
		expect(NO_STRICT).toBe(false);
		const defaults = wrappedModelFingerprints();
		const noStrict = JSON.parse(await runUnderNoStrict(WIRE_PROCESS)) as Record<string, string>;

		const changed = Object.fromEntries(Object.keys(defaults).map(name => [name, noStrict[name] !== defaults[name]]));
		expect(changed).toEqual({ kimiCode: true, factoryDroid: true, cloudflareAiGateway: false });
	});
});
