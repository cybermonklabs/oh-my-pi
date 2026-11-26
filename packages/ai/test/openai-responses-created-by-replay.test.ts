import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type as schemaType } from "@oh-my-pi/omptype";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as piUtils from "@oh-my-pi/pi-utils";
import storedSession from "./fixtures/openai-responses-created-by-history.json" with { type: "json" };
import {
	endpoint as createEndpoint,
	type ResponsesSocket,
	type ResponsesWireEvent,
	send,
	sse,
	textEvents,
} from "./fixtures/openai-responses-server";

// The Responses API sets `created_by` on output items (and on each entry of a
// `shell_call_output` item's `output`) and refuses a request whose input item
// holds it: `400 Unknown parameter: 'input[7].created_by'`. omp stores output
// items whole and replays them, so every replay path must drop the key, at any
// value, and change nothing else.

/** A stored item's `created_by`: a string, `null` (seen live on a compaction item), or absent. */
type CreatedBy = string | null | undefined;

const CREATED_BY_VALUES = [
	["a string", "resp_creator_1"],
	["null", null],
] as const;

const SYSTEM_PROMPT = ["You are a helpful assistant."];
const USAGE = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };
const LOOKUP_TOOL: Tool = {
	name: "lookup",
	description: "Look something up",
	parameters: schemaType({ query: "string" }),
};
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

const httpModel = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

const resources: Array<() => Promise<void> | void> = [];
const originalAgentDir = piUtils.getAgentDir();
const originalWebSocket = global.WebSocket;

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
});

afterEach(async () => {
	for (const dispose of resources.splice(0)) await dispose();
	global.WebSocket = originalWebSocket;
	piUtils.setAgentDir(originalAgentDir);
	vi.restoreAllMocks();
});

function withCreatedBy<T extends Record<string, unknown>>(item: T, createdBy: CreatedBy): T {
	return createdBy === undefined ? item : { ...item, created_by: createdBy };
}

/**
 * Each place an item list holds `created_by` as its own key: an item's top
 * level, or an entry of a `shell_call_output` item's `output`.
 */
function createdByPaths(items: unknown): string[] {
	if (!Array.isArray(items)) throw new Error("expected an item list");
	const paths: string[] = [];
	items.forEach((item, index) => {
		if (!piUtils.isRecord(item)) return;
		if (Object.hasOwn(item, "created_by")) paths.push(`[${index}].created_by`);
		if (item.type !== "shell_call_output" || !Array.isArray(item.output)) return;
		item.output.forEach((entry: unknown, entryIndex: number) => {
			if (piUtils.isRecord(entry) && Object.hasOwn(entry, "created_by")) {
				paths.push(`[${index}].output[${entryIndex}].created_by`);
			}
		});
	});
	return paths;
}

function inputOf(request: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	if (!request || !Array.isArray(request.input)) throw new Error("expected a request with an input list");
	return request.input as Array<Record<string, unknown>>;
}

function findItem(
	input: Array<Record<string, unknown>>,
	type: string,
	key: "call_id" | "encrypted_content",
	value: string,
): Record<string, unknown> {
	const item = input.find(candidate => candidate.type === type && candidate[key] === value);
	if (!item) throw new Error(`expected a ${type} item with ${key} ${value} in the request input`);
	return item;
}

function storedItems(message: AssistantMessage): unknown[] {
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory") throw new Error("expected stored OpenAI Responses items");
	return payload.items;
}

function toolResultFor(message: AssistantMessage, text: string): ToolResultMessage {
	const call = message.content.find((block): block is ToolCall => block.type === "toolCall");
	if (!call) throw new Error(`expected a tool call in the turn (stop reason ${message.stopReason})`);
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: message.timestamp + 1,
	};
}

function functionCallItem(tag: string, createdBy: CreatedBy): Record<string, unknown> {
	return withCreatedBy(
		{
			id: `fc_${tag}`,
			type: "function_call",
			call_id: `call_${tag}`,
			name: "lookup",
			arguments: '{"query":"readme"}',
			status: "completed",
		},
		createdBy,
	);
}

