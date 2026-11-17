/**
 * A Codex usage limit on one stored account while the other stored account
 * cannot serve the model. The rotation check reads only credential blocks, so
 * it calls the other account free; selection refuses that account for a reason
 * that writes no block (a plan gate) and serves the exhausted account again.
 * Recovery must reach the fallback chain after one retry on that account
 * instead of spending the whole retry budget on back-to-back requests to it.
 *
 * A model whose discovered account list omits the other account is no such
 * refusal: selection tries an unblocked account the list omits before it reuses
 * a blocked account the list names (upstream 88a69582c7). That saga asks the
 * listed account again only after the block its usage limit wrote has lapsed.
 *
 * Everything between the session and the network is real: AgentSession, the
 * Agent loop, the in-stream auth-retry driver, the openai-codex provider,
 * AuthStorage on SQLite and the Codex usage provider. Only the network, the
 * clock and the fallback model are fake: `/responses` answers the Codex
 * usage-limit error event (which carries no reset hint), `/wham/usage` answers
 * each account's report, a retry wait advances the clock instead of sleeping,
 * and the fallback is a scripted mock stream. The credential store and the
 * model cache are SQLite databases in memory, so no step waits on the disk.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { DEFAULT_BLOCK_MS } from "@oh-my-pi/pi-ai/auth/blocks";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { planRequirementFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { retainModelCacheConnection, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch, type FetchInput, mockFetch } from "./helpers/fetch-mock";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { getTestModel } from "./helpers/model-fixtures";

const PROVIDER = "openai-codex";
const DAY_MS = 24 * 60 * 60 * 1000;
const CODEX_USAGE_LIMIT_EVENT = {
	type: "error",
	code: "usage_limit_reached",
	message: "The usage limit has been reached",
};

/**
 * The model cache's database. SQLite's `:memory:` database lives as long as its
 * connection, and the cache opens a connection per read or write unless one is
 * retained, so each saga retains one for the cache to share.
 */
const MODEL_CACHE_DB = ":memory:";

type Account = "acct-A" | "acct-B";
/** `unavailable` answers 500, so the account has no usage report. */
type UsageMode = "unavailable" | "healthy" | "free-plan";

interface Scenario {
	modelId: string;
	usage: Record<Account, UsageMode>;
	/** Accounts a cached Codex discovery lists on the model (`Model.accountAccess`). */
	accountAccess?: Account[];
}

interface SagaResult {
	/** Account of every Codex `/responses` request, in order. */
	codexRequests: string[];
	/** Clock reading at every Codex `/responses` request, in order. */
	codexRequestAtMs: number[];
	/** Account that served every failed assistant turn, in order. */
	errorTurns: string[];
	finalModel: string;
	finalText: string;
}

function fakeJwt(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" },
			"https://api.openai.com/profile": { email: `${accountId}@example.test` },
		}),
		"utf8",
	).toBase64();
	return `hdr.${payload}.sig`;
}

function usageResponse(mode: UsageMode): Response {
	if (mode === "unavailable") return new Response("unavailable", { status: 500 });
	const resetAt = Math.floor((Date.now() + 5 * DAY_MS) / 1000);
	return Response.json({
		plan_type: mode === "free-plan" ? "free" : "plus",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: resetAt },
			secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: resetAt },
		},
		credits: { has_credits: false, balance: "0" },
	});
}

function requestPath(input: FetchInput): string {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(url).pathname;
}

function accountHeader(input: FetchInput, init: RequestInit | undefined): string {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	return headers.get("chatgpt-account-id") ?? "none";
}

