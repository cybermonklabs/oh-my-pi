import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	GATEWAY,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const MEMORY = "The deploy host is alpha-7.";
const MEMORIES = `<memories>\nRelevant memories:\n\n- ${MEMORY}\n</memories>`;

/** The gateway with two Claude models, so a session can switch between them. */
function twoModelsYml(): string {
	const card = "reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000";
	const cost = "cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}";
	return `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, ${card}, ${cost}}
      - {id: claude-opus-5, name: Claude Opus 5, ${card}, ${cost}}
`;
}

/**
 * A memory backend that behaves as Hindsight does: each turn retries a recall until one succeeds, and once one
 * is adopted the memory instructions of every later prompt build carry it. The first recall fails.
 */
function lateRecallBackend(): MemoryBackend {
	let attempts = 0;
	let adopted: string | undefined;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return adopted ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (adopted !== undefined || ++attempts <= 1) return undefined;
			return {
				context: MEMORIES,
				commit: () => {
					adopted = MEMORIES;
					return true;
				},
			};
		},
	};
}

/** A resumed process's backend: its recall is the one the transcript recorded. */
function reusedRecallBackend(): MemoryBackend {
	let adopted: string | undefined;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return adopted ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (adopted !== undefined) return undefined;
			return {
				context: MEMORIES,
				reused: true,
				commit: () => {
					adopted = MEMORIES;
					return true;
				},
			};
		},
	};
}

/** How many times `request` carries the recalled memory, system prompt and messages together. */
function memoryCopies(request: MessagesRequest): number {
	const wire = withoutCacheControl({ system: request.system, messages: request.messages });
	return wire.split(MEMORY).length - 1;
}

describe("a memory recall that first succeeds after the prompt was bound", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	interface Process {
		backend: MemoryBackend;
		/** The session file to resume; a new persisted session without one. */
		sessionFile?: string;
	}

	/** One process on a persisted session: runs `body`, then exits. Returns its requests and session file. */
	async function runProcess(
		tempDir: TempDir,
		{ backend, sessionFile }: Process,
		body: (session: AgentSession, registry: ModelRegistry, requests: MessagesRequest[]) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		await Bun.write(tempDir.join("models.yml"), twoModelsYml());
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const backendSpy = vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(backend);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"providers.cacheRetention": "long",
				"compaction.methodOrder": ["soft"],
				"compaction.keepRecentTokens": 1,
			}),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await body(session, modelRegistry, requests);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			backendSpy.mockRestore();
			restore();
		}
	}

	async function withSession(
		tempDir: TempDir,
		body: (session: AgentSession, registry: ModelRegistry, requests: MessagesRequest[]) => Promise<void>,
	): Promise<MessagesRequest[]> {
		return (await runProcess(tempDir, { backend: lateRecallBackend() }, body)).requests;
	}

	it("keeps the cached prompt when a session resumes after a compaction summarized its late recall", async () => {
		using tempDir = TempDir.createSync("@pi-late-recall-lifetime-");
		let afterCompaction = -1;
		const live = await runProcess(tempDir, { backend: lateRecallBackend() }, async (session, _registry, sent) => {
			await session.prompt("first");
			await session.prompt("second");
			await session.prompt("third");
			await session.compact();
			afterCompaction = sent.length;
			await session.prompt("fourth");
		});
		// The resumed process reads the recall the transcript recorded, as Hindsight and mnemopi do.
		const resumed = await runProcess(
			tempDir,
			{ backend: reusedRecallBackend(), sessionFile: live.sessionFile },
			async session => {
				await session.prompt("fifth");
			},
		);
		const lastBefore = live.requests.at(-1);
		const firstAfter = resumed.requests[0];
		if (!lastBefore || !firstAfter || afterCompaction !== live.requests.length - 1) {
			throw new Error("Expected one request after the compaction and one after the resume");
		}
		// The resume keeps the system prompt the last request sent, so its cache lookup reads that whole prompt.
		expect(withoutCacheControl(firstAfter.system)).toBe(withoutCacheControl(lastBefore.system));
	}, 30_000);

	it("still reaches the model after a compaction summarizes the turn that carried it", async () => {
		using tempDir = TempDir.createSync("@pi-late-recall-lifetime-");
		let afterCompaction = -1;
		const requests = await withSession(tempDir, async (session, _registry, sent) => {
			await session.prompt("first");
			await session.prompt("second");
			await session.prompt("third");
			await session.compact();
			afterCompaction = sent.length;
			await session.prompt("fourth");
		});
		const second = requests[1];
		const fourth = requests[afterCompaction];
		if (!second || !fourth) throw new Error("Expected the recall turn and a request after the compaction");
		// The recall the session adopted on the second turn went out with it.
		expect(memoryCopies(second)).toBe(1);
		// The session keeps the memory it adopted for the rest of the conversation, as a recall in the system
		// prompt did: a compaction must not silently drop it from every later request.
		expect(memoryCopies(fourth)).toBe(1);
	}, 30_000);

	it("goes out once, not twice, after a model switch rebuilds the system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-late-recall-lifetime-");
		const requests = await withSession(tempDir, async (session, registry) => {
			await session.prompt("first");
			await session.prompt("second");
			const other = registry.find("anthropic", "claude-opus-5");
			if (!other) throw new Error("Expected the gateway's claude-opus-5");
			await session.setModel(other, "default", { persist: false });
			await session.prompt("third");
		});
		const [, second, third] = requests;
		if (!second || !third) throw new Error("Expected three requests");
		expect(memoryCopies(second)).toBe(1);
		// The rebuilt system prompt carries the adopted recall in the memory instructions; the hidden recall message
		// still in the history carries it again.
		expect(memoryCopies(third)).toBe(1);
	}, 30_000);
});
