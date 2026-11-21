import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CyberPolicyClosure } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function modelFor(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected model ${provider}/${id}`);
	return model;
}

function registry(models: Model<Api>[]) {
	return {
		getAvailable: () => models,
		getApiKey: async () => "test-key",
		getApiKeyForProvider: async () => "test-key",
		authStorage: { rotateSessionCredential: async () => false },
		resolver: () => async () => "test-key",
	} as never;
}

const TITLE = { stopReason: "stop", content: [{ type: "text", text: "<title>Resolver Fix</title>" }] };
const REFUSAL = {
	stopReason: "error",
	content: [],
	errorMessage: "cyber_policy: This content was flagged for possible cybersecurity risk.",
};

afterEach(() => {
	vi.restoreAllMocks();
});

// A title request carries the user's text, the content OpenAI refused. While a cyber-policy refusal
// holds every OpenAI route closed, the title goes to another family or not at all. Synthetic refusals only.
describe("title generation after a cyber_policy refusal", () => {
	const openai = modelFor("openai", "gpt-5.5");
	const codex = modelFor("openai-codex", "gpt-5.6-sol");
	const claude = modelFor("anthropic", "claude-sonnet-4-5");
	const settings = Settings.isolated({
		modelRoles: {
			tiny: `${openai.provider}/${openai.id}`,
			commit: `${codex.provider}/${codex.id}`,
			smol: `${claude.provider}/${claude.id}`,
		},
	});
	const titleFor = (closure: CyberPolicyClosure) =>
		generateSessionTitle(
			"Investigate the resolver",
			registry([openai, codex, claude]),
			settings,
			"session-cyber",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			closure,
		);

	it("sends no title request to an OpenAI model while the refusal holds", async () => {
		const asked: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			asked.push(`${model.provider}/${model.id}`);
			return TITLE as never;
		});
		const closure = new CyberPolicyClosure();
		closure.record();

		expect(await titleFor(closure)).toBe("Resolver Fix");
		expect(asked).toEqual([`${claude.provider}/${claude.id}`]);
	});

	it("records a title model's refusal and asks no other OpenAI model", async () => {
		const asked: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			asked.push(`${model.provider}/${model.id}`);
			return (model.provider === claude.provider ? TITLE : REFUSAL) as never;
		});
		const closure = new CyberPolicyClosure();

		expect(await titleFor(closure)).toBe("Resolver Fix");
		expect(asked).toEqual([`${openai.provider}/${openai.id}`, `${claude.provider}/${claude.id}`]);
		expect(closure.isClosed(codex)).toBe(true);
	});

	it("still tries the next OpenAI model after an ordinary title failure, as before", async () => {
		const asked: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
			asked.push(`${model.provider}/${model.id}`);
			return (
				model.provider === claude.provider
					? TITLE
					: { stopReason: "error", content: [], errorMessage: "400 Invalid request" }
			) as never;
		});
		const closure = new CyberPolicyClosure();

		expect(await titleFor(closure)).toBe("Resolver Fix");
		expect(asked).toEqual([
			`${openai.provider}/${openai.id}`,
			`${codex.provider}/${codex.id}`,
			`${claude.provider}/${claude.id}`,
		]);
		expect(closure.active).toBe(false);
	});
});
