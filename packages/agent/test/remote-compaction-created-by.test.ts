import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@oh-my-pi/pi-agent-core/compaction";
import { getCompactionV2PreserveData } from "@oh-my-pi/pi-agent-core/compaction/openai";
import type { AssistantMessage, FetchImpl, Model, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";

const { isRecord } = piUtils;
const TEST_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Route = "v1" | "v2" | "codex-v2";
const ROUTES: Route[] = ["v1", "v2", "codex-v2"];
const ROUTE_ENDPOINT_SUFFIX: Record<Route, string> = {
	v1: "/v1/responses/compact",
	v2: "/v1/responses",
	"codex-v2": "/codex/responses",
};

function routeModel(route: Route): Model {
	const baseModel = buildModel({
		id: "gpt-5",
		name: "GPT-5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		remoteCompaction: { enabled: true, v2StreamingEnabled: route !== "v1" },
	});
	if (route !== "codex-v2") return baseModel;
	return {
		...baseModel,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.example/backend-api",
		preferWebsockets: false,
		remoteCompaction: { enabled: true, api: "openai-codex-responses", v2StreamingEnabled: true },
	};
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/**
 * Replacement history as an earlier release stored it: output items kept whole,
 * `created_by` included (a string, or `null` as seen live on a compaction item).
 * The function call answered by the tagged output is there so the Codex
 * serializer keeps the pair instead of folding an orphan output into a message.
 */
function storedReplacementHistory(): Array<Record<string, unknown>> {
	return [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "earlier user turn" }] },
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "kept answer", annotations: [] }],
			created_by: "svc_x",
		},
		{ type: "function_call", call_id: "call_prev_tagged", name: "read", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_prev_tagged", output: "tagged output", created_by: "svc_x" },
		{
			type: "shell_call_output",
			call_id: "call_prev_shell",
			output: [
				{ stdout: "tagged stdout", stderr: "", outcome: { type: "exit", exit_code: 0 }, created_by: "svc_x" },
				{ stdout: "", stderr: "", outcome: { type: "timeout" } },
			],
			created_by: "svc_x",
		},
		// Controls: the same item types without created_by.
		{ type: "function_call", call_id: "call_prev_plain", name: "read", arguments: "{}" },
		{ type: "function_call_output", call_id: "call_prev_plain", output: "plain output" },
		{
			type: "shell_call_output",
			call_id: "call_prev_shell_plain",
			output: [{ stdout: "plain stdout", stderr: "", outcome: { type: "exit", exit_code: 0 } }],
		},
		{ type: "compaction", encrypted_content: "enc_prev", created_by: null },
	];
}

/** Each stored item as the request must carry it: unchanged except that created_by is gone. */
const REPLAYED_HISTORY: Array<Record<string, unknown>> = [
	{ type: "message", role: "user", content: [{ type: "input_text", text: "earlier user turn" }] },
	{ type: "message", role: "assistant", content: [{ type: "output_text", text: "kept answer", annotations: [] }] },
	{ type: "function_call", call_id: "call_prev_tagged", name: "read", arguments: "{}" },
	{ type: "function_call_output", call_id: "call_prev_tagged", output: "tagged output" },
	{
		type: "shell_call_output",
		call_id: "call_prev_shell",
		output: [
			{ stdout: "tagged stdout", stderr: "", outcome: { type: "exit", exit_code: 0 } },
			{ stdout: "", stderr: "", outcome: { type: "timeout" } },
		],
	},
	{ type: "function_call", call_id: "call_prev_plain", name: "read", arguments: "{}" },
	{ type: "function_call_output", call_id: "call_prev_plain", output: "plain output" },
	{
		type: "shell_call_output",
		call_id: "call_prev_shell_plain",
		output: [{ stdout: "plain stdout", stderr: "", outcome: { type: "exit", exit_code: 0 } }],
	},
	{ type: "compaction", encrypted_content: "enc_prev" },
];

/** The stored payload's function call on the wire: the Responses replay sanitizer also drops its id and status. */
const REPLAYED_PAYLOAD_CALL = { type: "function_call", call_id: "call_live", name: "read", arguments: "{}" };

/** An assistant turn whose stored `providerPayload` holds its output item whole, created_by included. */
function assistantWithStoredCall(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_live|fc_call_live", name: "read", arguments: {} }],
		timestamp: 2,
		provider: model.provider,
		model: model.id,
		api: model.api,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: model.provider,
			dt: true,
			items: [
				{
					type: "function_call",
					id: "fc_call_live",
					call_id: "call_live",
					name: "read",
					arguments: "{}",
					status: "completed",
					created_by: "svc_x",
				},
			],
		},
	};
}

function storedCallResult(): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_live|fc_call_live",
		toolName: "read",
		content: [{ type: "text", text: "file body" }],
		isError: false,
		timestamp: 3,
	};
}

/** Preserve data in the shape each route stores it. */
function storedPreserveData(
	route: Route,
	provider: string,
	replacementHistory: Array<Record<string, unknown>>,
): Record<string, unknown> {
	if (route === "v1") {
		return {
			openaiRemoteCompaction: {
				provider,
				replacementHistory,
				compactionItem: replacementHistory.findLast(item => item.type === "compaction"),
			},
		};
	}
	return { openaiRemoteCompaction: { version: "v2", provider, replacementHistory, usedTokens: 1200 } };
}

function makePreparation(
	route: Route,
	messagesToSummarize: CompactionPreparation["messagesToSummarize"],
	previousPreserveData?: Record<string, unknown>,
): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize,
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent", timestamp: 4 }],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: snapcompact.createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteStreamingV2Enabled: route !== "v1" },
		previousPreserveData,
	};
}

interface CapturedRequest {
	url: string;
	input: Array<Record<string, unknown>>;
}

