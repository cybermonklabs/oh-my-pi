/**
 * The image count clamp names each image by the turn that carries it (its role and timestamp) and its bytes, and
 * numbers a turn's later copies of the same bytes (`#1`, `#2`). Two tool results of one parallel batch that finish in
 * the same millisecond are two turns with one name, so two copies of the same screenshot in them are numbered across
 * both results. These cases make a forced drop drop the first copy and keep the second, then prune the first result:
 * the second copy is the one the budget carried, and it should still be sent.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	clampProviderContextImages,
	ProviderImageClamp,
	sessionImageDropRecord,
} from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

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

/** The screenshot both calls of the parallel batch return: the screen did not change between them. */
const SAME_SCREEN = "screen-unchanged";

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function calls(ids: string[], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map(id => ({ type: "toolCall" as const, id, name: "screenshot", arguments: {} })),
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
		timestamp,
	};
}

function result(id: string, timestamp: number, images: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "screenshot",
		content: [{ type: "text", text: `screenshots of ${id}` }, ...images.map(image)],
		isError: false,
		timestamp,
	};
}

/** The results an aged-result prune blanks: steps 0 and 1 and call a's, older than the protected tail. */
const PRUNED_RESULTS = ["s0", "s1", "a"];

/** `messages` as a prune pass leaves them: each of {@link PRUNED_RESULTS} blanked to the notice. */
function prune(messages: Message[]): Message[] {
	return messages.map(message =>
		message.role === "toolResult" && PRUNED_RESULTS.includes(message.toolCallId)
			? { ...message, content: [{ type: "text", text: PRUNED_NOTICE }], prunedAt: 1 }
			: message,
	);
}

/**
 * The user's request; two steps of three screenshots; a parallel batch of two calls whose results carry the same
 * screenshot and finish at `batchB`'s timestamp (`batchA` for the first); a step of four screenshots.
 */
function history(batchA: number, batchB: number): Message[] {
	return [
		{ role: "user", content: "Walk through the setup wizard.", timestamp: 0 },
		calls(["s0"], 1),
		result("s0", 2, ["s0-0", "s0-1", "s0-2"]),
		calls(["s1"], 11),
		result("s1", 12, ["s1-0", "s1-1", "s1-2"]),
		calls(["a", "b"], 21),
		result("a", batchA, [SAME_SCREEN]),
		result("b", batchB, [SAME_SCREEN]),
		calls(["s3"], 31),
		result("s3", 32, ["s3-0", "s3-1", "s3-2", "s3-3"]),
	];
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

/**
 * The images the request after the prune sends: a forced drop at the last step keeps the five newest images (call
 * b's copy and step 3's four), then a prune blanks steps 0 and 1 and call a's result.
 */
function sentAfterPrune(batchA: number, batchB: number): { beforePrune: string[]; afterPrune: string[] } {
	const clamp = new ProviderImageClamp(undefined, sessionImageDropRecord(SessionManager.inMemory()));
	const messages = history(batchA, batchB);
	const beforePrune = imageData(clamp.clampImageCount(request(messages), UMANS_MODEL));
	const afterPrune = imageData(clamp.clampImageCount(request(prune(messages)), UMANS_MODEL));
	return { beforePrune, afterPrune };
}

describe("ProviderImageClamp with two results of one batch stamped in the same millisecond", () => {
	it("keeps sending the copy the budget carried once a prune blanks the result that carried the dropped copy", () => {
		const { beforePrune, afterPrune } = sentAfterPrune(22, 22);
		// Precondition: the forced drop dropped call a's copy and kept call b's.
		expect(beforePrune).toEqual([SAME_SCREEN, "s3-0", "s3-1", "s3-2", "s3-3"]);
		// Five images after the prune, inside the budget of 10: call b's copy was sent in the request before the
		// prune, and the drop that took call a's copy was not for it.
		expect(afterPrune).toEqual([SAME_SCREEN, "s3-0", "s3-1", "s3-2", "s3-3"]);
	});

	it("keeps sending it when the two results finished in different milliseconds", () => {
		const { beforePrune, afterPrune } = sentAfterPrune(22, 23);
		expect(beforePrune).toEqual([SAME_SCREEN, "s3-0", "s3-1", "s3-2", "s3-3"]);
		expect(afterPrune).toEqual([SAME_SCREEN, "s3-0", "s3-1", "s3-2", "s3-3"]);
	});

	it("is what the clamp without remembered drops sends for the pruned request", () => {
		expect(imageData(clampProviderContextImages(request(prune(history(22, 22))), UMANS_MODEL))).toEqual([
			SAME_SCREEN,
			"s3-0",
			"s3-1",
			"s3-2",
			"s3-3",
		]);
	});
});
