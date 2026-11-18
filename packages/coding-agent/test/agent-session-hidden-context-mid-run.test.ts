/**
 * A compaction between the tool calls of a run summarizes the hidden messages the conversation sent once after a
 * turn's newest content. These cases check that the rest of the run still carries them, as a system prompt block
 * would, instead of waiting for the next prompt, that the request after it adds no second copy, and that a recall a
 * reset withdrew is not sent again.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as memoryBackendResolve from "@oh-my-pi/pi-coding-agent/memory-backend/resolve";
import type { MemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const MEMORY = "The deploy host is alpha-7.";
const PLAN_MARKER = "APPROVED-PLAN-MIGRATE-THE-WORKERS";
const RECALL_CHANGES = "MEMORY-CHANGED: the deploy host moved to beta-3.";

/**
 * A memory backend whose first recall fails and whose second succeeds, as Hindsight's does after an outage. Its
 * `clear` drops its state, as Hindsight's does, so it recalls nothing after it.
 */
function lateRecallBackend(): MemoryBackend {
	let attempts = 0;
	let adopted: string | undefined;
	let cleared = false;
	return {
		id: "hindsight",
		async start() {},
		async buildDeveloperInstructions() {
			return adopted ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {
			adopted = undefined;
			cleared = true;
		},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (cleared || adopted !== undefined || ++attempts <= 1) return undefined;
			const recall = `<memories>\nRelevant memories:\n\n- ${MEMORY}\n</memories>`;
			return {
				context: recall,
				commit: () => {
					adopted = recall;
					return true;
				},
			};
		},
	};
}

/**
 * A memory backend that reuses the transcript's recall at the first turn and reports what changed in its memories
 * since, as Mnemopi does on resume.
 */
function changedRecallBackend(): MemoryBackend {
	let adopted: string | undefined;
	return {
		id: "mnemopi",
		async start() {},
		async buildDeveloperInstructions() {
			return adopted ? `Memory instructions.\n\n${adopted}` : "Memory instructions.";
		},
		async clear() {},
		async enqueue() {},
		async beforeAgentStartPrompt() {
			if (adopted !== undefined) return undefined;
			const recall = `<memories>\nRelevant memories:\n\n- ${MEMORY}\n</memories>`;
			return {
				context: recall,
				reused: true,
				notice: { content: RECALL_CHANGES, details: { scope: "test", memories: [] } },
				commit: () => {
					adopted = recall;
					return true;
				},
			};
		},
	};
}

/** How many times `request` carries `text`, system prompt and messages together. */
function copies(request: MessagesRequest, text: string): number {
	return withoutCacheControl({ system: request.system, messages: request.messages }).split(text).length - 1;
}

/** Steps a run takes around its prompts, each given the session and its settings. */
interface RunSteps {
	/** Tools the session starts with; `read` alone unless given. */
	toolNames?: string[];
	beforeFirst?: (session: AgentSession, settings: Settings) => void | Promise<void>;
	afterFirst?: (session: AgentSession, settings: Settings) => void | Promise<void>;
	afterSecond?: (session: AgentSession, settings: Settings) => void | Promise<void>;
}