/** A hosted shell call and its output, as one response returns them. */
function shellItems(tag: string, createdBy: CreatedBy): Array<Record<string, unknown>> {
	return [
		withCreatedBy(
			{
				id: `sh_${tag}`,
				type: "shell_call",
				call_id: `call_shell_${tag}`,
				action: { commands: ["ls"], max_output_length: null, timeout_ms: null },
				environment: null,
				status: "completed",
			},
			createdBy,
		),
		withCreatedBy(
			{
				id: `sho_${tag}`,
				type: "shell_call_output",
				call_id: `call_shell_${tag}`,
				max_output_length: null,
				status: "completed",
				output: [
					withCreatedBy({ stdout: "README.md\n", stderr: "", outcome: { type: "exit", exit_code: 0 } }, createdBy),
				],
			},
			createdBy,
		),
	];
}

/** Stream events of one response whose output is `items`, each item finished with `response.output_item.done`. */
function outputEvents(responseId: string, items: Array<Record<string, unknown>>): ResponsesWireEvent[] {
	const events: ResponsesWireEvent[] = [{ type: "response.created", response: { id: responseId } }];
	items.forEach((item, outputIndex) => {
		if (item.type === "function_call") {
			events.push(
				{
					type: "response.output_item.added",
					output_index: outputIndex,
					item: { ...item, arguments: "", status: "in_progress" },
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: outputIndex,
					item_id: item.id,
					delta: item.arguments,
				},
			);
		} else if (item.type === "custom_tool_call") {
			events.push({
				type: "response.output_item.added",
				output_index: outputIndex,
				item: { ...item, input: "", status: "in_progress" },
			});
		} else {
			events.push({ type: "response.output_item.added", output_index: outputIndex, item });
		}
		events.push({ type: "response.output_item.done", output_index: outputIndex, item });
	});
	events.push({
		type: "response.completed",
		response: { id: responseId, status: "completed", output: items, usage: USAGE },
	});
	return events;
}

/**
 * A compaction's replacement history as a user payload: a function call and
 * its output, and the compaction item, each with `created_by` as stored.
 */
function replacementHistoryMessage(provider: string, createdBy: CreatedBy): UserMessage {
	return {
		role: "user",
		content: "Summary of the earlier conversation",
		providerPayload: createOpenAIResponsesHistoryPayload(
			provider,
			[
				{ type: "message", role: "user", content: [{ type: "input_text", text: "Earlier request" }] },
				withCreatedBy(
					{
						id: "fc_earlier",
						type: "function_call",
						call_id: "call_earlier",
						name: "lookup",
						arguments: '{"query":"earlier"}',
						status: "completed",
					},
					createdBy,
				),
				withCreatedBy(
					{
						id: "fco_earlier",
						type: "function_call_output",
						call_id: "call_earlier",
						output: "earlier result",
						status: "completed",
					},
					createdBy,
				),
				withCreatedBy({ id: "cmp_earlier", type: "compaction", encrypted_content: "enc_earlier" }, createdBy),
			],
			false,
		),
		timestamp: 0,
	};
}

function responsesFetch(
	requests: Array<Record<string, unknown>>,
	respond: (index: number) => ResponsesWireEvent[],
	decode: (body: RequestInit["body"]) => string = body => String(body),
): FetchImpl {
	return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		requests.push(JSON.parse(decode(init?.body)) as Record<string, unknown>);
		return sse(respond(requests.length));
	}) as FetchImpl;
}

/** The Codex transport zstd-compresses request bodies. */
function decodeCodexRequestBody(body: RequestInit["body"]): string {
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(Bun.zstdDecompressSync(body));
	throw new Error("expected a string or binary Codex request body");
}

function createCodexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createCodexTestModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 128000,
	});
}

function useTempAgentDir(): void {
	const tempDir = piUtils.TempDir.createSync("@pi-created-by-replay-");
	piUtils.setAgentDir(tempDir.path());
	resources.push(() => tempDir.remove());
}

// ============================================================================
// (a) HTTP route, with previous_response_id chaining
// ============================================================================

/**
 * Turn 1 stores a response whose items carry `created_by`. On a new chain
 * state, turn 2 replays everything in full and its response carries the field
 * again; turn 3 must chain on turn 2's response.
 */
