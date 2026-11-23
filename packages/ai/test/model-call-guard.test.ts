import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { addModelCallGuard, ModelCallRefusedError, runInModelCallScope, streamSimple } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { embed } from "@oh-my-pi/pi-ai/embeddings";
import { rerank } from "@oh-my-pi/pi-ai/rerank";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { submitVideo } from "@oh-my-pi/pi-ai/video";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai/types";

/**
 * The process-wide model-call checkpoint: a registered guard sees every call before its request is
 * built and how every call it let through ended. Synthetic responses only.
 */
const MOCK_API_SOURCE = "test/model-call-guard";
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };

let removals: Array<() => void> = [];
beforeEach(() => registerMockApi(MOCK_API_SOURCE));
afterEach(() => {
	for (const remove of removals) remove();
	removals = [];
	unregisterCustomApis(MOCK_API_SOURCE);
});

describe("model-call guard", () => {
	it("holds a call a guard refuses: no request, one error naming the reason", async () => {
		const model = createMockModel({ id: "gpt-5.5", handler: { content: ["hi"] } });
		removals.push(addModelCallGuard({ refuse: () => "held: cyber_policy" }));

		const result = await streamSimple(model, context).result();

		expect(model.calls).toHaveLength(0);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("held: cyber_policy");
	});

	it("lets other models through, and reports how each call ended", async () => {
		const openai = createMockModel({ id: "gpt-5.5", handler: { content: ["hi"] } });
		const claude = createMockModel({
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			handler: { stopReason: "error", errorMessage: "cyber_policy: refused" },
		});
		const settled: string[] = [];
		removals.push(
			addModelCallGuard({
				refuse: model => (model.id === "held-model" ? "held" : undefined),
				settled: (model, outcome) =>
					settled.push(`${model.id}:${(outcome as { stopReason?: string }).stopReason ?? "thrown"}`),
			}),
		);

		const first = streamSimple(openai, context);
		await first.result();
		const second = await streamSimple(claude, context).result();

		expect(openai.calls).toHaveLength(1);
		expect(claude.calls).toHaveLength(1);
		expect(second.errorMessage).toContain("cyber_policy");
		expect(settled).toEqual(["gpt-5.5:stop", "claude-sonnet-4-5:error"]);
	});

	it("reports a call's end before the caller's own wait on it resumes", async () => {
		const model = createMockModel({ id: "gpt-5.5", handler: { stopReason: "error", errorMessage: "refused" } });
		const order: string[] = [];
		removals.push(addModelCallGuard({ refuse: () => undefined, settled: () => order.push("guard") }));

		await streamSimple(model, context).result();
		order.push("caller");

		expect(order).toEqual(["guard", "caller"]);
	});

	it("holds a request-style call with ModelCallRefusedError and sends nothing", async () => {
		const model = { api: "openai-speech", provider: "openai", id: "gpt-4o-mini-tts" } as Model<Api>;
		removals.push(addModelCallGuard({ refuse: () => "held: cyber_policy" }));

		const error = await synthesizeSpeech(model, { text: "hello" } as never, {} as never).then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toBeInstanceOf(ModelCallRefusedError);
		expect((error as Error).message).toBe("held: cyber_policy");
	});

	// Embeddings, rerank and video submission carry text that can be drawn from a conversation or written by a
	// model: while a guard holds the model they send nothing; with no guard the same call reaches the endpoint.
	describe.each([
		[
			"embed",
			"openai-embeddings",
			(model: Model<Api>, fetch: typeof globalThis.fetch) =>
				embed(model, { input: "hello", encodingFormat: "float" }, { apiKey: "test", fetch }),
		],
		[
			"rerank",
			"openrouter-rerank",
			(model: Model<Api>, fetch: typeof globalThis.fetch) =>
				rerank(model, { query: "hello", documents: ["a"] }, { apiKey: "test", fetch }),
		],
		[
			"submitVideo",
			"openrouter-video",
			(model: Model<Api>, fetch: typeof globalThis.fetch) =>
				submitVideo(model, { prompt: "hello" }, { apiKey: "test", fetch }),
		],
	] as const)("%s", (_name, api, call) => {
		const model = { api, provider: "openai", id: "held-model", baseUrl: "https://example.test/v1" } as Model<Api>;
		it.each([
			["holds the call while a guard holds the model, and sends nothing", true],
			["sends the call when no guard holds it (control)", false],
		])("%s", async (_case, held) => {
			let requests = 0;
			const fetch = (async () => {
				requests++;
				return new Response("{}", { status: 500 });
			}) as unknown as typeof globalThis.fetch;
			if (held) removals.push(addModelCallGuard({ refuse: () => "held: cyber_policy" }));

			const error = await call(model, fetch).then(
				() => undefined,
				(err: unknown) => err,
			);

			if (held) {
				expect(error).toBeInstanceOf(ModelCallRefusedError);
				expect(requests).toBe(0);
			} else {
				expect(requests).toBeGreaterThan(0);
			}
		});
	});

	it("lets every call through when no guard is registered, as before", async () => {
		const model = createMockModel({ id: "gpt-5.5", handler: { content: ["hi"] } });

		const result = await streamSimple(model, context).result();

		expect(model.calls).toHaveLength(1);
		expect(result.stopReason).toBe("stop");
	});

	it("a scoped guard sees its own scope's calls and unscoped calls, never another scope's", async () => {
		const model = createMockModel({ id: "gpt-5.5", handler: { content: ["hi"] } });
		const mine = {};
		const theirs = {};
		removals.push(addModelCallGuard({ refuse: () => "held: cyber_policy" }, mine));

		const inTheirs = await runInModelCallScope(theirs, () => streamSimple(model, context).result());
		const inMine = await runInModelCallScope(mine, () => streamSimple(model, context).result());
		const outside = await streamSimple(model, context).result();

		expect(inTheirs.stopReason).toBe("stop");
		expect(inMine.errorMessage).toBe("held: cyber_policy");
		expect(outside.errorMessage).toBe("held: cyber_policy");
		expect(model.calls).toHaveLength(1);
	});

	it("reports a call's end only to the guards of its scope", async () => {
		const model = createMockModel({ id: "gpt-5.5", handler: { stopReason: "error", errorMessage: "refused" } });
		const mine = {};
		const reported: string[] = [];
		removals.push(addModelCallGuard({ refuse: () => undefined, settled: () => reported.push("mine") }, mine));

		await runInModelCallScope({}, () => streamSimple(model, context).result());
		expect(reported).toEqual([]);
		await runInModelCallScope(mine, () => streamSimple(model, context).result());
		expect(reported).toEqual(["mine"]);
	});

	// A call can wait after the guards' first read (its key resolution here; a provider slot or its headers
	// elsewhere). The send reads them again, so a hold that began during the wait holds it.
	it.each([
		["holds a call whose hold began while it waited for its key", true, 0],
		["sends a call that waited for its key when no hold began (control)", false, 1],
	])("%s", async (_name, holdDuringWait, sent) => {
		const model = createMockModel({ id: "gpt-5.5", handler: { content: ["hi"] } });
		let held = false;
		removals.push(addModelCallGuard({ refuse: () => (held ? "held: cyber_policy" : undefined) }));

		const result = await streamSimple(model, context, {
			apiKey: async () => {
				held = holdDuringWait;
				return "key";
			},
		}).result();

		expect(model.calls).toHaveLength(sent);
		expect(result.stopReason).toBe(holdDuringWait ? "error" : "stop");
	});
});
