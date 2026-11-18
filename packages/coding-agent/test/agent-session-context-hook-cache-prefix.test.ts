import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type ExtensionFactory } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** Indexes of the messages that carry a cache breakpoint. */
function messageBreakpoints(request: MessagesRequest): number[] {
	return request.messages.flatMap((message, index) =>
		Array.isArray(message.content) &&
		message.content.some(
			block =>
				typeof block === "object" && block !== null && "cache_control" in block && block.cache_control != null,
		)
			? [index]
			: [],
	);
}

const FIXED_NOTE = "Read the shared notes before planning.";

/** Inserts the same note on every request, right after the compaction summaries that open the context. */
const fixedNoteAfterSummaries: ExtensionFactory = pi => {
	pi.on("context", event => {
		const at = event.messages.findIndex(message => message.role !== "compactionSummary");
		const index = at === -1 ? event.messages.length : at;
		const note: AgentMessage = { role: "user", content: [{ type: "text", text: FIXED_NOTE }], timestamp: 0 };
		return { messages: [...event.messages.slice(0, index), note, ...event.messages.slice(index)] };
	});
};

/** Inserts a note whose text changes on every request right after the first message of the context. */
const revisedNoteAfterFirst: ExtensionFactory = pi => {
	let revision = 0;
	pi.on("context", event => {
		const note: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: `Open answers, revision ${++revision}.` }],
			timestamp: 0,
		};
		return { messages: [...event.messages.slice(0, 1), note, ...event.messages.slice(1)] };
	});
};

describe("context hook messages and the Anthropic cache breakpoints", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	interface Run {
		requests: MessagesRequest[];
		/** Index in `requests` of each main request sent after `compactAfter` prompts, compaction requests left out. */
		afterCompaction: number[];
	}

	/** One session, with `extension` when given: sends each prompt, compacting before prompt `compactAfter`. */
	async function run(
		tempDir: TempDir,
		extension: ExtensionFactory | undefined,
		prompts: string[],
		compactAfter?: number,
	): Promise<Run> {
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(modelsPath, gatewayModelsYml());
		const { requests, restore: restoreFetch } = mockGatewayFetch(answer);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"providers.cacheRetention": "long",
				"compaction.methodOrder": ["soft"],
				"compaction.keepRecentTokens": 1,
			}),
			model,
			toolNames: ["read"],
			extensions: extension ? [extension] : [],
			skills: [],
			contextFiles: [],
		});
		const afterCompaction: number[] = [];
		try {
			// The `.local` host turns append-only context on, as the deployment's gateway does.
			expect(session.agent.appendOnlyContext).toBeDefined();
			for (const [index, text] of prompts.entries()) {
				if (index === compactAfter) await session.compact();
				const before = requests.length;
				await session.prompt(text);
				if (compactAfter !== undefined && index >= compactAfter) {
					for (let request = before; request < requests.length; request++) afterCompaction.push(request);
				}
			}
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
		return { requests, afterCompaction };
	}

	it("keeps both rolling breakpoints after a compaction under a fixed message a context hook inserts after the summary", async () => {
		const prompts = ["first", "second", "third", "fourth", "fifth"];
		using hookDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const hooked = await run(hookDir, fixedNoteAfterSummaries, prompts, 2);
		using plainDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const plain = await run(plainDir, undefined, prompts, 2);
		const main = hooked.afterCompaction.map(index => hooked.requests[index]!);
		const withoutHook = plain.afterCompaction.map(index => plain.requests[index]!);
		expect(main).toHaveLength(3);
		expect(withoutHook).toHaveLength(3);
		for (const request of main) {
			expect(request.messages[0]?.role).toBe("user");
			expect(withoutCacheControl(request.messages[1]?.content)).toContain(FIXED_NOTE);
		}
		// Breakpoint positions counted back from the newest message, which the inserted note does not shift.
		const fromNewest = (request: MessagesRequest) =>
			messageBreakpoints(request).map(index => request.messages.length - 1 - index);
		// From the second request on, the note repeats the bytes it was sent with: the two message breakpoints left
		// after the last tool and the system block sit where they sit without the hook, on the newest messages.
		for (let request = 1; request < main.length; request++) {
			expect(fromNewest(main[request]!)).toEqual(fromNewest(withoutHook[request]!));
			expect(fromNewest(main[request]!)).toEqual([1, 0]);
			expect(continuesCachedPrompt(main[request - 1]!, main[request]!)).toBe(true);
		}
	}, 30_000);

	it("leaves every request's breakpoints where they are without a context hook when the hook changes nothing", async () => {
		const prompts = ["first", "second", "third"];
		using hookDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const hooked = await run(
			hookDir,
			pi => {
				pi.on("context", () => undefined);
			},
			prompts,
		);
		using plainDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const plain = await run(plainDir, undefined, prompts);
		expect(hooked.requests).toHaveLength(3);
		// The replies the session recorded stay history: none is skipped as a breakpoint candidate.
		expect(hooked.requests.map(messageBreakpoints)).toEqual(plain.requests.map(messageBreakpoints));
	}, 30_000);

	it("keeps the breakpoint before a context hook message whose text changes on every request", async () => {
		using tempDir = TempDir.createSync("@pi-context-hook-cache-prefix-");
		const { requests } = await run(tempDir, revisedNoteAfterFirst, ["first", "second", "third"]);
		expect(requests).toHaveLength(3);
		for (const request of requests.slice(1)) {
			expect(withoutCacheControl(request.messages[1]?.content)).toContain("Open answers, revision");
			// The rebuilt note stays per-call: the message before it keeps a breakpoint, so the next request reads
			// the head behind it, and the newest message keeps the other.
			expect(messageBreakpoints(request)).toEqual([0, request.messages.length - 1]);
		}
	}, 30_000);
});