async function runHttpChain(createdBy: CreatedBy) {
	const requests: Array<Record<string, unknown>> = [];
	const fetch = responsesFetch(requests, index =>
		index === 3
			? textEvents("Done", "resp_3")
			: outputEvents(`resp_${index}`, [
					...shellItems(`http${index}`, createdBy),
					functionCallItem(`http${index}`, createdBy),
				]),
	);
	const options = { apiKey: "not-a-secret", sessionId: "created-by-http", statefulResponses: true, fetch };
	const replacement = replacementHistoryMessage("openai", createdBy);
	const user: UserMessage = { role: "user", content: "Find the readme", timestamp: 1 };
	const context = (messages: Message[]): Context => ({ systemPrompt: SYSTEM_PROMPT, messages, tools: [LOOKUP_TOOL] });

	const first = await streamOpenAIResponses(httpModel, context([replacement, user]), {
		...options,
		providerSessionState: new Map<string, ProviderSessionState>(),
	}).result();
	const providerSessionState = new Map<string, ProviderSessionState>();
	const messages: Message[] = [replacement, user, first, toolResultFor(first, "one")];
	const second = await streamOpenAIResponses(httpModel, context(messages), {
		...options,
		providerSessionState,
	}).result();
	messages.push(second, toolResultFor(second, "two"));
	const third = await streamOpenAIResponses(httpModel, context(messages), {
		...options,
		providerSessionState,
	}).result();
	expect(third.stopReason).toBe("stop");
	return { requests, first, second };
}

describe("created_by on the HTTP route (openai-responses)", () => {
	it.each(CREATED_BY_VALUES)(
		"replays stored items without created_by (%s) and chains the next request on previous_response_id",
		async (_label, createdBy) => {
			const run = await runHttpChain(createdBy);
			const control = await runHttpChain(undefined);
			// The stub's created_by reached the stored items, so the checks below can see it.
			expect(createdByPaths(storedItems(run.first))).toHaveLength(4);
			expect(createdByPaths(storedItems(run.second))).toHaveLength(4);
			expect(run.requests).toHaveLength(3);

			const full = inputOf(run.requests[1]);
			expect(run.requests[1]?.previous_response_id).toBeUndefined();
			expect(createdByPaths(inputOf(run.requests[0]))).toEqual([]);
			expect(createdByPaths(full)).toEqual([]);
			findItem(full, "function_call", "call_id", "call_http1");
			findItem(full, "shell_call_output", "call_id", "call_shell_http1");
			findItem(full, "function_call_output", "call_id", "call_earlier");
			expect(findItem(full, "compaction", "encrypted_content", "enc_earlier")).toEqual({
				type: "compaction",
				encrypted_content: "enc_earlier",
			});

			const chained = inputOf(run.requests[2]);
			expect(run.requests[2]?.previous_response_id).toBe("resp_2");
			expect(chained.map(item => item.type)).toEqual(["function_call_output"]);
			expect(createdByPaths(chained)).toEqual([]);

			// Nothing but created_by changed.
			expect(run.requests.map(inputOf)).toEqual(control.requests.map(inputOf));
		},
	);
});

// ============================================================================
// (b) Azure route: no native history of its own, only replayed payloads
// ============================================================================

const azureModel: Model<"azure-openai-responses"> = buildModel({
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
});

function azureAssistantTurn(createdBy: CreatedBy): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_azure|fc_azure", name: "lookup", arguments: { query: "readme" } }],
		api: "azure-openai-responses",
		provider: "azure",
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		providerPayload: createOpenAIResponsesHistoryPayload("azure", [
			...shellItems("azure", createdBy),
			functionCallItem("azure", createdBy),
		]),
		timestamp: 2,
	};
}

async function captureAzureRequest(createdBy: CreatedBy): Promise<Record<string, unknown>> {
	const assistant = azureAssistantTurn(createdBy);
	const context: Context = {
		systemPrompt: SYSTEM_PROMPT,
		tools: [LOOKUP_TOOL],
		messages: [
			replacementHistoryMessage("azure", createdBy),
			{ role: "user", content: "Find the readme", timestamp: 1 },
			assistant,
			toolResultFor(assistant, "one"),
		],
	};
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	streamAzureOpenAIResponses(azureModel, context, {
		apiKey: "not-a-secret",
		azureBaseUrl: azureModel.baseUrl,
		azureApiVersion: "v1",
		signal: AbortSignal.abort(),
		onPayload: payload => resolve(payload as Record<string, unknown>),
	});
	return promise;
}

