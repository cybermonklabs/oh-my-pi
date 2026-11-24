/**
 * The image count clamp keeps dropping, in later requests of a conversation, the images its last forced drop chose for
 * the model's image budget, so those requests read the model's cached prompt. A request on a model with another
 * budget drops for that budget. These cases send a conversation past one model's budget, make one request on a model
 * with a smaller budget, and switch back while the first model's cached prompt is still there to read.
 */
import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, Message } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ProviderImageClamp, sessionImageDropRecord } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { providerImageBudget } from "@oh-my-pi/snapcompact";

/** A proxy of Anthropic's API takes 90 images a request. */
const PROXY_MODEL = buildModel({
	id: "claude-test",
	name: "claude-test",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://anthropic-proxy.example.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 4096,
});

/** The Umans route takes 10 images a request. */
const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

/** `turns` user turns, each attaching three screenshots named `image-<turn>-<index>`. */
function conversation(turns: number): Message[] {
	return Array.from({ length: turns }, (_, turn) => ({
		role: "user" as const,
		content: [
			{ type: "text" as const, text: `turn-${turn}` },
			...Array.from({ length: 3 }, (_, index): ImageContent => ({
				type: "image",
				data: `image-${turn}-${index}`,
				mimeType: "image/png",
			})),
		],
		timestamp: turn,
	}));
}

function request(messages: Message[]): Context {
	return { systemPrompt: ["system"], tools: [], messages };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

/** Whether `later` sends every message `earlier` sent with the same bytes, so its prompt cache prefix still reads. */
function continuesPrefix(earlier: Context, later: Context): boolean {
	const serialize = (messages: Message[]) => messages.map(message => JSON.stringify(message));
	return Bun.deepEquals(serialize(later.messages.slice(0, earlier.messages.length)), serialize(earlier.messages));
}

describe("ProviderImageClamp across a request on a model with another image budget", () => {
	/**
	 * 31 turns (93 images) pass the proxy's budget of 90: the forced drop keeps the 45 newest. The proxy's next request
	 * (96 images) drops the same 48. One request on the Umans route (budget 10) makes a forced drop of its own. Then
	 * the proxy's request after that, with one more turn, is clamped by `back`.
	 */
	function detour(back: (sessionManager: SessionManager, live: ProviderImageClamp) => ProviderImageClamp): {
		before: Context;
		after: Context;
		detoured: Context;
	} {
		const sessionManager = SessionManager.inMemory();
		const live = new ProviderImageClamp(undefined, sessionImageDropRecord(sessionManager));
		live.clampImageCount(request(conversation(31)), PROXY_MODEL);
		const before = live.clampImageCount(request(conversation(32)), PROXY_MODEL);
		const detoured = live.clampImageCount(request(conversation(32)), UMANS_MODEL);
		const after = back(sessionManager, live).clampImageCount(request(conversation(33)), PROXY_MODEL);
		return { before, after, detoured };
	}

	it("drops for the proxy what it dropped before the request on the Umans route", () => {
		expect([providerImageBudget(PROXY_MODEL), providerImageBudget(UMANS_MODEL)]).toEqual([90, 10]);
		const { before, after, detoured } = detour((_, live) => live);
		// Preconditions: the proxy sent the 48 images after the 48 it dropped, and the Umans route sent 5.
		expect({ before: imageData(before).length, detoured: imageData(detoured).length }).toEqual({
			before: 48,
			detoured: 5,
		});
		// 51 images fit the proxy's budget with its 48 drops: its request sends what it sent before the detour, and
		// the new turn's three images after it, so it reads the proxy's cached prompt.
		expect({ sent: imageData(after).length, continues: continuesPrefix(before, after) }).toEqual({
			sent: 51,
			continues: true,
		});
	});

	it("drops for the proxy what it dropped before the request on the Umans route in a process that resumes the session", () => {
		const { before, after } = detour(
			sessionManager => new ProviderImageClamp(undefined, sessionImageDropRecord(sessionManager)),
		);
		expect({ sent: imageData(after).length, continues: continuesPrefix(before, after) }).toEqual({
			sent: 51,
			continues: true,
		});
	});
});
