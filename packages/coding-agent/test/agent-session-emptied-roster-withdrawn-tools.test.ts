/**
 * On a model that keeps its tool declaration across a conversation, a tool taken off the roster stays declared while
 * another tool is on the roster. A request with no tool on the roster declares none at all: the provider re-declares a
 * withdrawn tool only beside an active one. The non-message figure (the status line's anchor, the pre-prompt
 * compaction check) must then count no withdrawn tool: counted, it starts compaction on tools the
 * request does not send, and leaves the status line below the usage the provider reported for that request.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens, estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	type ReplyUsage,
	textOf,
	wireToolTokens,
} from "./helpers/anthropic-gateway";

const CONTEXT_WINDOW = 1_000_000;

/** The non-message figure counted from the active roster alone: system prompt and active tool definitions. */
function activeRosterFigure(session: AgentSession): number {
	const tokenizer = session.agent.tokenizer;
	return (
		tokenizer.countTokens(session.systemPrompt) +
		estimateToolSchemaTokens(session.agent.state.tools, tokenizer, {
			sourceRevision: session.settings.revision,
			pruneDescriptions: session.agent.prunesToolDescriptions(session.model),
		})
	);
}

/** Tokens of the definitions `request` declares for tools not on `session`'s roster. */
function offRosterWireTokens(session: AgentSession, request: MessagesRequest | undefined): number {
	const active = new Set(session.agent.state.tools.map(tool => tool.name));
	return (request?.tools ?? [])
		.filter(tool => !active.has(tool.name))
		.reduce((tokens, tool) => tokens + wireToolTokens(session.agent.tokenizer, tool), 0);
}

/** What {@link withdrawAfterTwoPrompts} hands its check. */
interface Withdrawn {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	/** Tokens of the definitions the last request before the withdrawal declared for the tools now off the roster. */
	withdrawnTokens: number;
}

/**
 * Runs two prompts on the gateway's claude-opus-5-5 with four tools, each reply reporting `usage`, then leaves `roster`
 * on the roster and hands the session to `check`.
 */
async function withdrawAfterTwoPrompts(
	roster: string[],
	usage: ReplyUsage,
	check: (withdrawn: Withdrawn) => Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("@pi-emptied-roster-withdrawn-tools-");
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(CONTEXT_WINDOW));
	const { requests, restore } = mockGatewayFetch(turn => answer(turn, usage));
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	// A compaction pays only on history larger than its summary, so the first prompt is long; with speculative
	// compaction off, the threshold alone decides whether a compaction starts before a prompt.
	const settings = Settings.isolated({
		"providers.cacheRetention": "long",
		"compaction.enabled": true,
		"compaction.keepRecentTokens": 1,
		"compaction.methodOrder": ["soft"],
		"compaction.asyncEnabled": false,
		"contextPromotion.enabled": false,
	});
	const { session } = await createAgentSession({
		...gatewaySessionOptions(tempDir),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
		authStorage,
		modelRegistry,
		settings,
		model,
		toolNames: ["read", "bash", "debug", "edit"],
		contextFiles: [],
		skills: [],
	});
	try {
		await session.prompt(`zero ${"history ".repeat(40_000)}`);
		await session.prompt("first");
		const lastBefore = requests.at(-1);
		await session.setActiveToolsByName(roster);
		const withdrawnTokens = (lastBefore?.tools ?? [])
			.filter(tool => !roster.includes(tool.name))
			.reduce((tokens, tool) => tokens + wireToolTokens(session.agent.tokenizer, tool), 0);
		// Precondition: the last request declared the four tools, so the withdrawal leaves definitions to count.
		expect((lastBefore?.tools ?? []).map(tool => tool.name).sort()).toEqual(["bash", "debug", "edit", "read"]);
		expect(withdrawnTokens).toBeGreaterThan(1000);
		await check({ session, settings, requests, withdrawnTokens });
	} finally {
		await session.dispose();
		authStorage.close();
		restore();
	}
}

/**
 * Sets the compaction threshold half the withdrawn definitions above the local figure counted without them, then
 * prompts again. Returns whether compaction started on that prompt: the gateway got a summarization request besides
 * the prompt's own request.
 */
async function compactsOnThirdPrompt({ session, settings, requests, withdrawnTokens }: Withdrawn): Promise<boolean> {
	const tokenizer = session.agent.tokenizer;
	const localWithoutWithdrawn = activeRosterFigure(session) + tokenizer.countMessages(session.messages);
	cfgCompactionThresholdTokens.set(settings, localWithoutWithdrawn + Math.floor(withdrawnTokens / 2));
	const before = requests.length;
	await session.prompt("third");
	// Precondition: the third prompt's request went out, last.
	expect(textOf(requests.at(-1)?.messages)).toContain("third");
	return requests.slice(before, -1).some(request => textOf(request.messages).includes("<conversation>"));
}

describe("non-message figure on a session whose roster was emptied on a model that keeps its tool declaration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("counts no withdrawn tool, as the next request declares none", async () => {
		await withdrawAfterTwoPrompts([], {}, async ({ session, requests }) => {
			const figure = computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision);
			const rosterFigure = activeRosterFigure(session);
			await session.prompt("third");
			const third = requests.at(-1);
			// Precondition: the request after the withdrawal declared no tool.
			expect(third?.tools ?? []).toEqual([]);

			expect(figure).toBe(rosterFigure + offRosterWireTokens(session, third));
		});
	}, 60_000);

	it("starts no compaction on withdrawn definitions the next request does not declare", async () => {
		await withdrawAfterTwoPrompts([], {}, async withdrawn => {
			expect(await compactsOnThirdPrompt(withdrawn)).toBe(false);
			// Precondition: the request declared no tool, so none of the withdrawn definitions was sent.
			expect(withdrawn.requests.at(-1)?.tools ?? []).toEqual([]);
		});
	}, 60_000);

	it("compacts on withdrawn definitions the next request still declares beside a tool on the roster", async () => {
		await withdrawAfterTwoPrompts(["read"], {}, async withdrawn => {
			expect(await compactsOnThirdPrompt(withdrawn)).toBe(true);
			// Precondition: the request declared the withdrawn tools beside `read`.
			expect((withdrawn.requests.at(-1)?.tools ?? []).map(tool => tool.name).sort()).toEqual([
				"bash",
				"debug",
				"edit",
				"read",
			]);
		});
	}, 60_000);

	it("reads the provider's usage for the request that declared no tool", async () => {
		await withdrawAfterTwoPrompts([], { inputTokens: 5000 }, async ({ session, requests }) => {
			await session.prompt("third");
			// Precondition: the request declared no tool, and its reply is the newest message.
			expect(requests.at(-1)?.tools ?? []).toEqual([]);
			expect(session.messages.at(-1)?.role).toBe("assistant");

			// Nothing was added after the reply, so the context is the 5000 input tokens the provider reported.
			expect(session.getContextBreakdown({ contextWindow: CONTEXT_WINDOW })?.usedTokens).toBe(5000);
		});
	}, 60_000);
});