describe("created_by on the Azure route (azure-openai-responses)", () => {
	it.each(CREATED_BY_VALUES)(
		"replays a compaction's replacement history and a stored turn without created_by (%s)",
		async (_label, createdBy) => {
			const input = inputOf(await captureAzureRequest(createdBy));
			const control = inputOf(await captureAzureRequest(undefined));
			expect(createdByPaths(input)).toEqual([]);
			findItem(input, "function_call_output", "call_id", "call_earlier");
			findItem(input, "compaction", "encrypted_content", "enc_earlier");
			findItem(input, "shell_call_output", "call_id", "call_shell_azure");
			findItem(input, "function_call", "call_id", "call_azure");
			expect(input).toEqual(control);
		},
	);
});

// ============================================================================
// (c) Codex route over SSE
// ============================================================================

function customToolCallItem(tag: string, createdBy: CreatedBy): Record<string, unknown> {
	return withCreatedBy(
		{
			id: `ctc_${tag}`,
			type: "custom_tool_call",
			call_id: `call_${tag}`,
			name: "apply_patch",
			input: "*** Begin Patch\n*** End Patch\n",
			status: "completed",
		},
		createdBy,
	);
}

async function runCodexSse(createdBy: CreatedBy) {
	const requests: Array<Record<string, unknown>> = [];
	const fetch = responsesFetch(
		requests,
		index =>
			index === 1
				? outputEvents("resp_codex_1", [customToolCallItem("codex", createdBy)])
				: textEvents("Done", `resp_codex_${index}`),
		decodeCodexRequestBody,
	);
	const model = createCodexTestModel();
	const options = {
		apiKey: createCodexTestToken(),
		fetch,
		sessionId: "created-by-codex-sse",
		providerSessionState: new Map<string, ProviderSessionState>(),
		preferWebsockets: false,
	};
	const replacement = replacementHistoryMessage("openai-codex", createdBy);
	const user: UserMessage = { role: "user", content: "Patch the readme", timestamp: 1 };
	const first = await streamOpenAICodexResponses(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [replacement, user] },
		options,
	).result();
	const second = await streamOpenAICodexResponses(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [replacement, user, first, toolResultFor(first, "patched")] },
		options,
	).result();
	expect(second.stopReason).toBe("stop");
	return { requests, first };
}

describe("created_by on the Codex route (openai-codex-responses)", () => {
	it.each(CREATED_BY_VALUES)(
		"replays a stored custom_tool_call and a replacement history's function_call_output without created_by (%s)",
		async (_label, createdBy) => {
			useTempAgentDir();
			const run = await runCodexSse(createdBy);
			const control = await runCodexSse(undefined);
			expect(createdByPaths(storedItems(run.first))).toHaveLength(1);
			expect(run.requests).toHaveLength(2);
			const input = inputOf(run.requests[1]);
			expect(createdByPaths(inputOf(run.requests[0]))).toEqual([]);
			expect(createdByPaths(input)).toEqual([]);
			findItem(input, "custom_tool_call", "call_id", "call_codex");
			findItem(input, "custom_tool_call_output", "call_id", "call_codex");
			findItem(input, "function_call_output", "call_id", "call_earlier");
			findItem(input, "compaction", "encrypted_content", "enc_earlier");
			expect(run.requests.map(inputOf)).toEqual(control.requests.map(inputOf));
		},
	);
});

// ============================================================================
// (d) Responses WebSocket session
// ============================================================================

/**
 * Session A stores a turn whose items carry `created_by`. Session B sends a
 * full request that replays them; its response carries the field again, and
 * the request after it must chain with only the new tool result.
 */