/**
 * Capture every compaction request body. Each response returns a compaction
 * item stamped `created_by: null`, as the API sent one live.
 */
function stubCompactionFetch(route: Route): { fetch: FetchImpl; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const fetch: FetchImpl = async (input, init) => {
		const body: unknown = JSON.parse(String(init?.body));
		if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("compaction request has no input array");
		requests.push({ url: String(input), input: body.input.filter(isRecord) });
		const item = { type: "compaction", encrypted_content: `enc_${requests.length}`, created_by: null };
		return route === "v1"
			? Response.json({ output: [item] })
			: sseResponse([
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: { usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } },
					},
				]);
	};
	return { fetch, requests };
}

/** Every place an input holds a `created_by` key, at any value: item top level and `shell_call_output` entries. */
function createdByPaths(items: ReadonlyArray<Record<string, unknown>>): string[] {
	const paths: string[] = [];
	for (const [index, item] of items.entries()) {
		if (Object.hasOwn(item, "created_by")) paths.push(`[${index}].created_by`);
		if (item.type !== "shell_call_output" || !Array.isArray(item.output)) continue;
		for (const [entryIndex, entry] of item.output.entries()) {
			if (isRecord(entry) && Object.hasOwn(entry, "created_by")) {
				paths.push(`[${index}].output[${entryIndex}].created_by`);
			}
		}
	}
	return paths;
}

/** Identity of a replayed item, independent of created_by, id and status. */
function replayKey(item: Record<string, unknown>): string {
	const firstPart = Array.isArray(item.content) && isRecord(item.content[0]) ? item.content[0].text : undefined;
	return JSON.stringify([item.type, item.role, item.call_id, item.encrypted_content, firstPart]);
}

async function compactWithStoredHistory(route: Route) {
	const model = routeModel(route);
	const history = storedReplacementHistory();
	// Control: the probe sees the key wherever the fixture holds it, `null` included.
	expect(createdByPaths(history)).toEqual([
		"[1].created_by",
		"[3].created_by",
		"[4].created_by",
		"[4].output[0].created_by",
		"[8].created_by",
	]);
	const { fetch, requests } = stubCompactionFetch(route);
	const preparation = makePreparation(
		route,
		[{ role: "user", content: "long history", timestamp: 1 }, assistantWithStoredCall(model), storedCallResult()],
		storedPreserveData(route, model.provider, history),
	);
	const result = await compact(preparation, model, "test-key", undefined, undefined, { fetch });
	expect(requests).toHaveLength(1);
	expect(requests[0]!.url).toEndWith(ROUTE_ENDPOINT_SUFFIX[route]);
	expect(getCompactionV2PreserveData(result.preserveData)?.provider).toBe(model.provider);
	// The strip copies; the stored history keeps what the API sent.
	expect(history).toStrictEqual(storedReplacementHistory());
	return requests[0]!.input;
}

function expectReplayedWithoutCreatedBy(
	input: Array<Record<string, unknown>>,
	payloadCall: Record<string, unknown>,
): void {
	expect(createdByPaths(input)).toEqual([]);
	for (const expected of [...REPLAYED_HISTORY, payloadCall]) {
		expect(input.filter(item => replayKey(item) === replayKey(expected))).toStrictEqual([expected]);
	}
}

// The Responses API sets `created_by` on its output items and refuses any input
// item that holds it: `400 Unknown parameter: input[7].created_by`.
describe("remote compaction replays stored output items without created_by", () => {
	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue(TEST_INSTALLATION_ID);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("V2 HTTP compaction request drops created_by from the stored replacement history (string, null, shell output entry) and the stored assistant payload", async () => {
		const input = await compactWithStoredHistory("v2");

		expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
		expectReplayedWithoutCreatedBy(input, REPLAYED_PAYLOAD_CALL);
	});

	test("V2 Codex compaction request drops created_by from the stored replacement history (string, null, shell output entry) and the stored assistant payload", async () => {
		const input = await compactWithStoredHistory("codex-v2");

		expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
		expectReplayedWithoutCreatedBy(input, REPLAYED_PAYLOAD_CALL);
	});

	test("V1 /responses/compact request drops created_by from the stored replacement history (string, null, shell output entry) and the stored assistant payload", async () => {
		const input = await compactWithStoredHistory("v1");

		// V1 replays stored payload items without the sanitizer, so the item id stays.
		expectReplayedWithoutCreatedBy(input, { ...REPLAYED_PAYLOAD_CALL, id: "fc_call_live" });
	});

	test.each(ROUTES)(
		"a compaction item the API returned with created_by: null goes into the next compaction request without created_by (%s)",
		async route => {
			const model = routeModel(route);
			const { fetch, requests } = stubCompactionFetch(route);
			const preparation = makePreparation(route, [{ role: "user", content: "long history", timestamp: 1 }]);

			const first = await compact(preparation, model, "test-key", undefined, undefined, { fetch });
			// omp stores the output item as the API sent it.
			expect(getCompactionV2PreserveData(first.preserveData)?.replacementHistory.at(-1)).toStrictEqual({
				type: "compaction",
				encrypted_content: "enc_1",
				created_by: null,
			});

			await compact(
				{ ...preparation, previousSummary: first.summary, previousPreserveData: first.preserveData },
				model,
				"test-key",
				undefined,
				undefined,
				{ fetch },
			);

			expect(requests).toHaveLength(2);
			for (const request of requests) expect(request.url).toEndWith(ROUTE_ENDPOINT_SUFFIX[route]);
			const second = requests[1]!.input;
			expect(second.filter(item => item.encrypted_content === "enc_1")).toStrictEqual([
				{ type: "compaction", encrypted_content: "enc_1" },
			]);
			expect(createdByPaths(second)).toEqual([]);
		},
	);
});
