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

describe("ProviderImageClamp forced count drop", () => {
	it("sends every image of the newest user message when those images fit the budget on their own", () => {
		const clamp = new ProviderImageClamp();
		clamp.clampImageCount(request(conversation(4)), UMANS_MODEL);

		// The user attaches 8 images in one message: they fit the budget of 10 by themselves, and dropping the
		// 12 older images is enough for the request to fit.
		const attached = Array.from({ length: 8 }, (_, index) => `attached-${index}`);
		const next = request([...conversation(4), userTurn("compare these", 60, attached)]);
		const sent = imageData(clamp.clampImageCount(next, UMANS_MODEL));

		expect(sent).toEqual(expect.arrayContaining(attached));
	});
});