async function runWebSocketChain(createdBy: CreatedBy) {
	const wire = createEndpoint((socket: ResponsesSocket, _body, index) => {
		send(
			socket,
			index === 3
				? textEvents("Done", `resp_ws_${index}`)
				: outputEvents(`resp_ws_${index}`, [
						...shellItems(`ws${index}`, createdBy),
						functionCallItem(`ws${index}`, createdBy),
					]),
		);
	});
	const sessionA = new Map<string, ProviderSessionState>();
	const sessionB = new Map<string, ProviderSessionState>();
	resources.push(async () => {
		for (const state of [...sessionA.values(), ...sessionB.values()]) state.close();
		await wire.server.stop(true);
	});
	const model: Model<"openai-responses"> = { ...httpModel, baseUrl: `http://127.0.0.1:${wire.server.port}/v1` };
	const options = {
		apiKey: "not-a-secret",
		sessionId: "created-by-ws",
		preferWebsockets: true,
		streamFirstEventTimeoutMs: 5000,
		streamIdleTimeoutMs: 5000,
	};
	const user: UserMessage = { role: "user", content: "Find the readme", timestamp: 1 };
	const context = (messages: Message[]): Context => ({ systemPrompt: SYSTEM_PROMPT, messages, tools: [LOOKUP_TOOL] });

	const first = await streamOpenAIResponses(model, context([user]), {
		...options,
		providerSessionState: sessionA,
	}).result();
	const messages: Message[] = [user, first, toolResultFor(first, "one")];
	const second = await streamOpenAIResponses(model, context(messages), {
		...options,
		providerSessionState: sessionB,
	}).result();
	messages.push(second, toolResultFor(second, "two"));
	const third = await streamOpenAIResponses(model, context(messages), {
		...options,
		providerSessionState: sessionB,
	}).result();
	expect(third.stopReason).toBe("stop");
	return { requests: wire.requests.map(request => request.body), first, second };
}

describe("created_by on the Responses WebSocket session", () => {
	it.each(CREATED_BY_VALUES)(
		"sends a new session's full request without created_by (%s) and chains the next one",
		async (_label, createdBy) => {
			const run = await runWebSocketChain(createdBy);
			const control = await runWebSocketChain(undefined);
			expect(createdByPaths(storedItems(run.first))).toHaveLength(4);
			expect(createdByPaths(storedItems(run.second))).toHaveLength(4);
			expect(run.requests).toHaveLength(3);

			const full = inputOf(run.requests[1]);
			expect(run.requests[1]?.previous_response_id).toBeUndefined();
			expect(createdByPaths(full)).toEqual([]);
			findItem(full, "function_call", "call_id", "call_ws1");
			findItem(full, "shell_call_output", "call_id", "call_shell_ws1");

			const chained = inputOf(run.requests[2]);
			expect(run.requests[2]?.previous_response_id).toBe("resp_ws_2");
			expect(chained.map(item => item.type)).toEqual(["function_call_output"]);
			expect(createdByPaths(chained)).toEqual([]);

			expect(run.requests.map(inputOf)).toEqual(control.requests.map(inputOf));
		},
	);
});

// ============================================================================
// (e) Codex WebSocket session
// ============================================================================

/** The Codex transport's view of a WebSocket: `on*` handlers, `send`, `close`. */
class CodexStubSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static respond: (socket: CodexStubSocket, body: Record<string, unknown>) => void = () => {};
	static requests: Array<Record<string, unknown>> = [];

	readyState = CodexStubSocket.CONNECTING;
	binaryType: "blob" | "arraybuffer" | "nodebuffer" = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: Event) => void) | null = null;

	constructor(readonly url: string) {
		// Open after the transport has attached its handlers, as a real socket does.
		queueMicrotask(() => {
			this.readyState = CodexStubSocket.OPEN;
			this.onopen?.(new Event("open"));
		});
	}

	send(data: string): void {
		const body = JSON.parse(data) as Record<string, unknown>;
		CodexStubSocket.requests.push(body);
		CodexStubSocket.respond(this, body);
	}

	sendEvents(events: readonly ResponsesWireEvent[]): void {
		for (const event of events) this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
	}

	close(): void {
		this.readyState = CodexStubSocket.CLOSED;
	}
}

