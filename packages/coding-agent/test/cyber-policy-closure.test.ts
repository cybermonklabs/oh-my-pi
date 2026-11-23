import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
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

// Which session trees a refusal holds. Each tree's guard sees its own tree's calls and the calls made outside
// every tree. A refusal inside one tree's scope (a session's run, its tools included) holds that tree only. A
// refusal outside every tree's scope (a host's own call, made outside any session) cannot be tied to one tree:
// every tree's guard sees it, so it holds every tree, and while any tree holds, the next such call is held.
// The test runs in a child process, because a refusal made outside every scope here would also hold every
// session tree another test file left alive in this `bun test` process.
describe("which session trees a refusal holds", () => {
	const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
	const CLOSURE_MODULE = path.resolve(import.meta.dir, "../src/session/cyber-policy-closure.ts");

	it("a refusal inside one tree's scope holds that tree; one outside every scope holds every tree", async () => {
		const script = [
			'import { guardModelRequest, ModelCallRefusedError, runInModelCallScope } from "@oh-my-pi/pi-ai/model-call-guard";',
			'import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";',
			`import { CyberPolicyClosure, installCyberPolicyGuard } from ${JSON.stringify(CLOSURE_MODULE)};`,
			'const { model } = createMockModel({ provider: "openai", id: "gpt-5.5", handler: { content: [] } });',
			// OpenAI's refusal, as a direct provider call (a web search, remote compaction) meets it.
			'const refused = () => Promise.reject({ code: "cyber_policy" });',
			"const mine = new CyberPolicyClosure();",
			"const other = new CyberPolicyClosure();",
			"installCyberPolicyGuard(mine);",
			"installCyberPolicyGuard(other);",
			"await runInModelCallScope(mine, () => guardModelRequest(model, refused)).catch(() => {});",
			"const inside = { mine: mine.active, other: other.active };",
			"mine.end();",
			"await guardModelRequest(model, refused).catch(() => {});",
			"const outside = { mine: mine.active, other: other.active };",
			'const next = await guardModelRequest(model, async () => "sent").catch(error =>',
			'\terror instanceof ModelCallRefusedError ? "held" : String(error),',
			");",
			"console.log(JSON.stringify({ inside, outside, next }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);

		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "null")).toEqual({
			inside: { mine: true, other: false },
			outside: { mine: true, other: true },
			next: "held",
		});
	});
});