describe("hidden context a compaction between tool calls summarized", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * Runs four prompts: a long first one, a second one, a third whose reply calls `read` on a 90,000-token context,
	 * which compacts the first two turns at the tool boundary, and a fourth after that run. Returns every request, the
	 * one that answers the tool call and the fourth prompt's.
	 */
	async function compactBetweenToolCalls(
		steps: RunSteps,
	): Promise<{ requests: MessagesRequest[]; afterTool: MessagesRequest; next: MessagesRequest }> {
		using tempDir = TempDir.createSync("@pi-hidden-context-mid-run-");
		// A 100,000-token window: the tool call's 90,000-token context leaves less than the window's reserve, so the
		// compaction at the tool boundary cannot wait.
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(100_000));
		await Bun.write(tempDir.join("queue.txt"), "drained\n");
		const { requests, restore } = mockGatewayFetch(turn =>
			turn === 3
				? toolCallAnswer(turn, "read", { path: "queue.txt" }, { inputTokens: 90_000 })
				: answer(turn, { cacheWriteTokens: 100 }),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const settings = Settings.isolated({
			"providers.cacheRetention": "long",
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"compaction.midTurnEnabled": true,
			// A blocking compaction: no background speculation takes the tool boundary's pass over.
			"compaction.asyncEnabled": false,
			"browser.enabled": false,
		});
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: steps.toolNames ?? ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await steps.beforeFirst?.(session, settings);
			// A long first turn, so the compaction has history to summarize.
			const log = Array.from({ length: 6_000 }, (_, line) => `worker ${line}: drained the queue\n`).join("");
			await session.prompt(`Where is the deploy host? Here is the deploy log:\n${log}`);
			await steps.afterFirst?.(session, settings);
			await session.prompt("And where is the deploy host now?");
			await steps.afterSecond?.(session, settings);
			await session.prompt("Read queue.txt.");

			const compacted = session.sessionManager.getBranch().some(entry => entry.type === "compaction");
			if (!compacted) throw new Error("Expected the tool boundary to compact the history");
			const afterTool = requests.at(-1);
			if (!afterTool || !withoutCacheControl(afterTool.messages).includes('"type":"tool_result"')) {
				throw new Error("Expected the run's last request to answer the tool call");
			}
			if (withoutCacheControl(afterTool.messages).includes("And where is the deploy host now?")) {
				throw new Error("Expected the compaction to summarize the first two turns before the request");
			}
			await session.prompt("Thanks.");
			const next = requests.at(-1);
			if (!next || next === afterTool) throw new Error("Expected the fourth prompt's request");
			return { requests, afterTool, next };
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	it("sends a late memory recall again in the rest of the run", async () => {
		vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(lateRecallBackend());
		const { requests, afterTool } = await compactBetweenToolCalls({});
		const second = requests[1];
		if (!second) throw new Error("Expected the recall turn's request");
		expect(copies(second, MEMORY)).toBe(1);
		expect(copies(afterTool, MEMORY)).toBe(1);
	}, 30_000);

	it("sends the approved plan reference again in the rest of the run", async () => {
		const { requests, afterTool } = await compactBetweenToolCalls({
			beforeFirst: session => {
				const url = "local://approved-plan.md";
				const file = resolveLocalUrlToPath(url, {
					getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
					getSessionId: () => session.sessionManager.getSessionId(),
				});
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `# Approved Plan\n\n${PLAN_MARKER}\n`);
				session.setPlanReferencePath(url);
			},
		});
		const first = requests[0];
		if (!first) throw new Error("Expected the first turn's request");
		expect(copies(first, PLAN_MARKER)).toBe(1);
		expect(copies(afterTool, PLAN_MARKER)).toBe(1);
	}, 30_000);

	it("tells the rest of the run again what changed in the eval preludes", async () => {
		const { requests, afterTool, next } = await compactBetweenToolCalls({
			toolNames: ["read", "eval"],
			// Turned on once the first request went out: the second prompt's notice tells the model.
			afterFirst: async (session, settings) => {
				cfgComputerEnabled.override(settings, true);
				await Promise.resolve();
				await session.runToolRegistryMutation(async () => undefined);
			},
		});
		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected the first two prompts' requests");
		expect(copies(second, 'id=\\"prelude-extension\\"')).toBe(1);
		expect(continuesCachedPrompt(first, second)).toBe(true);
		expect(copies(afterTool, 'id=\\"prelude-extension\\"')).toBe(1);
		// The request after carries the notice it was sent once, after the content it follows.
		expect(copies(next, 'id=\\"prelude-extension\\"')).toBe(1);
		expect(continuesCachedPrompt(afterTool, next)).toBe(true);
	}, 30_000);

	it("tells the rest of the run again what changed in a reused recall's memories", async () => {
		vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(changedRecallBackend());
		const { requests, afterTool, next } = await compactBetweenToolCalls({});
		const first = requests[0];
		if (!first) throw new Error("Expected the first prompt's request");
		expect(copies(first, RECALL_CHANGES)).toBe(1);
		expect(copies(afterTool, RECALL_CHANGES)).toBe(1);
		expect(copies(next, RECALL_CHANGES)).toBe(1);
		expect(continuesCachedPrompt(afterTool, next)).toBe(true);
	}, 30_000);

	it("keeps the vibe mode instructions in the rest of the run", async () => {
		const { afterTool, next } = await compactBetweenToolCalls({
			beforeFirst: session => session.setVibeModeState({ enabled: true }),
		});
		expect(copies(afterTool, "<vibe-mode>")).toBe(1);
		expect(continuesCachedPrompt(afterTool, next)).toBe(true);
	}, 30_000);

	it("does not send a recall `/memory clear` withdrew again", async () => {
		vi.spyOn(memoryBackendResolve, "resolveMemoryBackend").mockResolvedValue(lateRecallBackend());
		const { requests, afterTool, next } = await compactBetweenToolCalls({
			afterSecond: async (session, settings) => {
				await executeAcpBuiltinSlashCommand("/memory clear", {
					session,
					sessionManager: session.sessionManager,
					settings,
					cwd: session.sessionManager.getCwd(),
					output: () => {},
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				});
			},
		});
		const [, second, third] = requests;
		if (!second || !third) throw new Error("Expected the second and third prompts' requests");
		expect(copies(second, MEMORY)).toBe(1);
		// The history still holds the message that delivered it; nothing is added after the clear.
		expect(copies(third, MEMORY)).toBe(1);
		expect(continuesCachedPrompt(second, third)).toBe(true);
		expect(copies(afterTool, MEMORY)).toBe(0);
		expect(copies(next, MEMORY)).toBe(0);
	}, 30_000);
});