async function runCodexWebSocketChain(createdBy: CreatedBy) {
	CodexStubSocket.requests = [];
	CodexStubSocket.respond = socket => {
		const index = CodexStubSocket.requests.length;
		socket.sendEvents(
			index === 3
				? textEvents("Done", `resp_cws_${index}`)
				: outputEvents(`resp_cws_${index}`, [
						...shellItems(`cws${index}`, createdBy),
						functionCallItem(`cws${index}`, createdBy),
					]),
		);
	};
	global.WebSocket = CodexStubSocket as unknown as typeof WebSocket;
	const model = createCodexTestModel();
	const options = {
		apiKey: createCodexTestToken(),
		fetch: vi.fn(async () => {
			throw new Error("the SSE fallback must not be called");
		}) as FetchImpl,
		sessionId: "created-by-codex-ws",
	};
	const user: UserMessage = { role: "user", content: "Find the readme", timestamp: 1 };
	const context = (messages: Message[]): Context => ({ systemPrompt: SYSTEM_PROMPT, messages, tools: [LOOKUP_TOOL] });
	const sessionB = new Map<string, ProviderSessionState>();

	const first = await streamOpenAICodexResponses(model, context([user]), {
		...options,
		providerSessionState: new Map<string, ProviderSessionState>(),
	}).result();
	const messages: Message[] = [user, first, toolResultFor(first, "one")];
	const second = await streamOpenAICodexResponses(model, context(messages), {
		...options,
		providerSessionState: sessionB,
	}).result();
	messages.push(second, toolResultFor(second, "two"));
	const third = await streamOpenAICodexResponses(model, context(messages), {
		...options,
		providerSessionState: sessionB,
	}).result();
	expect(third.stopReason).toBe("stop");
	return { requests: [...CodexStubSocket.requests], first, second };
}

describe("created_by on the Codex WebSocket session", () => {
	it.each(CREATED_BY_VALUES)(
		"sends a new session's full request without created_by (%s) and chains the next one",
		async (_label, createdBy) => {
			useTempAgentDir();
			const run = await runCodexWebSocketChain(createdBy);
			const control = await runCodexWebSocketChain(undefined);
			expect(createdByPaths(storedItems(run.first))).toHaveLength(4);
			expect(createdByPaths(storedItems(run.second))).toHaveLength(4);
			expect(run.requests).toHaveLength(3);

			const full = inputOf(run.requests[1]);
			expect(run.requests[1]?.previous_response_id).toBeUndefined();
			expect(createdByPaths(full)).toEqual([]);
			findItem(full, "function_call", "call_id", "call_cws1");
			findItem(full, "shell_call_output", "call_id", "call_shell_cws1");

			const chained = inputOf(run.requests[2]);
			expect(run.requests[2]?.previous_response_id).toBe("resp_cws_2");
			expect(chained.map(item => item.type)).toEqual(["function_call_output"]);
			expect(createdByPaths(chained)).toEqual([]);

			expect(run.requests.map(inputOf)).toEqual(control.requests.map(inputOf));
		},
	);
});

// ============================================================================
// (h) A history stored before this fix, (i) a schema property named
// created_by, (j) item types no adapter rebuilds
// ============================================================================

async function captureHttpRequest(model: Model<"openai-responses">, messages: Message[]) {
	const requests: Array<Record<string, unknown>> = [];
	const fetch = responsesFetch(requests, index => textEvents("Done", `resp_capture_${index}`));
	const result = await streamOpenAIResponses(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages, tools: [LOOKUP_TOOL] },
		{ apiKey: "not-a-secret", sessionId: "created-by-capture", fetch },
	).result();
	expect(result.stopReason).toBe("stop");
	expect(requests).toHaveLength(1);
	return inputOf(requests[0]);
}

const toolSearchTools = [
	{
		type: "function",
		name: "find_owner",
		description: "Find who created a record",
		parameters: {
			type: "object",
			properties: { created_by: { type: "string", description: "The creator's id" } },
			required: ["created_by"],
		},
		strict: false,
	},
];

function toolSearchItems(createdBy: CreatedBy): Array<Record<string, unknown>> {
	return [
		withCreatedBy(
			{
				id: "tsc_1",
				type: "tool_search_call",
				call_id: "call_tool_search",
				arguments: { query: "owner" },
				execution: "client",
				status: "completed",
			},
			createdBy,
		),
		withCreatedBy(
			{
				id: "tso_1",
				type: "tool_search_output",
				call_id: "call_tool_search",
				execution: "client",
				status: "completed",
				tools: structuredClone(toolSearchTools),
			},
			createdBy,
		),
	];
}

