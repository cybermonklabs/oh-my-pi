import { vi } from "bun:test";
import { SUMMARIZATION_SYSTEM_PROMPT } from "@oh-my-pi/pi-agent-core/compaction/utils";
import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { logger } from "@oh-my-pi/pi-utils";
import { answer, GATEWAY, type MessagesRequest, textOf } from "./anthropic-gateway";
import { asGlobalFetch } from "./fetch-mock";

/** What the transcript's newest reply says its request sent, far below the context the next requests send. */
const EARLIER_PROMPT_TOKENS = 1_000;
const FILLER = "the quick brown fox jumps over the lazy dog. ".repeat(64);
const TURNS = 64;

/** The rule's answer for the model-summary compaction while it waits, as a {@link GatewayRecording.timeline} entry. */
export const SUMMARY_COMPACTION_WAITS = "cut rule: compaction-soft waits";

/** A request the gateway received: a main request for the prompt being sent, a summary request, or another. */
export interface SentRequest {
	body: MessagesRequest;
	kind: "main" | "summary" | "other";
}

/** The transcript a session holds: 64 turns, ~90,000 tokens, whose newest reply sent a small prompt. */
export function transcript(): (UserMessage | AssistantMessage)[] {
	const now = Date.now();
	const messages: (UserMessage | AssistantMessage)[] = [];
	for (let i = 0; i < TURNS; i++) {
		messages.push({
			role: "user",
			content: [{ type: "text", text: `turn ${i}: ${FILLER}` }],
			timestamp: now - 60_000,
		});
		const promptTokens = i === TURNS - 1 ? EARLIER_PROMPT_TOKENS : 0;
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `reply ${i}: ${FILLER}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: promptTokens > 0 ? 100 : 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens > 0 ? promptTokens + 100 : 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: now - 59_000,
		});
	}
	return messages;
}

/** Whether `request` is the main request for `prompt`: its last message is the user's prompt. */
export function sendsPrompt(request: MessagesRequest, prompt: string): boolean {
	const last = request.messages.at(-1);
	return last?.role === "user" && textOf(last.content).includes(prompt);
}

/** The settings a process loads: summary compaction in the background over `thresholdTokens`. */
export function processSettings(thresholdTokens: number): Settings {
	return Settings.isolated({
		"providers.cacheRetention": "long",
		"compaction.methodOrder": ["soft"],
		"compaction.asyncEnabled": true,
		"compaction.autoContinue": false,
		"compaction.keepRecentTokens": 4000,
		"compaction.thresholdTokens": thresholdTokens,
	});
}

/** What the gateway received and the cut rule decided while a {@link recordGateway} spy stood. */
export interface GatewayRecording {
	/** Every request sent, oldest first. */
	requests: SentRequest[];
	/** Each request (`<kind> request`) and each cut rule decision (`cut rule: <site> <reason>`), in order. */
	timeline: string[];
	/** Sends `prompt` on `session` and lets the background summary it starts settle before returning. */
	send(session: AgentSession, prompt: string): Promise<void>;
	/** Puts the real `fetch` and `logger.debug` back. */
	restore(): void;
}

/**
 * Spies on `fetch` as the gateway and on the logger's debug records: each request is recorded with its kind and
 * answered, a main request with a reply that wrote `replyPromptTokens` to the prompt cache; a request to any other URL
 * throws. Each cut rule decision is recorded too.
 */
export function recordGateway(replyPromptTokens: number): GatewayRecording {
	const requests: SentRequest[] = [];
	const timeline: string[] = [];
	let current = "";
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (input, init) => {
			const url = String(input);
			if (url !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${url}`);
			const body = JSON.parse(requestBodyText(init) ?? "{}") as MessagesRequest;
			const kind = sendsPrompt(body, current)
				? "main"
				: textOf(body.system).includes(SUMMARIZATION_SYSTEM_PROMPT)
					? "summary"
					: "other";
			requests.push({ body, kind });
			timeline.push(`${kind} request`);
			return kind === "main"
				? answer(requests.length, { cacheWriteTokens: replyPromptTokens })
				: answer(requests.length);
		}),
	);
	// The background summary logs when it arms or fails; each prompt waits for that before the next one.
	let speculationSettled: (() => void) | undefined;
	const debug = logger.debug.bind(logger);
	const debugSpy = vi.spyOn(logger, "debug").mockImplementation((message, context) => {
		if (message === "Context cut decision" && context) {
			timeline.push(`cut rule: ${String(context.site)} ${String(context.reason)}`);
		}
		if (message === "Speculative compaction armed" || message === "Speculative compaction failed") {
			speculationSettled?.();
		}
		return debug(message, context);
	});
	return {
		requests,
		timeline,
		async send(session, prompt) {
			current = prompt;
			await session.prompt(prompt);
			await session.waitForIdle();
			if (session.compactionSpeculation !== "running") return;
			const settled = Promise.withResolvers<void>();
			speculationSettled = settled.resolve;
			await settled.promise;
		},
		restore() {
			fetchSpy.mockRestore();
			debugSpy.mockRestore();
		},
	};
}
