import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ProviderImageClamp } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";

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

const PRUNED_NOTICE = "[Output pruned]";

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function screenshotCall(turn: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `shot-${turn}`, name: "screenshot", arguments: {} }],
		api: UMANS_MODEL.api,
		provider: UMANS_MODEL.provider,
		model: UMANS_MODEL.id,
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: turn * 10 + 1,
	};
}

/** Turn `turn`'s tool result: three screenshots named `shot-<turn>-<index>`. */
function screenshots(turn: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `shot-${turn}`,
		toolName: "screenshot",
		content: [
			{ type: "text", text: `screenshots of step ${turn}` },
			...[0, 1, 2].map(index => image(`shot-${turn}-${index}`)),
		],
		isError: false,
		timestamp: turn * 10 + 2,
	};
}

/** Turn `turn`'s tool result as a prune pass leaves it: its content blanked to the notice. */
function prunedScreenshots(turn: number): ToolResultMessage {
	return { ...screenshots(turn), content: [{ type: "text", text: PRUNED_NOTICE }], prunedAt: 1 };
}

/** The user's request and turns `0..turns-1`, each a screenshot call and its three-image result. */
function history(turns: number, prunedTurns: readonly number[] = []): Message[] {
	const messages: Message[] = [{ role: "user", content: "Walk through the setup wizard.", timestamp: 0 }];
	for (let turn = 0; turn < turns; turn++) {
		messages.push(screenshotCall(turn), prunedTurns.includes(turn) ? prunedScreenshots(turn) : screenshots(turn));
	}
	return messages;
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

describe("ProviderImageClamp after a prune of the oldest image", () => {
	it("keeps sending the images it sent before a prune blanked the result that carried the oldest image", () => {
		const forced: string[] = [];
		const clamp = new ProviderImageClamp(site => forced.push(site));

		// Four screenshot turns, 12 images over the budget of 10: the clamp drops the 7 oldest and sends 5.
		expect(imageData(clamp.clampImageCount(request(history(4)), UMANS_MODEL))).toEqual([
			"shot-2-1",
			"shot-2-2",
			"shot-3-0",
			"shot-3-1",
			"shot-3-2",
		]);
		// A fifth turn: 15 images, 8 of them sent, inside the budget, so the same 7 are dropped again.
		const sentBefore = imageData(clamp.clampImageCount(request(history(5)), UMANS_MODEL));
		expect(sentBefore).toEqual([
			"shot-2-1",
			"shot-2-2",
			"shot-3-0",
			"shot-3-1",
			"shot-3-2",
			"shot-4-0",
			"shot-4-1",
			"shot-4-2",
		]);
		expect(forced).toEqual(["image-count-clamp"]);

		// An aged-result prune blanks the oldest tool result (turn 0), whose images the clamp already dropped.
		// The request now carries 12 images; without the 4 the clamp dropped before, it sends the same 8 as the
		// previous request, inside the budget: no image it sent goes missing and no drop is forced.
		const sentAfter = imageData(clamp.clampImageCount(request(history(5, [0])), UMANS_MODEL));
		expect({ sent: sentAfter, forced }).toEqual({ sent: sentBefore, forced: ["image-count-clamp"] });
	});
});
