import { ContainerPath, type NestedWalk, runNested, stringifyDeepJson } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/**
 * Each turn writes its calls' arguments: arguments nested past `JSON.stringify`'s recursion skip the
 * attempt that would run out of stack (1.5 s or more each time) and go to the deep writer.
 */
const CANONICAL_JSON = { probeDepth: true } as const;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/** Lets transport calls inherit an exemption from their dispatched tool without exempting the transport itself. */
	readonly exemptionAlias?: (call: ToolCall) => string | undefined;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
	/** The turn also delivered context outside its tool results (extension `additionalContext`). */
	readonly injectedContext?: boolean;
}

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: "repeated_tool_call";
	readonly toolName: string;
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
}

/**
 * `value` with each object's keys sorted and its intent fields left out, arrays in order. The walk
 * keeps its own stack ({@link runNested}): a tool call's arguments are any JSON, as deep as
 * `JSON.parse` reads (millions of levels), where a recursive walk stops near 22,000.
 */
function canonicalizeToolCallValue(value: unknown): unknown {
	return value && typeof value === "object" ? runNested(canonicalToolCallNode(value, new ContainerPath())) : value;
}

/** {@link canonicalizeToolCallValue} of `value`, an object `path` is inside of; each child object is a nested step. */
function* canonicalToolCallNode(value: object, path: ContainerPath): NestedWalk {
	path.enter(value);
	if (Array.isArray(value)) {
		const items: unknown[] = [];
		for (const item of value) {
			items.push(item && typeof item === "object" ? yield canonicalToolCallNode(item, path) : item);
		}
		path.leave(value);
		return items;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		const item = input[key];
		output[key] = item && typeof item === "object" ? yield canonicalToolCallNode(item, path) : item;
	}
	path.leave(value);
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#exemptionAlias: ((call: ToolCall) => string | undefined) | undefined;
	#lastHash: string | undefined;
	#count = 0;

	/** Keeps transport-specific exemption policy outside the shared repetition detector. */
	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
		this.#exemptionAlias = options.exemptionAlias;
	}

	/** Applies the same exemption policy when counting turns and choosing the reported call. */
	#isExempt(call: ToolCall): boolean {
		if (this.#exemptTools.has(call.name)) return true;
		const alias = this.#exemptionAlias?.(call);
		return alias !== undefined && this.#exemptTools.has(alias);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#lastHash = undefined;
			this.#count = 0;
			return null;
		}
		if (toolCalls.every(tc => this.#isExempt(tc))) {
			// An exempt poll its tool flagged useless (a wait that elapsed or found
			// nothing to wait for) is skipped, so alternating it with a repeated call
			// cannot hide the loop. Any other exempt turn, failures included, may have
			// changed state (finished jobs, a message, injected context), so it ends
			// the repetition.
			const idle =
				!turn.injectedContext &&
				toolCalls.every(tc => turn.toolResults.find(result => result.toolCallId === tc.id)?.useless === true);
			if (!idle) {
				this.#lastHash = undefined;
				this.#count = 0;
			}
			return null;
		}

		const canonicalCalls = toolCalls
			.map(tc => stringifyDeepJson([tc.name, canonicalizeToolCallValue(tc.arguments)], CANONICAL_JSON))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}

		if (this.#count < this.#threshold) return null;
		const reportCall = toolCalls.find(tc => !this.#isExempt(tc)) ?? toolCalls[0]!;
		return {
			kind: "repeated_tool_call",
			toolName: reportCall.name,
			count: this.#count,
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
			argumentsSummary: summarizeText(
				stringifyDeepJson(canonicalizeToolCallValue(reportCall.arguments), CANONICAL_JSON) ?? "",
				ARGUMENT_SUMMARY_LIMIT,
			),
		};
	}
}
