/**
 * The approved-plan reference goes out once with the first request after the approval and stays in the history from
 * there. A move of the branch to a point before it (`/tree`, a rewind to a checkpoint) leaves a branch that no longer
 * carries it, so the next request must send it again; a move to a point after it must not send a second copy.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
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

const PLAN_MARKER = "APPROVED-PLAN-MIGRATE-THE-WORKERS";
const PLAN_URL = "local://approved-plan.md";

/** How many times `request`'s messages carry the plan. */
function planCopies(request: MessagesRequest): number {
	return withoutCacheControl(request.messages).split(PLAN_MARKER).length - 1;
}

/** Where `sessionManager`'s session keeps the approved plan. */
function planFile(sessionManager: SessionManager): string {
	return resolveLocalUrlToPath(PLAN_URL, {
		getArtifactsDir: () => sessionManager.getArtifactsDir(),
		getSessionId: () => sessionManager.getSessionId(),
	});
}

describe("approved plan reference after a /tree move", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the reference again on a branch that lacks it, and not on one that carries it", async () => {
		using tempDir = TempDir.createSync("@pi-plan-reference-tree-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			const file = planFile(sessionManager);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `# Approved Plan\n\n${PLAN_MARKER}\n`);
			// The approval as plan review records it.
			session.setPlanReferencePath(PLAN_URL);
			const approvalId = sessionManager.appendModeChange("none", { approvedPlanFilePath: PLAN_URL });

			await session.prompt("Start on the plan.");
			await session.prompt("Continue.");
			const [first, second] = requests;
			if (!first || !second) throw new Error("Expected the first two prompts' requests");
			expect(planCopies(first)).toBe(1);
			expect(planCopies(second)).toBe(1);
			const firstReply = sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!firstReply) throw new Error("Expected the first prompt's reply");

			// Back to the approval: the branch holds the approval but not the reference that followed it.
			await session.navigateTree(approvalId);
			await session.prompt("Start over on the plan.");
			const third = requests[2];
			if (!third) throw new Error("Expected the third prompt's request");
			expect(planCopies(third)).toBe(1);

			// Forward to the first reply: the branch carries the reference the first prompt sent.
			await session.navigateTree(firstReply.id);
			await session.prompt("Pick up from the first reply.");
			const fourth = requests[3];
			if (!fourth) throw new Error("Expected the fourth prompt's request");
			expect(planCopies(fourth)).toBe(1);
			expect(continuesCachedPrompt(first, fourth)).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}, 30_000);
});

const checkpointSchema = type({ goal: type("string") });
const rewindSchema = type({ report: type("string") });
const noArguments = type({});

describe("approved plan reference after a rewind to a checkpoint", () => {
	it("sends the reference again after a rewind to before the request that delivered it", async () => {
		using tempDir = TempDir.createSync("@pi-plan-reference-rewind-");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const file = planFile(sessionManager);
		const tools: AgentTool[] = [
			{
				name: "checkpoint",
				label: "Checkpoint",
				description: "Create a checkpoint",
				parameters: checkpointSchema,
				async execute(_toolCallId, params: { goal: string }) {
					return {
						content: [{ type: "text" as const, text: `checkpoint:${params.goal}` }],
						details: { startedAt: "2026-01-01T00:00:00.000Z" },
					};
				},
			} as AgentTool,
			{
				name: "rewind",
				label: "Rewind",
				description: "Rewind to the checkpoint",
				parameters: rewindSchema,
				async execute(_toolCallId, params: { report: string }) {
					return {
						content: [{ type: "text" as const, text: "rewind requested" }],
						details: { report: params.report, rewound: true },
					};
				},
			} as AgentTool,
			{
				// Writes the approved plan once the checkpoint is set, so its reference first goes out after it.
				name: "write_plan",
				label: "Write plan",
				description: "Write the approved plan",
				parameters: noArguments,
				async execute() {
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, `# Approved Plan\n\n${PLAN_MARKER}\n`);
					return { content: [{ type: "text" as const, text: "plan written" }], details: {} };
				},
			} as AgentTool,
		];
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", id: "call_checkpoint", name: "checkpoint", arguments: { goal: "plan" } }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "call_write_plan", name: "write_plan", arguments: {} }],
					stopReason: "toolUse",
				},
				{
					content: [{ type: "toolCall", id: "call_rewind", name: "rewind", arguments: { report: "done" } }],
					stopReason: "toolUse",
				},
				{ content: ["DONE"], stopReason: "stop" },
			],
		});
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		try {
			// Approved before the checkpoint; the plan file is written after it.
			session.setPlanReferencePath(PLAN_URL);
			sessionManager.appendModeChange("none", { approvedPlanFilePath: PLAN_URL });
			await session.prompt("Set a checkpoint, write the plan, then rewind.");

			const copies = mock.calls.map(call => JSON.stringify(call.context.messages).split(PLAN_MARKER).length - 1);
			// The request after the plan was written carries it; the rewind drops the turn that delivered it.
			expect(copies).toEqual([0, 0, 1, 1]);
			const [, beforePlan, withPlan] = mock.calls;
			if (!beforePlan || !withPlan) throw new Error("Expected the requests around the plan's delivery");
			expect(JSON.stringify(withPlan.context.messages.slice(0, beforePlan.context.messages.length))).toBe(
				JSON.stringify(beforePlan.context.messages),
			);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 30_000);
});
