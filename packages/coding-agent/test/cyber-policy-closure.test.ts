import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { ModelCallRefusedError, runInModelCallScope, streamSimple } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import {
	CyberPolicyClosure,
	cyberPolicyHoldMessage,
	installCyberPolicyGuard,
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

// The guard records each call's final outcome. A call held at its send (the hold began while it waited for its
// key) ends with the hold's own error: the guard reports it to the closure, which must not record it.
describe("installCyberPolicyGuard", () => {
	const MOCK_API_SOURCE = "test/cyber-policy-closure";
	beforeAll(() => registerMockApi(MOCK_API_SOURCE));
	afterAll(() => unregisterCustomApis(MOCK_API_SOURCE));

	it("does not record the error of a call it held at its send", async () => {
		const closure = new CyberPolicyClosure();
		const removeGuard = installCyberPolicyGuard(closure);
		const record = vi.spyOn(closure, "record");
		try {
			const model = createMockModel({ provider: "openai", id: "gpt-5.5", handler: { content: ["sent"] } });
			const message = await runInModelCallScope(closure, () =>
				streamSimple(
					model.model,
					{ messages: [{ role: "user", content: "x", timestamp: Date.now() }] },
					{
						apiKey: async () => {
							// Another call of the tree meets a refusal while this one waits for its key.
							closure.record();
							return "key";
						},
					},
				).result(),
			);

			expect(message.stopReason).toBe("error");
			expect(model.calls).toHaveLength(0);
			// Only the other call's refusal: the held call's own error is not recorded.
			expect(record).toHaveBeenCalledTimes(1);
		} finally {
			removeGuard();
		}
	});
});
