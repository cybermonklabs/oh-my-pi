/**
 * The advisor maintains its context (compacts it, or starts over from the incoming update) once its local floor
 * (system prompt, tool definitions, stored messages and the incoming update) passes the compaction threshold. On a
 * model that keeps its tool declaration across a conversation, a tool taken off the advisor's roster stays declared,
 * and every later request sends its definition again: the floor must count it, or the advisor maintains late.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, mockGatewayFetch, textOf, wireToolTokens } from "./helpers/anthropic-gateway";

/** An advisor `grep` whose definition is large next to an advisor update: a few thousand tokens. */
const grepTool: AgentTool = {
	name: "grep",
	label: "Grep",
	description: "Search the repository for a pattern and report matching lines with their paths. ".repeat(300),
	parameters: type({ pattern: "string" }),
	execute: async () => ({ content: [{ type: "text" as const, text: "no matches" }] }),
};

/**
 * Two primary prompts, each reviewed by an advisor on the gateway's claude-opus-5-5, with `grep` taken off the
 * advisor's roster between them if `withdraw`. Before the second review, the compaction threshold is set to the floor
 * counted from the advisor's active roster plus half of `grep`'s definition as the first review declared it. Returns
 * whether the second review's request still carries the first review's update: false once the advisor maintained its
 * context before it.
 */
async function secondReviewCarriesFirstUpdate(withdraw: boolean): Promise<boolean> {
	using tempDir = TempDir.createSync("@pi-advisor-floor-withdrawn-tool-");
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
	const { requests, restore } = mockGatewayFetch(turn => answer(turn));
	const authStorage = createInMemoryAuthStorage();
	let session: AgentSession | undefined;
	try {
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const advisorModel = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!advisorModel) throw new Error("Expected the gateway's claude-opus-5-5");
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary one"] }, { content: ["primary two"] }],
		});
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"contextPromotion.enabled": false,
			modelRoles: { advisor: "anthropic/claude-opus-5-5" },
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [grepTool],
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected an active advisor");
		advisor.setModel(advisorModel);

		await session.prompt("first update");
		const first = requests[0];
		const declared = first?.tools?.find(tool => tool.name === "grep");
		// Precondition: the first review sent the first update and declared `grep`.
		expect(textOf(first?.messages)).toContain("first update");
		if (!declared?.description) throw new Error("Expected the advisor's first request to declare grep");

		if (withdraw) advisor.setTools(advisor.state.tools.filter(tool => tool.name !== "grep"));
		// Precondition: the next review declares `grep` either way, off the roster or on it.
		expect(advisor.declaredTools(advisorModel).map(tool => tool.name)).toContain("grep");
		expect(advisor.state.tools.some(tool => tool.name === "grep")).toBe(!withdraw);
		const tokenizer = advisor.tokenizer;
		const declaredTokens = wireToolTokens(tokenizer, declared);
		const activeFloor =
			tokenizer.countTokens(advisor.state.systemPrompt) +
			estimateToolSchemaTokens(advisor.state.tools, tokenizer, {
				sourceRevision: settings.revision,
				pruneDescriptions: advisor.prunesToolDescriptions(advisorModel),
			}) +
			tokenizer.countMessages(advisor.state.messages, { excludeEncryptedReasoning: true });
		cfgCompactionThresholdTokens.set(settings, activeFloor + Math.floor(declaredTokens / 2));

		await session.prompt("second update");
		const second = requests[1];
		// Precondition: the second review ran and sent the second update.
		expect(requests).toHaveLength(2);
		expect(textOf(second?.messages)).toContain("second update");
		return textOf(second?.messages).includes("first update");
	} finally {
		await session?.dispose();
		authStorage.close();
		restore();
	}
}

describe("advisor compaction floor on an advisor whose requests still declare a withdrawn tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("counts the withdrawn tool's definition and maintains the advisor's context", async () => {
		expect(await secondReviewCarriesFirstUpdate(true)).toBe(false);
	}, 60_000);

	it("counts each active tool once and keeps the context when no tool was withdrawn", async () => {
		expect(await secondReviewCarriesFirstUpdate(false)).toBe(true);
	}, 60_000);
});
