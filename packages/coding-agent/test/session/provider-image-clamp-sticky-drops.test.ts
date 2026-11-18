import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
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

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function userTurn(label: string, timestamp: number, images: string[]): Message {
	return { role: "user", content: [text(label), ...images.map(image)], timestamp };
}

/** `turns` user turns from turn 0, each attaching 3 images named `image-<turn>-<index>`. */
function conversation(turns: number): Message[] {
	return Array.from({ length: turns }, (_, turn) =>
		userTurn(
			`turn-${turn}`,
			turn,
			[0, 1, 2].map(index => `image-${turn}-${index}`),
		),
	);
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

describe("ProviderImageClamp sticky count drops", () => {
	it("sends the images a user attaches on a branch whose images fit the budget, after a longer branch forced a drop", () => {
		const clamp = new ProviderImageClamp();
		// Turns 0-3 carry 12 images: the clamp drops the 7 oldest and sends 5.
		expect(imageData(clamp.clampImageCount(request(conversation(4)), UMANS_MODEL))).toHaveLength(5);

		// The user rewinds to turn 0 and attaches 3 new images there: 6 images, well inside the budget of 10.
		const branch = request([...conversation(1), userTurn("branch turn", 50, ["new-0", "new-1", "new-2"])]);
		const sent = imageData(clamp.clampImageCount(branch, UMANS_MODEL));

		// The images the user just attached must reach the model.
		expect(sent).toEqual(expect.arrayContaining(["new-0", "new-1", "new-2"]));
	});

	it("keeps sending the newest images after a prune removes images between them and the oldest one", () => {
		const clamp = new ProviderImageClamp();
		// 12 images: turns 0-3; the clamp sends image-2-1, image-2-2 and turn 3's three.
		const before = imageData(clamp.clampImageCount(request(conversation(4)), UMANS_MODEL));
		expect(before).toEqual(["image-2-1", "image-2-2", "image-3-0", "image-3-1", "image-3-2"]);

		// A prune blanks turns 1 and 2 (e.g. superseded image reads): 6 images remain, inside the budget of 10.
		const [turn0, , , turn3] = conversation(4);
		const pruned = request([turn0, userTurn("turn-1", 1, []), userTurn("turn-2", 2, []), turn3]);
		const sent = imageData(clamp.clampImageCount(pruned, UMANS_MODEL));

		// Turn 3's images went out in the previous request and still fit: they must not vanish now.
		expect(sent).toEqual(expect.arrayContaining(["image-3-0", "image-3-1", "image-3-2"]));
	});
});