/** Items of types that no replay adapter rebuilds for a model with custom tools and computer use. */
function untouchedTypeItems(createdBy: CreatedBy): Array<Record<string, unknown>> {
	return [
		withCreatedBy(
			{
				id: "ctc_kept",
				type: "custom_tool_call",
				call_id: "call_custom_kept",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch\n",
				status: "completed",
			},
			createdBy,
		),
		withCreatedBy(
			{ id: "ctco_kept", type: "custom_tool_call_output", call_id: "call_custom_kept", output: "patched" },
			createdBy,
		),
		withCreatedBy(
			{
				id: "cu_kept",
				type: "computer_call",
				call_id: "call_computer_kept",
				action: { type: "screenshot" },
				pending_safety_checks: [],
				status: "completed",
			},
			createdBy,
		),
		withCreatedBy(
			{
				id: "cuo_kept",
				type: "computer_call_output",
				call_id: "call_computer_kept",
				output: { type: "computer_screenshot", image_url: "data:image/png;base64,ZmFrZQ==" },
				acknowledged_safety_checks: [],
				status: "completed",
			},
			createdBy,
		),
		...toolSearchItems(createdBy),
		withCreatedBy({ id: "future_kept", type: "future_output_item", detail: "kept as stored" }, createdBy),
	];
}

function historyPayloadMessage(items: Array<Record<string, unknown>>): UserMessage {
	return {
		role: "user",
		content: "Summary of the earlier conversation",
		providerPayload: createOpenAIResponsesHistoryPayload("openai", items, false),
		timestamp: 0,
	};
}

describe("created_by in stored histories", () => {
	it("replays a history stored before the fix without created_by", async () => {
		const messages = structuredClone(storedSession.messages) as unknown as Message[];
		const stored = messages.flatMap(message =>
			message.role !== "toolResult" && message.providerPayload?.type === "openaiResponsesHistory"
				? message.providerPayload.items
				: [],
		);
		// The fixture holds the field where the old release kept it: three tool
		// items, a shell output entry, and the compaction item's null.
		expect(createdByPaths(stored)).toHaveLength(5);
		const input = await captureHttpRequest(httpModel, messages);
		expect(createdByPaths(input)).toEqual([]);
		findItem(input, "function_call", "call_id", "call_fixture_1");
		findItem(input, "shell_call", "call_id", "call_shell_fixture_1");
		expect(findItem(input, "shell_call_output", "call_id", "call_shell_fixture_1").output).toEqual([
			{ stdout: "README.md\n", stderr: "", outcome: { type: "exit", exit_code: 0 } },
		]);
		expect(findItem(input, "compaction", "encrypted_content", "enc_fixture_compaction")).toEqual({
			type: "compaction",
			encrypted_content: "enc_fixture_compaction",
		});
	});

	it.each(CREATED_BY_VALUES)(
		"keeps a tool schema property named created_by while dropping the item's own (%s)",
		async (_label, createdBy) => {
			const input = await captureHttpRequest(httpModel, [
				historyPayloadMessage(toolSearchItems(createdBy)),
				{ role: "user", content: "Who owns it?", timestamp: 1 },
			]);
			const control = await captureHttpRequest(httpModel, [
				historyPayloadMessage(toolSearchItems(undefined)),
				{ role: "user", content: "Who owns it?", timestamp: 1 },
			]);
			expect(createdByPaths(input)).toEqual([]);
			expect(findItem(input, "tool_search_output", "call_id", "call_tool_search").tools).toEqual(toolSearchTools);
			expect(input).toEqual(control);
		},
	);

	it.each(CREATED_BY_VALUES)(
		"drops created_by (%s) from custom tool, computer, tool search and undeclared item types",
		async (_label, createdBy) => {
			const model: Model<"openai-responses"> = {
				...httpModel,
				applyPatchToolType: "freeform",
				supportsComputerUse: true,
			};
			const messages = (items: Array<Record<string, unknown>>): Message[] => [
				historyPayloadMessage(items),
				{ role: "user", content: "Continue", timestamp: 1 },
			];
			const stored = untouchedTypeItems(createdBy);
			expect(createdByPaths(stored)).toHaveLength(stored.length);
			const input = await captureHttpRequest(model, messages(stored));
			const control = await captureHttpRequest(model, messages(untouchedTypeItems(undefined)));
			expect(createdByPaths(input)).toEqual([]);
			for (const item of stored) {
				expect(input.some(candidate => candidate.type === item.type)).toBe(true);
			}
			expect(input).toEqual(control);
		},
	);
});
