/**
 * A Factory Droid GPT-6 model goes out on Factory's Responses wire, whose provider keeps the conversation's first
 * request-level `reasoning.effort` and carries a later thinking level change as a `configuration_update` item after the
 * newest content: the change leaves every cached message, and the prompt ahead of them, as the request before sent it.
 * The session must not count it as a change of the cache key, as it does not on OpenAI's own Responses API: counted as
 * one, the status line shows an entry the next request reads as cold, the warmer stops refreshing it, and the cut rule
 * admits a cut on an entry it reads as lost.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { factoryModel, WORKOS_TOKEN } from "../../ai/test/helpers/factory-droid";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** A Responses request body, as far as the test reads it. */
interface ResponsesRequest {
	reasoning?: { effort?: string };
	input?: unknown[];
}

/** A streamed text reply, `seen <turn>`, from `model`, that read 100 of its request's 110 prompt tokens from the cache. */
function answer(turn: number, model: string): Response {
	const text = `seen ${turn}`;
	const item = { type: "message", id: `msg_${turn}`, role: "assistant" };
	const events = [
		{ type: "response.created", response: { id: `resp_${turn}`, model } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", item_id: `msg_${turn}`, output_index: 0, content_index: 0, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { ...item, status: "completed", content: [{ type: "output_text", text }] },
		},
		{
			type: "response.completed",
			response: {
				id: `resp_${turn}`,
				model,
				status: "completed",
				usage: {
					input_tokens: 110,
					output_tokens: 3,
					total_tokens: 113,
					input_tokens_details: { cached_tokens: 100 },
				},
			},
		},
	];
	const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("a thinking level change on a Factory Droid GPT-6 model, whose provider carries it as a configuration update", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("keeps the cache key", async () => {
		const dir = TempDir.createSync("@pi-factory-effort-change-cache-shape-");
		cleanups.push(() => dir.remove());
		// Five-minute and one-hour cache lifetimes, as a models.yml `promptCache` override declares them.
		const model = { ...factoryModel("gpt-6.1-sol"), promptCache: { short: 300, long: 3600 } };
		const requests: ResponsesRequest[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (new URL(url).pathname !== "/api/llm/o/v1/responses") {
					throw new Error(`Unexpected request to ${url}`);
				}
				const body = typeof init?.body === "string" ? init.body : "{}";
				requests.push(JSON.parse(body));
				return answer(requests.length, model.id);
			}),
		);
		cleanups.push(() => spy.mockRestore());
		const authStorage = await AuthStorage.create(dir.join("auth.db"));
		authStorage.keys.setRuntime("factory-droid", WORKOS_TOKEN);
		cleanups.push(() => authStorage.close());
		const { session } = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, dir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "providers.cacheRetention": "long" }),
			model,
			thinkingLevel: ThinkingLevel.High,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		cleanups.push(() => session.dispose());

		await session.prompt("first");
		session.setThinkingLevel(ThinkingLevel.Low);
		const status = session.getPromptCacheStatus();
		await session.prompt("second");

		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected two requests");
		// Preconditions: the second request keeps the first one's request-level effort and carries the new level as a
		// configuration update after the newest content, so its prompt extends the first one's.
		expect(first.reasoning?.effort).toBe("high");
		expect(second.reasoning?.effort).toBe("high");
		expect(second.input?.slice(0, first.input?.length)).toEqual(first.input);
		expect(second.input?.slice(first.input?.length)).toContainEqual({
			type: "configuration_update",
			reasoning: { effort: "low" },
		});

		expect(status).toMatchObject({ state: "warm", reason: undefined });
	}, 60_000);
});
