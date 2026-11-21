/**
 * The image count clamp keeps dropping, in later requests of a conversation, the images its last forced drop chose,
 * and writes each forced drop to the session's branch so a process that resumes the session drops the same images.
 * These cases resume a session whose last requests dropped images the record on the current branch does not explain.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, ImageContent, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ProviderImageClamp, sessionImageDropRecord } from "@oh-my-pi/pi-coding-agent/session/provider-image-budget";
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

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function screenshotCall(step: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `shot-${step}`, name: "screenshot", arguments: {} }],
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

/** Step `step`'s tool result: `count` screenshots named `shot-<step>-<index>`. */
function screenshots(step: string, timestamp: number, count = 3): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `shot-${step}`,
		toolName: "screenshot",
		content: [
			{ type: "text", text: `screenshots of step ${step}` },
			...Array.from({ length: count }, (_, index) => image(`shot-${step}-${index}`)),
		],
		isError: false,
		timestamp,
	};
}

/** Step `step`'s tool result as a prune pass leaves it: its content blanked to the notice. */
function pruned(result: ToolResultMessage): ToolResultMessage {
	return { ...result, content: [{ type: "text", text: PRUNED_NOTICE }], prunedAt: 1 };
}

/** The user's request and steps `0..steps-1`, each a screenshot call and its three-image result. */
function history(steps: number): Message[] {
	const messages: Message[] = [{ role: "user", content: "Walk through the setup wizard.", timestamp: 0 }];
	for (let step = 0; step < steps; step++) {
		messages.push(screenshotCall(String(step), step * 10 + 1), screenshots(String(step), step * 10 + 2));
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

describe("ProviderImageClamp on a resumed session", () => {
	it("drops the images the previous process still dropped once a prune brought the images under the budget", () => {
		const sessionManager = SessionManager.inMemory();
		const live = new ProviderImageClamp(undefined, sessionImageDropRecord(sessionManager));

		// Four screenshot steps, 12 images over the budget of 10: the forced drop keeps the 5 newest and records it.
		const messages = history(4);
		live.clampImageCount(request(messages), UMANS_MODEL);
		// An aged-result prune blanks steps 0 and 1. The request carries 6 images, inside the budget; the process
		// keeps dropping shot-2-0, which its earlier requests dropped, so the cached prefix stays the same.
		const prunedMessages = messages.map((message, index) =>
			message.role === "toolResult" && index <= 4 ? pruned(message) : message,
		);
		const lastBefore = imageData(live.clampImageCount(request(prunedMessages), UMANS_MODEL));
		expect(lastBefore).toEqual(["shot-2-1", "shot-2-2", "shot-3-0", "shot-3-1", "shot-3-2"]);

		// omp restarts and resumes the session: the same history, the same recorded drop on the branch. Its first
		// request should send what the previous process's last request sent, or it rewrites the cached prompt from
		// step 2's result on.
		const resumed = new ProviderImageClamp(undefined, sessionImageDropRecord(sessionManager));
		const firstAfter = imageData(resumed.clampImageCount(request(prunedMessages), UMANS_MODEL));
		expect(firstAfter).toEqual(lastBefore);
	});

	it("drops the images the previous process dropped on a branch that continued from before its forced drop", () => {
		const sessionManager = SessionManager.inMemory();
		const live = new ProviderImageClamp(undefined, sessionImageDropRecord(sessionManager));

		// Branch A: four screenshot steps, 12 images; the forced drop keeps the 5 newest and is recorded on A.
		const shared = history(3);
		let forkPoint = "";
		for (const message of shared) forkPoint = sessionManager.appendMessage(message);
		const branchA = [...shared, screenshotCall("3", 31), screenshots("3", 32)];
		for (const message of branchA.slice(shared.length)) sessionManager.appendMessage(message);
		live.clampImageCount(request(branchA), UMANS_MODEL);

		// The user goes back to step 2's result (/tree) and continues: step 3 again, this time with five screenshots.
		// The process still drops the 7 images it dropped on A wherever this branch sends them: 14 images, 7 sent.
		sessionManager.branch(forkPoint);
		const branchB = [...shared, screenshotCall("3b", 41), screenshots("3b", 42, 5)];
		for (const message of branchB.slice(shared.length)) sessionManager.appendMessage(message);
		const lastBefore = imageData(live.clampImageCount(request(branchB), UMANS_MODEL));
		expect(lastBefore).toEqual([
			"shot-2-1",
			"shot-2-2",
			"shot-3b-0",
			"shot-3b-1",
			"shot-3b-2",
			"shot-3b-3",
			"shot-3b-4",
		]);

		// omp restarts on branch B. Its first request should send what the previous process's last request on B sent;
		// a new forced drop of another set rewrites the cached prompt from step 2's result on.
		const resumed = new ProviderImageClamp(undefined, sessionImageDropRecord(sessionManager));
		const firstAfter = imageData(resumed.clampImageCount(request(branchB), UMANS_MODEL));
		expect(firstAfter).toEqual(lastBefore);
	});
});
