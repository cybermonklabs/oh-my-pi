/**
 * A returned background `task` call has no later tool result, so
 * `AgentSession.activeToolExecutionUpdates()` keeps its settled frame for the
 * session's life and focus rebuilds settle the card from it. That kept frame
 * holds only what the settled card draws: a finished row drops its recent
 * tools, recent output, current tool, stage and the other fields a card draws
 * only while the row runs, and the rendered prompt its assignment stands in for.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent, type AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolExecutionUpdateEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import {
	type AgentProgress,
	renderResult,
	type TaskParams,
	type TaskToolDetails,
	taskToolRenderer,
} from "@oh-my-pi/pi-tui/tools/task";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const CALL_ID = "task-bg";
const NOW = 1_700_000_000_000;
const NAMES = ["Alpha", "Beta", "Gamma"];
/** Every live-only value below carries this marker; none of it may stay in a kept settled row. */
const LIVE_ONLY = "live-only";
const LIVE_ONLY_KEYS = [
	"currentTool",
	"currentToolArgs",
	"currentToolArgsKey",
	"currentToolIntent",
	"currentToolStartMs",
	"stage",
	"retryState",
	"completionPercent",
	"lastIntent",
	"watch",
] as const;

const args: TaskParams = {
	tasks: NAMES.map(name => ({
		name,
		agent: "task",
		task: `Audit the ${name} module for unbounded caches and report each one with its owner.`,
	})),
};

