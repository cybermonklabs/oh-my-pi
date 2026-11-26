/**
 * An endpoint that rejects part of a request with a 400 (strict tool schemas its grammar compiler cannot take, a
 * thinking signature it cannot verify, a thinking block bound to another conversation, `cache_control` breakpoints or
 * their `ttl`) makes the provider retry without that part and leave it out of every later request of the session. A
 * process that resumes the transcript must leave it out from its first request, as the transcript's last request did:
 * one that sends it again meets the same 400 and, for strict tools, declares other tool bytes than the transcript's
 * last request, which rewrites the whole cached prompt. Its prompt cache status must judge the tools its first request
 * sends. A `cache_control` fallback is the exception: it lasts as long as the process that learned it, so one 400 that
 * did not describe the endpoint cannot hold the session to five-minute breakpoints for good. Each process here is a
 * session of its own on the same session file, as omp opens it when it restarts and resumes it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	GATEWAY,
	type GatewayFetch,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import {
	type GatewayRequest,
	gatewayModel,
	mockOpenAIGatewayFetch,
	type OpenAIGatewayApi,
	openAIGatewayModelsYml,
} from "./helpers/openai-gateway";

/** A 400 body in the shape Anthropic's messages API gives, which OpenAI-compatible gateways pass through too. */
function rejection(message: string): string {
	return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message }, request_id: "req_400" });
}

/** The 400 an endpoint answers a strict request with when it cannot compile the tools' grammar. */
const GRAMMAR_REJECTION = rejection(
	"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
);

/** An endpoint as the gateway plays it. */
interface Endpoint {
	/** The OpenAI API it serves claude-opus-5-5 on; Anthropic's messages API without one. */
	api?: OpenAIGatewayApi;
	modelsYml: string;
	/** The 400 body it answers `request` with when it rejects part of it. */
	refuse(request: GatewayRequest): string | undefined;
	/** Its reply to its `turn`th request when it takes it: a text reply that wrote the cache unless given. */
	reply?(turn: number): Response;
}

/** Whether `request` declares a tool as strict: Anthropic and Responses tools carry the flag, chat completions' functions. */
function sendsStrictTool(request: GatewayRequest): boolean {
	return (request.tools ?? []).some(
		tool => isRecord(tool) && (tool.strict === true || (isRecord(tool.function) && tool.function.strict === true)),
	);
}

/** The thinking blocks `request`'s messages replay. */
function thinkingBlocksOf(request: GatewayRequest): Record<string, unknown>[] {
	return (request.messages ?? []).flatMap(message =>
		Array.isArray(message.content)
			? message.content.filter(
					(block): block is Record<string, unknown> => isRecord(block) && block.type === "thinking",
				)
			: [],
	);
}

/** Every `cache_control` breakpoint `value` carries, across tools, system and messages. */
function breakpointsOf(value: unknown): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.flatMap(breakpointsOf);
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([key, inner]) =>
		key === "cache_control" && isRecord(inner) ? [inner] : breakpointsOf(inner),
	);
}

/** Whether `request` sends a breakpoint with `ttl` or `scope`, which an endpoint may take or refuse apart from it. */
function sendsBreakpointOptions(request: GatewayRequest | undefined): boolean {
	return breakpointsOf(request).some(breakpoint => breakpoint.ttl !== undefined || breakpoint.scope !== undefined);
}

const CACHE_CONTROL_REJECTION = rejection("messages.0.content.0.cache_control: Extra inputs are not permitted");
const TTL_REJECTION = rejection('messages.0.content.0.cache_control.ttl: unsupported value "1h"');

/** A streamed reply of a thinking block, signed `sig-<turn>` when `signed`, then the text `seen <turn>`. */
function thinkingAnswer(turn: number, signed: boolean): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `thought ${turn}` } },
		...(signed
			? [{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `sig-${turn}` } }]
			: []),
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: `seen ${turn}` } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** What one process saw. */
interface ProcessRun {
	/** Each request the gateway received, oldest first. */
	requests: GatewayRequest[];
	/** The prompt cache status before the process's first prompt. */
	status: PromptCacheStatus | undefined;
	/** The prompt cache status once its last prompt's reply ended. */
	statusAfter: PromptCacheStatus | undefined;
	sessionFile: string;
}

