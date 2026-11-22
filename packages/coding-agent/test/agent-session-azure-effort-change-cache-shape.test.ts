/**
 * The catalog marks Azure's GPT-6 models with `supportsConfigurationUpdate`, but the Azure Responses provider sends no
 * `configuration_update` item: a thinking level change goes out as another request-level `reasoning.effort`, which
 * changes the prompt the next request sends ahead of every cached message. The session must count it as a change of
 * the cache key, as it does on every model that does not carry the level per message: counted as none, the status line
 * shows the entry warm, the warmer keeps refreshing an entry the next request does not read, and a cut the rule would
 * admit on an unreadable entry waits.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { GATEWAY, gatewaySessionOptions } from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** Azure's bundled GPT-6.1 Sol behind a resource URL, with five-minute and one-hour cache lifetimes. */
const MODELS_YML = `providers:
  azure:
    baseUrl: ${GATEWAY}/openai/v1
    apiKey: azure-test-key
    modelOverrides:
      gpt-6.1-sol: {promptCache: {short: 300, long: 3600}}
`;

/** A Responses request body, as far as the test reads it. */
interface ResponsesRequest {
	reasoning?: { effort?: string };
	input?: unknown[];
}

/** A streamed text reply, `seen <turn>`, that read 100 of its request's 110 prompt tokens from the cache. */
function answer(turn: number): Response {
	const text = `seen ${turn}`;
	const item = { type: "message", id: `msg_${turn}`, role: "assistant" };
	const events = [
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

describe("a thinking level change on Azure's GPT-6, whose provider sends no configuration update", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("counts the level change as a change of the cache key", async () => {
		const dir = TempDir.createSync("@pi-azure-effort-change-cache-shape-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), MODELS_YML);
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, "providers:\n  cacheRetention: long\n");
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const requests: ResponsesRequest[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (!String(input).startsWith(`${GATEWAY}/openai/v1/responses`)) {
					throw new Error(`Unexpected request to ${String(input)}`);
				}
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				return answer(requests.length);
			}),
		);
		cleanups.push(async () => spy.mockRestore());
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("azure", "gpt-6.1-sol");
		if (!model) throw new Error("Expected Azure's gpt-6.1-sol");
		// Precondition: the catalog marks the model as one that takes the level per message.
		expect(model.compat).toMatchObject({ supportsConfigurationUpdate: true });
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			thinkingLevel: ThinkingLevel.High,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});

		await session.prompt("first");
		session.setThinkingLevel(ThinkingLevel.Low);
		const status = session.getPromptCacheStatus();
		await session.prompt("second");

		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected two requests");
		// Preconditions: the second request sends the new level as its request-level effort, with no configuration
		// update item carrying it after the newest content.
		expect(first.reasoning?.effort).toBe("high");
		expect(second.reasoning?.effort).toBe("low");
		expect(JSON.stringify(second.input)).not.toContain("configuration_update");

		expect(status).toMatchObject({ state: "cold", reason: { kind: "thinking", from: "high", to: "low" } });
	}, 60_000);
});