const taskCall = {
	role: "assistant",
	content: [{ type: "toolCall", id: CALL_ID, name: "task", arguments: args }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	stopReason: "toolUse",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: NOW,
} as unknown as AgentMessage;

// The `async.state === "running"` result the detached call returned and persisted.
const spawnedDetails: TaskToolDetails = {
	projectAgentsDir: null,
	results: [],
	totalDurationMs: 10,
	progress: [],
	async: { state: "running", jobId: "Alpha", type: "task" },
};

const spawnedResult = {
	role: "toolResult",
	toolCallId: CALL_ID,
	toolName: "task",
	content: [{ type: "text", text: "Spawned 3 agents..." }],
	details: spawnedDetails,
	isError: false,
	timestamp: NOW,
} satisfies ToolResultMessage;

/** Item `index`'s row as the job reports it once its subagent finished: stats plus the live fields its last update left. */
function finishedRow(index: number, status: AgentProgress["status"]): AgentProgress {
	const item = args.tasks![index]!;
	const id = item.name!;
	const assignment = item.task!;
	return {
		index,
		id,
		agent: "task",
		agentSource: "bundled",
		status,
		task: `Complete assignment thoroughly:\n\n${assignment}`,
		assignment,
		currentTool: "bash",
		currentToolArgs: `${LIVE_ONLY} current args`,
		currentToolArgsKey: "command",
		currentToolIntent: `${LIVE_ONLY} current intent`,
		currentToolStartMs: NOW - 9_000,
		recentTools: [1, 2, 3, 4, 5].map(step => ({
			tool: "bash",
			args: `${LIVE_ONLY} tool args ${step}`,
			argsKey: "command",
			intent: `${LIVE_ONLY} tool intent ${step}`,
			endMs: NOW - step * 1_000,
		})),
		recentOutput: [1, 2, 3, 4, 5, 6, 7, 8].map(line => `${LIVE_ONLY} output line ${line}`),
		toolCount: 12,
		requests: 9,
		tokens: 18_400,
		contextTokens: 9_200,
		contextWindow: 200_000,
		cost: 0.12,
		durationMs: 40_000 + index * 1_000,
		resolvedModel: "anthropic/claude-sonnet-4-5",
		resolvedModelIdentity: "anthropic/claude-sonnet-4-5",
		resolvedThinkingLevel: ThinkingLevel.Medium,
		stage: `${LIVE_ONLY} stage`,
		watch: `${LIVE_ONLY} watch`,
		completionPercent: 90,
		lastIntent: `${LIVE_ONLY} last intent`,
		retryState: {
			attempt: 1,
			maxAttempts: 3,
			delayMs: 5_000,
			errorMessage: `${LIVE_ONLY} retry`,
			startedAtMs: NOW - 2_000,
		},
	};
}

/** The job's update once every background spawn settled (`buildAsyncDetails`). */
function jobUpdate(progress: AgentProgress[], state: "completed" | "failed"): ToolExecutionUpdateEvent {
	return {
		type: "tool_execution_update",
		toolCallId: CALL_ID,
		toolName: "task",
		args,
		partialResult: {
			content: [{ type: "text", text: `Background task ${progress[0]!.id} ${state}.` }],
			details: {
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 45_000,
				progress,
				async: { state, jobId: "Alpha", type: "task" },
			} satisfies TaskToolDetails,
		},
	};
}

/** Rebuild the transcript the way a focus switch does and return the drawn task card. */
async function rebuildCard(frame: ToolExecutionUpdateEvent, expanded: boolean): Promise<readonly string[]> {
	const ctx = createInteractiveModeContext({
		session: {
			buildTranscriptSessionContext: () => ({ messages: [taskCall, spawnedResult] }) as SessionContext,
			activeToolExecutionUpdates: () => [frame],
		},
		toolOutputExpanded: expanded,
		initialChatRendered: false,
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	ctx.renderInitialMessages = helpers.renderInitialMessages.bind(helpers);
	await ctx.renderInitialMessages();
	return ctx.chatContainer.render(120);
}

describe("AgentSession keeps a settled background task frame as its settled card", () => {
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	async function makeSession(): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
	}

	it("drops the finished rows' live progress and rebuilds the same settled card", async () => {
		// If this regresses, a session keeps every finished subagent's recent tool calls and
		// output for its whole life, or a focus switch redraws the settled task card differently.
		const live = await makeSession();
		session = live;
		const alpha = finishedRow(0, "completed");
		alpha.extractedToolData = { yield: [{ type: "summary", data: "Alpha keeps two caches" }] };
		const beta = finishedRow(1, "failed");
		beta.description = "Beta cache audit";
		beta.retryFailure = { attempt: 3, errorMessage: "rate limited" };
		const full = jobUpdate([alpha, beta, finishedRow(2, "aborted")], "failed");

		live.agent.emitExternalEvent({
			type: "tool_execution_end",
			toolCallId: CALL_ID,
			toolName: "task",
			result: { content: spawnedResult.content, details: spawnedDetails },
		});
		live.agent.emitExternalEvent(full);
		const [kept] = live.activeToolExecutionUpdates();

		const keptRows = (kept.partialResult.details as TaskToolDetails).progress ?? [];
		expect(keptRows.map(row => row.id)).toEqual(NAMES);
		for (const row of keptRows) {
			for (const key of LIVE_ONLY_KEYS) expect(row).not.toHaveProperty(key);
			expect(row).toMatchObject({ task: "", recentTools: [], recentOutput: [] });
		}
		expect(JSON.stringify(kept)).not.toContain(LIVE_ONLY);

		for (const expanded of [false, true]) {
			const fromFull = await rebuildCard(full, expanded);
			expect(await rebuildCard(kept, expanded)).toEqual(fromFull);
			const drawn = Bun.stripANSI(fromFull.join("\n"));
			for (const name of NAMES) expect(drawn).toContain(name);
			expect(drawn).toContain("Alpha keeps two caches");

			const options = { expanded, isPartial: false, renderContext: { nowMs: NOW } };
			expect(taskToolRenderer.describeResult(kept.partialResult, options, args)).toEqual(
				taskToolRenderer.describeResult(full.partialResult, options, args),
			);
		}
		expect(Bun.stripANSI((await rebuildCard(kept, true)).join("\n"))).toContain("unbounded caches");
	});

	it("keeps a still-running row whole while a mixed call's background subset has settled", async () => {
		// If this regresses, a focus switch during a mixed task call's blocking spawn loses that
		// spawn's current tool and recent output from the live card.
		session = await makeSession();
		const blocking = finishedRow(1, "running");
		blocking.currentToolIntent = "Reading the Beta cache table";
		blocking.recentOutput = ["Beta table has 3 owners"];
		session.agent.emitExternalEvent(jobUpdate([finishedRow(0, "completed"), blocking], "completed"));
		const [kept] = session.activeToolExecutionUpdates();

		const card = renderResult(kept.partialResult, { expanded: true, isPartial: true }, theme, args);
		const drawn = Bun.stripANSI(card.render(120).join("\n"));
		expect(drawn).toContain("Reading the Beta cache table");
		expect(drawn).toContain("Beta table has 3 owners");
	});
});