/**
 * Runs one process against `endpoint` in `dir`, on `sessionFile` or a new session, with `read` and `edit` (a tool each
 * API sends as strict by default) on claude-opus-5-5, and sends each of `prompts`.
 */
async function runProcess(
	dir: string,
	endpoint: Endpoint,
	sessionFile: string | undefined,
	prompts: string[],
): Promise<ProcessRun> {
	const refusal = (request: GatewayRequest | undefined) => {
		const body = request && endpoint.refuse(request);
		return body ? new Response(body, { status: 400, headers: { "content-type": "application/json" } }) : undefined;
	};
	const { api } = endpoint;
	let gateway: { requests: GatewayRequest[]; restore(): void };
	if (api) {
		gateway = mockOpenAIGatewayFetch(api, refusal);
	} else {
		const reply = endpoint.reply ?? (turn => answer(turn, { cacheWriteTokens: 100 }));
		const messages: GatewayFetch = mockGatewayFetch(turn => refusal(messages.requests[turn - 1]) ?? reply(turn));
		gateway = messages;
	}
	await Bun.write(path.join(dir, "models.yml"), endpoint.modelsYml);
	const authStorage = createInMemoryAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
		const model = gatewayModel(modelRegistry, api);
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir, path.join(dir, "sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions({ path: () => dir }),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			toolNames: ["read", "edit"],
			contextFiles: [],
			skills: [],
		});
		try {
			const status = session.getPromptCacheStatus();
			for (const prompt of prompts) await session.prompt(prompt);
			const statusAfter = session.getPromptCacheStatus();
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests: gateway.requests, status, statusAfter, sessionFile: file };
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		gateway.restore();
	}
}

/** An endpoint that rejects strict tools with the grammar 400 when `rejectsStrict`, on `api` or Anthropic's API. */
function strictEndpoint(api: OpenAIGatewayApi | undefined, rejectsStrict: boolean): Endpoint {
	return {
		api,
		modelsYml: api ? openAIGatewayModelsYml() : gatewayModelsYml(),
		refuse: request => (rejectsStrict && sendsStrictTool(request) ? GRAMMAR_REJECTION : undefined),
	};
}

