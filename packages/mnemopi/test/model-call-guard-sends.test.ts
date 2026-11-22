/**
 * Mnemopi's remote completion (`llm.mode` remote) and API embedding requests go out by raw fetch, past
 * pi-ai's dispatch functions, so each reads the model-call guards itself, before every attempt. The guard
 * here holds what coding-agent's `cyber_policy` hold closes once a refusal is recorded: a model of the
 * OpenAI family, or of a family the catalog cannot tell (a configured name with no provider). A model of
 * another family stays open. Synthetic requests only: a mock fetch or a local server.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { addModelCallGuard } from "@oh-my-pi/pi-ai/model-call-guard";
import { embed, resetEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { callRemoteLlm } from "@oh-my-pi/pi-mnemopi/core/local-llm";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const HOLD = "held: cyber_policy";
const OLD_ENV = { ...process.env };

/** A guard that holds the OpenAI and unknown families while `refusal.recorded` is true. */
function cyberPolicyLikeGuard() {
	const refusal = { recorded: false };
	const remove = addModelCallGuard({
		refuse: model =>
			refusal.recorded && (model.identity.class === "openai" || model.identity.class === "unknown")
				? HOLD
				: undefined,
	});
	return { refusal, remove };
}

let removeGuard: () => void = () => {};

afterEach(() => {
	removeGuard();
	for (const key in process.env) if (!(key in OLD_ENV)) delete process.env[key];
	for (const key in OLD_ENV) {
		const value = OLD_ENV[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const reply = () =>
	new Response(JSON.stringify({ choices: [{ message: { content: "summary" } }] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("Mnemopi's remote completion reads the model-call guards", () => {
	beforeEach(() => {
		process.env.MNEMOPI_LLM_BASE_URL = "http://remote-llm.test/v1";
		process.env.MNEMOPI_LLM_API_KEY = "not-a-secret";
	});

	it.each([
		["an openai/ model", "openai/gpt-4o-mini", true],
		["a name with no provider (unknown family)", "house-summarizer", true],
		["a model of another family (control)", "anthropic/claude-sonnet-4-5", false],
	] as const)("while a refusal stands: %s", async (_name, model, held) => {
		process.env.MNEMOPI_LLM_MODEL = model;
		const guard = cyberPolicyLikeGuard();
		removeGuard = guard.remove;
		guard.refusal.recorded = true;
		let sent = 0;
		const fetchMock: FetchImpl = async () => {
			sent++;
			return reply();
		};
		const result = await callRemoteLlm("synthetic memory text", 0.2, { fetch: fetchMock });
		expect(sent).toBe(held ? 0 : 1);
		expect(result).toBe(held ? null : "summary");
	});

	it("sends when no refusal is recorded (control)", async () => {
		process.env.MNEMOPI_LLM_MODEL = "openai/gpt-4o-mini";
		removeGuard = cyberPolicyLikeGuard().remove;
		let sent = 0;
		const result = await callRemoteLlm("synthetic memory text", 0.2, {
			fetch: async () => {
				sent++;
				return reply();
			},
		});
		expect(sent).toBe(1);
		expect(result).toBe("summary");
	});

	it.each([
		["holds the retry when a refusal is recorded during the first attempt", true],
		["retries when no refusal is recorded (control)", false],
	] as const)("%s", async (_name, refused) => {
		process.env.MNEMOPI_LLM_MODEL = "openai/gpt-4o-mini";
		const guard = cyberPolicyLikeGuard();
		removeGuard = guard.remove;
		let sent = 0;
		const fetchMock: FetchImpl = async () => {
			sent++;
			if (sent === 1) {
				// Another call of the session tree meets a refusal while this attempt is answered.
				if (refused) guard.refusal.recorded = true;
				return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
			}
			return reply();
		};
		const result = await callRemoteLlm("synthetic memory text", 0.2, { fetch: fetchMock });
		expect(sent).toBe(refused ? 1 : 2);
		expect(result).toBe(refused ? null : "summary");
	});
});

interface FakeServer {
	url: string;
	requests: () => number;
	stop(): void;
}

/** An OpenAI-compatible embeddings endpoint; `first` may answer the first request instead. */
function startServer(first?: () => Response): FakeServer {
	let requests = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = (await req.json()) as { input: string[] };
			requests++;
			if (requests === 1 && first) return first();
			return Response.json({ data: body.input.map((_text, index) => ({ index, embedding: [index + 1, 1, 0] })) });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/v1`, requests: () => requests, stop: () => server.stop(true) };
}

describe("Mnemopi's API embedding request reads the model-call guards", () => {
	let server: FakeServer | undefined;
	beforeEach(() => {
		resetEmbeddingProviderForTests();
	});
	afterEach(() => {
		server?.stop();
		server = undefined;
	});

	const run = <T>(model: string, url: string, fn: () => Promise<T>) =>
		withMnemopiRuntimeOptions({ embeddings: { model, apiUrl: url, apiKey: "not-a-secret" } }, fn);

	it.each([
		["an openai/ model", "openai/text-embedding-3-small", true],
		["a name with no provider (unknown family)", "text-embedding-v4", true],
		// The catalog places a family by the model id: an id it knows as another family's (Claude) shows the hold
		// leaves that family open. With a local API URL configured, any name goes to the API.
		["a model of another family (control)", "anthropic/claude-sonnet-4-5", false],
	] as const)("while a refusal stands: %s", async (_name, model, held) => {
		server = startServer();
		const guard = cyberPolicyLikeGuard();
		removeGuard = guard.remove;
		guard.refusal.recorded = true;
		const matrix = await run(model, server.url, () => embed([`synthetic ${model}`]));
		expect(server.requests()).toBe(held ? 0 : 1);
		expect(matrix === null).toBe(held);
	});

	it("sends when no refusal is recorded (control)", async () => {
		server = startServer();
		removeGuard = cyberPolicyLikeGuard().remove;
		const matrix = await run("openai/text-embedding-3-small", server.url, () => embed(["synthetic control"]));
		expect(server.requests()).toBe(1);
		expect(matrix).not.toBeNull();
	});

	it.each([
		["holds the retry when a refusal is recorded during the first attempt", true],
		["retries when no refusal is recorded (control)", false],
	] as const)("%s", async (_name, refused) => {
		const guard = cyberPolicyLikeGuard();
		removeGuard = guard.remove;
		server = startServer(() => {
			if (refused) guard.refusal.recorded = true;
			return new Response("busy", { status: 503, headers: { "Retry-After": "0" } });
		});
		const matrix = await run("openai/text-embedding-3-small", server.url, () =>
			embed([`synthetic retry ${refused}`]),
		);
		expect(server.requests()).toBe(refused ? 1 : 2);
		expect(matrix === null).toBe(refused);
	});
});