async function runUsageLimitSaga(scenario: Scenario): Promise<SagaResult> {
	using tempDir = TempDir.createSync("@usage-limit-rotation-");
	// On disk, opening and closing the two stores syncs the disk about thirty
	// times per saga, and on a loaded machine those syncs alone outlast the
	// test's timeout.
	using _modelCache = retainModelCacheConnection(MODEL_CACHE_DB);
	// Any stray global fetch (an OAuth refresh) gets an offline 503; model
	// discovery is already offline under bun test.
	vi.spyOn(globalThis, "fetch").mockImplementation(asGlobalFetch(() => new Response("offline", { status: 503 })));
	// A retry wait advances the clock instead of sleeping, so a wait for a block
	// to lapse takes no wall time and the result does not depend on it.
	mockSchedulerWaitWithClock();
	const usageFetch = asGlobalFetch((input, init) => {
		if (!requestPath(input).endsWith("/wham/usage")) return new Response("not found", { status: 404 });
		return usageResponse(scenario.usage[accountHeader(input, init) as Account]);
	});

	const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), { usageFetch });
	let session: AgentSession | undefined;
	try {
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const expires = Date.now() + 7 * DAY_MS;
		await authStorage.credentials.set(
			PROVIDER,
			(["acct-A", "acct-B"] as const).map(accountId => ({
				type: "oauth" as const,
				access: fakeJwt(accountId),
				refresh: `refresh-${accountId}`,
				expires,
				accountId,
				email: `${accountId}@example.test`,
			})),
		);
		const accountOfCredential = new Map(
			authStorage.credentials
				.list(PROVIDER)
				.map(row => [row.id, row.credential.type === "oauth" ? row.credential.accountId : undefined]),
		);

		const primary = getBundledModel(PROVIDER, scenario.modelId);
		const fallback = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary || !fallback) throw new Error("Expected bundled test models to exist");
		if (scenario.accountAccess) {
			// What Codex discovery caches when it ran before the other account was
			// stored: the model lists only the accounts whose catalog returned it.
			const accountAccess = Object.fromEntries(scenario.accountAccess.map(accountId => [accountId, {}]));
			writeModelCache(
				resolveModelCacheProviderId(PROVIDER),
				Date.now(),
				getBundledModels(PROVIDER).map(model =>
					model.id === scenario.modelId ? { ...model, accountAccess } : model,
				),
				true,
				"",
				MODEL_CACHE_DB,
			);
		}
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), {
			cacheDbPath: MODEL_CACHE_DB,
		});
		if (scenario.accountAccess) {
			// The bundled model's own account list names neither account, and under it
			// the saga ends the same way, so check the cached list is the one served.
			const listed = modelRegistry.find(PROVIDER, scenario.modelId)?.accountAccess;
			expect(Object.keys(listed ?? {})).toEqual(scenario.accountAccess);
		}

		const codexRequests: string[] = [];
		const codexRequestAtMs: number[] = [];
		const codexFetch = mockFetch((input, init) => {
			if (!requestPath(input).endsWith("/responses")) return new Response("not found", { status: 404 });
			codexRequests.push(accountHeader(input, init));
			codexRequestAtMs.push(Date.now());
			return new Response(`data: ${JSON.stringify(CODEX_USAGE_LIMIT_EVENT)}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => modelRegistry.resolver(model, session?.sessionId),
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				if (model.provider === PROVIDER) {
					return streamSimple({ ...model, preferWebsockets: false }, context, {
						...options,
						fetch: codexFetch,
					});
				}
				mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				return mock.stream(model, context, options);
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.fallbackChains": {
					[`${primary.provider}/${primary.id}`]: [`${fallback.provider}/${fallback.id}`],
				},
			}),
			modelRegistry,
		});
		const errorTurns: string[] = [];
		session.subscribe(event => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			if (event.message.stopReason !== "error") return;
			const credentialId = event.message.credentialId;
			errorTurns.push((credentialId === undefined ? undefined : accountOfCredential.get(credentialId)) ?? "none");
		});

		await session.prompt("Answer once");
		await session.waitForIdle();

		const last = session.messages.at(-1);
		const finalText =
			last?.role === "assistant"
				? last.content.map(block => (block.type === "text" ? block.text : "")).join("")
				: "";
		return {
			codexRequests,
			codexRequestAtMs,
			errorTurns,
			finalModel: `${session.model?.provider}/${session.model?.id}`,
			finalText,
		};
	} finally {
		await session?.dispose();
		authStorage.close();
	}
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("usage-limit recovery when selection refuses the other account", () => {
	// Regression: each claimed switch landed on the exhausted account again, so
	// the session sent 1 + retry.maxRetries back-to-back requests to it before the
	// fallback answered.
	it("falls back after one retry on the exhausted account when the plan gate refuses the other account", async () => {
		const result = await runUsageLimitSaga({
			modelId: "gpt-5.6-sol",
			usage: { "acct-A": "healthy", "acct-B": "free-plan" },
		});

		expect(result.codexRequests).toEqual(["acct-A", "acct-A"]);
		expect(result.errorTurns).toEqual(["acct-A", "acct-A"]);
		expect(result.finalModel).toBe("anthropic/claude-sonnet-4-5");
		expect(result.finalText).toBe("ok:anthropic/claude-sonnet-4-5");
	}, 15_000);
});

describe("usage-limit recovery when the model's account list omits the other account", () => {
	// Codex discovery that ran before acct-B was stored lists only acct-A on the
	// model. Once acct-A's usage limit blocks it, selection serves acct-B, so the
	// in-stream auth retry moves the first turn there. With acct-B spent too,
	// recovery waits for acct-A's block (no usage report, so the default block)
	// and falls back after that one retry on acct-A.
	it("tries the other account, then falls back after one retry on the listed account once its block lapses", async () => {
		const result = await runUsageLimitSaga({
			// A model no plan gate restricts, so only the account list could refuse the other account.
			modelId: getTestModel(PROVIDER, model => planRequirementFor(PROVIDER, model.id) === undefined).id,
			usage: { "acct-A": "unavailable", "acct-B": "unavailable" },
			accountAccess: ["acct-A"],
		});

		expect(result.codexRequests).toEqual(["acct-A", "acct-B", "acct-A"]);
		expect(result.errorTurns).toEqual(["acct-B", "acct-A"]);
		expect(result.codexRequestAtMs[2] - result.codexRequestAtMs[0]).toBeGreaterThanOrEqual(DEFAULT_BLOCK_MS);
		expect(result.finalModel).toBe("anthropic/claude-sonnet-4-5");
		expect(result.finalText).toBe("ok:anthropic/claude-sonnet-4-5");
	}, 15_000);
});