describe("a resumed transcript whose endpoint rejected strict tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{ wire: "anthropic-messages", api: undefined, rejectsStrict: true },
		{ wire: "anthropic-messages", api: undefined, rejectsStrict: false },
		{ wire: "openai-responses", api: "openai-responses", rejectsStrict: true },
		{ wire: "openai-responses", api: "openai-responses", rejectsStrict: false },
		{ wire: "openai-completions", api: "openai-completions", rejectsStrict: true },
		{ wire: "openai-completions", api: "openai-completions", rejectsStrict: false },
	] satisfies { wire: string; api: OpenAIGatewayApi | undefined; rejectsStrict: boolean }[])(
		"on $wire, strict tools rejected: $rejectsStrict",
		async ({ api, rejectsStrict }) => {
			using tempDir = TempDir.createSync("@pi-provider-fallback-resume-");
			const endpoint = strictEndpoint(api, rejectsStrict);
			const live = await runProcess(tempDir.path(), endpoint, undefined, ["first"]);
			const resumed = await runProcess(tempDir.path(), endpoint, live.sessionFile, ["second"]);
			const [refused] = live.requests;
			const last = live.requests.at(-1);
			const [first] = resumed.requests;
			if (!refused || !last || !first) throw new Error("Expected both processes' requests");
			// Precondition: the live process's first request sent a strict tool, and only a rejection made it retry.
			expect(sendsStrictTool(refused)).toBe(true);
			expect(live.requests.length).toBe(rejectsStrict ? 2 : 1);
			// The retry wrote the entry the next request reads: it declares the tools as the retry did.
			expect(live.statusAfter).toMatchObject({ state: "warm" });

			// The resumed process sends its tools as the transcript's last request did, without meeting the 400 again.
			expect(sendsStrictTool(first)).toBe(!rejectsStrict);
			expect(withoutCacheControl(first.tools)).toBe(withoutCacheControl(last.tools));
			expect(resumed.requests.length).toBe(1);
			expect(resumed.status).toMatchObject({ state: "warm" });
		},
		60_000,
	);

	it("reports the tools changed when the session recorded the fallback after its last request", async () => {
		using tempDir = TempDir.createSync("@pi-provider-fallback-resume-");
		const endpoint = strictEndpoint(undefined, true);
		const live = await runProcess(tempDir.path(), strictEndpoint(undefined, false), undefined, ["first"]);
		// A side request after the last reply (a compaction summary) met the 400: the session records the fallback the
		// provider keeps for the gateway's endpoint and model.
		const sessionManager = await SessionManager.open(live.sessionFile);
		sessionManager.appendCustomEntry("provider-fallbacks", {
			version: 1,
			fallbacks: [{ api: "anthropic-messages", baseUrl: GATEWAY, modelId: "claude-opus-5-5", off: "strict-tools" }],
		});
		await sessionManager.close();
		const resumed = await runProcess(tempDir.path(), endpoint, live.sessionFile, ["second"]);
		const [first] = resumed.requests;
		if (!first) throw new Error("Expected the resumed process's request");

		expect(sendsStrictTool(first)).toBe(false);
		// The transcript's last request sent strict tools: the entry it left is not one this request reads.
		expect(resumed.status).toMatchObject({ state: "cold", reason: { kind: "tools" } });
	}, 60_000);
});

/** `messages.1.content.0` is the first reply's thinking block in the request of the second prompt. */
const SIGNATURE_REJECTION = rejection("messages.1.content.0: Invalid `signature` in `thinking` block");
const PREFIX_BINDING_REJECTION = rejection(
	"messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.",
);

describe("a resumed transcript whose Anthropic endpoint rejected part of a request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{
			// The endpoint verifies every replayed signature: unsigned thinking goes out as text after the 400.
			fallback: "unsigned thinking replayed as thinking",
			endpoint: {
				modelsYml: gatewayModelsYml().replace("replayUnsignedThinking: false", "replayUnsignedThinking: true"),
				reply: turn => thinkingAnswer(turn, false),
				refuse: request =>
					thinkingBlocksOf(request).some(block => !block.signature) ? SIGNATURE_REJECTION : undefined,
			},
		},
		{
			// It verifies no signature the gateway minted: after demoting unsigned thinking, no thinking is replayed.
			fallback: "replayed thinking",
			endpoint: {
				modelsYml: gatewayModelsYml(),
				reply: turn => thinkingAnswer(turn, true),
				refuse: request => (thinkingBlocksOf(request).length > 0 ? SIGNATURE_REJECTION : undefined),
			},
		},
		{
			// The first reply's signed block is bound to another conversation: it and the blocks after it are stripped.
			fallback: "thinking blocks bound to another conversation",
			endpoint: {
				modelsYml: gatewayModelsYml(),
				reply: turn => thinkingAnswer(turn, true),
				refuse: request =>
					thinkingBlocksOf(request).some(block => block.signature === "sig-1")
						? PREFIX_BINDING_REJECTION
						: undefined,
			},
		},
	] satisfies { fallback: string; endpoint: Endpoint }[])(
		"leaves out the $fallback the endpoint rejected from its first request",
		async ({ endpoint }) => {
			using tempDir = TempDir.createSync("@pi-provider-fallback-resume-");
			const live = await runProcess(tempDir.path(), endpoint, undefined, ["first", "second"]);
			const resumed = await runProcess(tempDir.path(), endpoint, live.sessionFile, ["third"]);
			const last = live.requests.at(-1);
			const [first] = resumed.requests;
			if (!last || !first) throw new Error("Expected both processes' requests");
			// Precondition: the endpoint rejected a request of the live process, whose last request it took.
			expect(live.requests.some(request => endpoint.refuse(request) !== undefined)).toBe(true);
			expect(endpoint.refuse(last)).toBeUndefined();

			// The resumed process's first request leaves the rejected part out, and the endpoint takes it.
			expect(endpoint.refuse(first)).toBeUndefined();
			expect(resumed.requests.length).toBe(1);
		},
		60_000,
	);
});

