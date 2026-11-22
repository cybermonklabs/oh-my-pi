/**
 * A side request (a subagent's progress probe) repeats the prefix of the session's newest main request, and may use the
 * prompt cache only while the next request would send that prefix again ({@link AgentSession.promptCacheExpiresAt}).
 *
 * An endpoint that cannot compile strict tool schemas answers 400; the provider retries the request without strict
 * tools, and the retry writes the entry the next request reads. A side request after it must still find the cache: a
 * session that judged it against the tools the refused request declared would refuse every side request until its next
 * main request, with a prompt cache warmer or without one.
 *
 * Anthropic keys the cached messages on `tool_choice`: a turn whose forced choice the model keeps writes messages the
 * next request, back on the default choice, does not read. Without a warmer too, a side request is judged against the
 * default-choice request before that turn.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	type GatewayFetch,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	toolCallAnswer,
} from "./helpers/anthropic-gateway";

/** The 400 an endpoint answers a strict request with when it cannot compile the tools' grammar. */
const GRAMMAR_REJECTION = JSON.stringify({
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
	},
	request_id: "req_400",
});

/** Whether `request` declares a tool as strict. */
function sendsStrictTool(request: MessagesRequest): boolean {
	return (request.tools ?? []).some(tool => isRecord(tool) && tool.strict === true);
}

/** How the gateway answers its `turn`th request, `request`. */
type Reply = (turn: number, request: MessagesRequest | undefined) => Response;

/** A gateway that refuses each request declaring a strict tool with the grammar 400, and answers the others. */
const refusesStrictTools: Reply = (turn, request) =>
	request && sendsStrictTool(request)
		? new Response(GRAMMAR_REJECTION, { status: 400, headers: { "content-type": "application/json" } })
		: answer(turn, { cacheWriteTokens: 100 });

/** How a test opens its session. */
interface GatewaySession {
	/** The model on the gateway's card in place of claude-opus-5-5. */
	model?: { id: string; name: string };
	/** Whether the session runs a prompt cache warmer. */
	cacheWarming: boolean;
	reply: Reply;
}

/**
 * Opens a session in `tempDir` on the gateway's model, with `edit` (a tool Anthropic's API declares strict) and `write`,
 * and one-hour cache entries, runs `act` on it and disposes it. Returns the requests the gateway received.
 */
async function runGatewaySession(
	tempDir: TempDir,
	{ model: card, cacheWarming, reply }: GatewaySession,
	act: (session: AgentSession) => Promise<void>,
): Promise<MessagesRequest[]> {
	const modelsYml = gatewayModelsYml();
	await Bun.write(
		tempDir.join("models.yml"),
		card
			? modelsYml.replace("id: claude-opus-5-5, name: Claude Opus 5.5", `id: ${card.id}, name: ${card.name}`)
			: modelsYml,
	);
	const gateway: GatewayFetch = mockGatewayFetch(turn => reply(turn, gateway.requests[turn - 1]));
	const authStorage = createInMemoryAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const id = card?.id ?? "claude-opus-5-5";
		const model = modelRegistry.find("anthropic", id);
		if (!model) throw new Error(`Expected the gateway's ${id}`);
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			thinkingLevel: ThinkingLevel.High,
			toolNames: ["edit", "write"],
			contextFiles: [],
			skills: [],
			cacheWarming,
		});
		try {
			await act(session);
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		gateway.restore();
	}
	return gateway.requests;
}

describe("a side request after the provider retried a request without strict tools", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("may use the cache in a session with a warmer", async () => {
		using tempDir = TempDir.createSync("@pi-fallback-side-request-");
		let expiresAt: number | undefined;
		const requests = await runGatewaySession(
			tempDir,
			{ cacheWarming: true, reply: refusesStrictTools },
			async session => {
				await session.prompt("first");
				expiresAt = session.promptCacheExpiresAt();
			},
		);
		// Precondition: the first request declared a strict tool, and only the 400 made the provider retry.
		expect(requests.map(sendsStrictTool)).toEqual([true, false]);

		// The next request declares the tools as the retry did: the entry it wrote still answers a side request.
		expect(expiresAt).toBeGreaterThan(Date.now());
	}, 60_000);

	it("follows the retried request in a session without a warmer", async () => {
		using tempDir = TempDir.createSync("@pi-fallback-side-request-");
		let expiresAt: number | undefined;
		let expiresAtThinkingOff: number | undefined;
		const requests = await runGatewaySession(
			tempDir,
			{ cacheWarming: false, reply: refusesStrictTools },
			async session => {
				await session.prompt("first");
				expiresAt = session.promptCacheExpiresAt();
				session.setThinkingLevel(ThinkingLevel.Off);
				expiresAtThinkingOff = session.promptCacheExpiresAt();
			},
		);
		expect(requests.map(sendsStrictTool)).toEqual([true, false]);

		// The session records its newest request without a warmer too, as the retry sent it: a side request may use the
		// cache, and may not once the next request sends another thinking setting before the messages.
		expect(expiresAt).toBeGreaterThan(Date.now());
		expect(expiresAtThinkingOff).toBeUndefined();
	}, 60_000);
});

describe("a side request after a turn forced to call a tool, in a session without a warmer", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{
			row: "is judged against the default-choice request before it on a model that keeps the forced choice",
			model: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			forced: true,
			toolChoices: [undefined, { type: "tool", name: "write" }, { type: "none" }],
			usesCache: true,
		},
		{
			row: "is judged against that turn on a model that sends the forced choice as auto (claude-opus-5-5)",
			model: undefined,
			forced: true,
			toolChoices: [undefined, { type: "auto" }, { type: "none" }],
			usesCache: false,
		},
		{
			row: "is judged against a turn on the default choice",
			model: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			forced: false,
			toolChoices: [undefined, undefined],
			usesCache: false,
		},
	])(
		"$row",
		async ({ model, forced, toolChoices, usesCache }) => {
			using tempDir = TempDir.createSync("@pi-fallback-side-request-");
			let expiresAt: number | undefined;
			const requests = await runGatewaySession(
				tempDir,
				{
					model,
					cacheWarming: false,
					// The forced turn calls `write`; the turn after it may call no tool.
					reply: turn =>
						forced && turn === 2
							? toolCallAnswer(
									turn,
									"write",
									{ path: tempDir.join("out.txt"), content: "x" },
									{ cacheWriteTokens: 100 },
								)
							: answer(turn, { cacheWriteTokens: 100 }),
				},
				async session => {
					await session.prompt("first");
					// The second prompt runs with thinking off; the thinking level is back before the side request.
					session.setThinkingLevel(ThinkingLevel.Off);
					if (forced) session.setForcedToolChoice("write");
					await session.prompt("second");
					session.setThinkingLevel(ThinkingLevel.High);
					expiresAt = session.promptCacheExpiresAt();
				},
			);
			// Preconditions: which requests carried a tool choice, and how each went out.
			expect(requests.map(request => (request as unknown as Record<string, unknown>).tool_choice)).toEqual([
				...toolChoices,
			]);

			// The session is back on the first request's thinking level. On a model that keeps the forced choice, the
			// second prompt sent no request on the default choice: a side request reads the entry the first request left.
			// A request of the second prompt on the default choice went out with thinking off: it left nothing a side
			// request with thinking on reads.
			if (usesCache) expect(expiresAt).toBeGreaterThan(Date.now());
			else expect(expiresAt).toBeUndefined();
		},
		60_000,
	);
});
