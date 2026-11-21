import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { runInModelCallScope } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CyberPolicyClosure, installCyberPolicyGuard } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

/**
 * A title request carries the user's text, the content OpenAI refused. While a cyber-policy refusal
 * holds, the process's model-call checkpoint sends no title request to an OpenAI model; the title
 * comes from another family or not at all. The title models are mock-API models with real ids, so the
 * real `completeSimple` runs through the checkpoint to the mock's handler. Synthetic refusals only.
 */
const MOCK_API_SOURCE = "test/title-cyber-policy";
const TITLE: MockResponse = { content: ["<title>Resolver Fix</title>"] };
const REFUSAL: MockResponse = {
	stopReason: "error",
	errorMessage: "cyber_policy: This content was flagged for possible cybersecurity risk.",
};

let releases: Array<() => void> = [];

beforeEach(() => registerMockApi(MOCK_API_SOURCE));
afterEach(() => {
	for (const release of releases) release();
	releases = [];
	unregisterCustomApis(MOCK_API_SOURCE);
});

function titleModels(answer: (provider: string) => MockResponse) {
	const asked: string[] = [];
	const make = (provider: string, id: string) =>
		createMockModel({
			provider,
			id,
			handler: () => {
				asked.push(`${provider}/${id}`);
				return answer(provider);
			},
		});
	const openai = make("openai", "gpt-5.5");
	const codex = make("openai-codex", "gpt-5.6-sol");
	const claude = make("anthropic", "claude-sonnet-4-5");
	expect([openai, codex, claude].map(model => model.identity.class)).toEqual(["openai", "openai", "anthropic"]);
	return { asked, openai, codex, claude };
}

function titleFor(models: Model<Api>[], closure: CyberPolicyClosure) {
	const [tiny, commit, smol] = models.map(model => `${model.provider}/${model.id}`);
	// The session that asks for a title runs in its tree's model-call scope.
	return runInModelCallScope(closure, () =>
		generateSessionTitle(
			"Investigate the resolver",
			{
				getAvailable: () => models,
				getApiKey: async () => "test-key",
				getApiKeyForProvider: async () => "test-key",
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "test-key",
			} as never,
			Settings.isolated({ modelRoles: { tiny, commit, smol } }),
			"session-cyber",
		),
	);
}

function guardedClosure(): CyberPolicyClosure {
	const closure = new CyberPolicyClosure();
	releases.push(installCyberPolicyGuard(closure));
	return closure;
}

describe("title generation after a cyber_policy refusal", () => {
	it("sends no title request to an OpenAI model while the refusal holds", async () => {
		const { asked, openai, codex, claude } = titleModels(() => TITLE);
		const closure = guardedClosure();
		closure.record();

		expect(await titleFor([openai, codex, claude], closure)).toBe("Resolver Fix");
		expect(asked).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	it("records a title model's refusal, and no other OpenAI model receives the text", async () => {
		const { asked, openai, codex, claude } = titleModels(provider => (provider === "anthropic" ? TITLE : REFUSAL));
		const closure = guardedClosure();

		expect(await titleFor([openai, codex, claude], closure)).toBe("Resolver Fix");
		expect(asked).toEqual(["openai/gpt-5.5", "anthropic/claude-sonnet-4-5"]);
		expect(closure.isClosed(codex)).toBe(true);
	});

	it("still tries the next OpenAI model after an ordinary title failure, as before", async () => {
		const { asked, openai, codex, claude } = titleModels(provider =>
			provider === "anthropic" ? TITLE : { stopReason: "error", errorMessage: "400 Invalid request" },
		);
		const closure = guardedClosure();

		expect(await titleFor([openai, codex, claude], closure)).toBe("Resolver Fix");
		expect(asked).toEqual(["openai/gpt-5.5", "openai-codex/gpt-5.6-sol", "anthropic/claude-sonnet-4-5"]);
		expect(closure.active).toBe(false);
	});
});