describe("a resumed transcript whose Anthropic endpoint rejected cache_control", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends one-hour breakpoints again from its first request, which an endpoint that takes them again takes", async () => {
		using tempDir = TempDir.createSync("@pi-provider-fallback-resume-");
		let refused = false;
		// One 400 that did not describe the endpoint: it takes `ttl` on every other request.
		const endpoint: Endpoint = {
			modelsYml: gatewayModelsYml(),
			refuse: request => {
				if (refused || !sendsBreakpointOptions(request)) return undefined;
				refused = true;
				return TTL_REJECTION;
			},
		};
		const live = await runProcess(tempDir.path(), endpoint, undefined, ["first", "second"]);
		const resumed = await runProcess(tempDir.path(), endpoint, live.sessionFile, ["third"]);
		// Precondition: the live process met the 400 once and sent its breakpoints without `ttl` from then on.
		expect(live.requests.map(sendsBreakpointOptions)).toEqual([true, false, false]);

		// The resumed process sends the one-hour breakpoints again, and the endpoint takes them.
		expect(resumed.requests).toHaveLength(1);
		expect(breakpointsOf(resumed.requests[0]).some(breakpoint => breakpoint.ttl === "1h")).toBe(true);
	}, 60_000);

	it("meets an endpoint's refusal of `ttl` once more, then leaves it out for the rest of the process", async () => {
		using tempDir = TempDir.createSync("@pi-provider-fallback-resume-");
		const endpoint: Endpoint = {
			modelsYml: gatewayModelsYml(),
			refuse: request => (sendsBreakpointOptions(request) ? TTL_REJECTION : undefined),
		};
		const live = await runProcess(tempDir.path(), endpoint, undefined, ["first", "second"]);
		const resumed = await runProcess(tempDir.path(), endpoint, live.sessionFile, ["third", "fourth"]);
		// Precondition: the live process met the 400 on its first request only.
		expect(live.requests.map(sendsBreakpointOptions)).toEqual([true, false, false]);

		// One refused request, its retry, and the next prompt's request, which keeps breakpoints without `ttl`.
		expect(resumed.requests.map(sendsBreakpointOptions)).toEqual([true, false, false]);
		expect(breakpointsOf(resumed.requests[2]).length).toBeGreaterThan(0);
	}, 60_000);

	it("meets an endpoint's refusal of every breakpoint twice more, then sends none for the rest of the process", async () => {
		using tempDir = TempDir.createSync("@pi-provider-fallback-resume-");
		const endpoint: Endpoint = {
			modelsYml: gatewayModelsYml(),
			refuse: request => (breakpointsOf(request).length > 0 ? CACHE_CONTROL_REJECTION : undefined),
		};
		const live = await runProcess(tempDir.path(), endpoint, undefined, ["first", "second"]);
		const resumed = await runProcess(tempDir.path(), endpoint, live.sessionFile, ["third", "fourth"]);
		const breakpoints = (run: ProcessRun) => run.requests.map(request => breakpointsOf(request).length > 0);
		// Precondition: the live process met the 400 with `ttl` and without, then sent no breakpoint.
		expect(breakpoints(live)).toEqual([true, true, false, false]);

		// The resumed process climbs the same rungs once, then sends no breakpoint.
		expect(resumed.requests.map(sendsBreakpointOptions)).toEqual([true, false, false, false]);
		expect(breakpoints(resumed)).toEqual([true, true, false, false]);
	}, 60_000);
});
