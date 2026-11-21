import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const MEMORIES = "<memories>\nRelevant memories:\n\n- The deploy host is alpha-7.\n</memories>";

/**
 * A memory backend that behaves as Hindsight does: each turn retries a recall until one succeeds, and once one
 * is adopted the memory instructions of every later prompt build carry it. The first `failures` recalls fail;
 * with `reused`, the recall is the one the resumed transcript recorded.
 */
function recallingBackend(failures: number, reused = false): MemoryBackend {
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
			if (adopted !== undefined || ++attempts <= failures) return undefined;
			return {
				context: MEMORIES,
				reused,
				commit: () => {
					adopted = MEMORIES;
					return true;
				},
			};
		},
	};
}

interface ProcessRun {
	requests: MessagesRequest[];
	sessionFile: string;
}

describe("memory recall in a conversation whose prompt is bound", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) with `backend`: sends each prompt, then exits. */
	async function runProcess(
		tempDir: TempDir,
		backend: MemoryBackend,
		prompts: string[],
		sessionFile?: string,
	): Promise<ProcessRun> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const backendSpy = vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(backend);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
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
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			for (const text of prompts) await session.prompt(text);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			backendSpy.mockRestore();
			restoreFetch();
		}
	}

	it("sends a recall that first succeeds after a failed one after the newest content, keeping the system blocks", async () => {
		using tempDir = TempDir.createSync("@pi-late-memory-recall-");
		const { requests } = await runProcess(tempDir, recallingBackend(1), ["first", "second", "third"]);
		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");

		expect(withoutCacheControl(first.system)).not.toContain("alpha-7");
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		// The recall rides the second turn's new messages, then stays in the replayed history.
		expect(withoutCacheControl(second.messages.slice(first.messages.length))).toContain("alpha-7");
		expect(continuesCachedPrompt(second, third)).toBe(true);
	}, 30_000);

	it("keeps a recall the resumed transcript carries after its content out of the system prompt", async () => {
		using tempDir = TempDir.createSync("@pi-late-memory-recall-");
		const live = await runProcess(tempDir, recallingBackend(1), ["first", "second"]);
		const resumed = await runProcess(tempDir, recallingBackend(0, true), ["third"], live.sessionFile);

		const lastBefore = live.requests.at(-1);
		const firstAfter = resumed.requests[0];
		if (!lastBefore || !firstAfter) throw new Error("Expected requests before and after the resume");
		expect(withoutCacheControl(firstAfter.system)).not.toContain("alpha-7");
		expect(continuesCachedPrompt(lastBefore, firstAfter)).toBe(true);
	}, 30_000);

	it("keeps a first-turn recall in the system prompt for the whole conversation", async () => {
		using tempDir = TempDir.createSync("@pi-late-memory-recall-");
		const { requests } = await runProcess(tempDir, recallingBackend(0), ["first", "second"]);
		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected two requests");

		expect(withoutCacheControl(first.system)).toContain("alpha-7");
		expect(withoutCacheControl(first.messages)).not.toContain("alpha-7");
		expect(continuesCachedPrompt(first, second)).toBe(true);
	}, 30_000);
});
