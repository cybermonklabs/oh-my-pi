import { describe, expect, it } from "bun:test";
import { ModelCallRefusedError } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	cyberPolicyHoldMessage,
	isRecordableCyberPolicyRefusal,
} from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";

// A call the hold held ends with an error that names `cyber_policy` (so nothing retries it). Recording it
// as a refusal would start the hold again after a person's input ended it, with no new refusal; only
// OpenAI's own refusal is recorded. Synthetic errors only.
describe("isRecordableCyberPolicyRefusal", () => {
	const model = createMockModel({ provider: "model-gateway", id: "openai/gpt-6.1-sol", handler: { content: [] } });

	it("records OpenAI's own refusal, also as a cause", () => {
		expect(isRecordableCyberPolicyRefusal({ code: "cyber_policy" })).toBe(true);
		expect(isRecordableCyberPolicyRefusal(new Error("request failed", { cause: { code: "cyber_policy" } }))).toBe(
			true,
		);
	});

	it("does not record a held call, as a message, an error or a cause", () => {
		expect(isRecordableCyberPolicyRefusal({ stopReason: "error", errorMessage: cyberPolicyHoldMessage(model) })).toBe(
			false,
		);
		const held = new ModelCallRefusedError(model, cyberPolicyHoldMessage(model));
		expect(isRecordableCyberPolicyRefusal(held)).toBe(false);
		expect(isRecordableCyberPolicyRefusal(new Error("turn failed", { cause: held }))).toBe(false);
	});

	it("records nothing that is not a cyber_policy refusal", () => {
		expect(isRecordableCyberPolicyRefusal(new Error("503 upstream unavailable"))).toBe(false);
	});
});
