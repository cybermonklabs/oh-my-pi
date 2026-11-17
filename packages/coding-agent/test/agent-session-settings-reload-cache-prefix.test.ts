import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** An Anthropic gateway reached on a `.local` host, configured as a deployment's `models.yml` declares it. */
const GATEWAY = "http://gateway.test.local:4000";
function modelsYml(contextWindow: number): string {
	return `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: ${contextWindow}, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;
}

/** The `--config` overlay a configuration sync rewrites under a running session. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

const HOUR_MS = 60 * 60_000;

interface WireMessage {
	role: string;
	content: unknown;
}

interface MessagesRequest {
	system?: unknown;
	tools?: unknown[];
	messages: WireMessage[];
}

/** A streamed reply of one content block; the request it answers sent `inputTokens` uncached. */
function stream(
	turn: number,
	block: Record<string, unknown>,
	deltas: unknown[],
	stopReason: string,
	inputTokens = 10,
): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: `msg_${turn}`,
				type: "message",
				role: "assistant",
				content: [],
				model: "claude-opus-5-5",
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: inputTokens,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 100,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: block },
		...deltas.map(delta => ({ type: "content_block_delta", index: 0, delta })),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textAnswer(turn: number, inputTokens?: number): Response {
	return stream(
		turn,
		{ type: "text", text: "" },
		[{ type: "text_delta", text: `seen ${turn}` }],
		"end_turn",
		inputTokens,
	);
}

function toolCallAnswer(turn: number, name: string, input: Record<string, unknown>): Response {
	return stream(
		turn,
		{ type: "tool_use", id: `toolu_${turn}`, name, input: {} },
		[{ type: "input_json_delta", partial_json: JSON.stringify(input) }],
		"tool_use",
	);
}

/** Cache breakpoints follow the end of each request, so they are left out of the comparison. */
function withoutCacheControl(value: unknown): string {
	return JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner));
}

/**
 * Whether `later` sends `earlier`'s prompt in cache order, tools, then system, then every message, with the same
 * bytes, so its cache lookup reads all of `earlier`'s prompt.
 */
function continuesCachedPrompt(earlier: MessagesRequest, later: MessagesRequest): boolean {
	return (
		withoutCacheControl(later.tools) === withoutCacheControl(earlier.tools) &&
		withoutCacheControl(later.system) === withoutCacheControl(earlier.system) &&
		withoutCacheControl(later.messages.slice(0, earlier.messages.length)) === withoutCacheControl(earlier.messages)
	);
}

/** Every text a wire value carries: text blocks, string contents and nested tool results. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.content].map(textOf).join("\n");
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	modelRegistry: ModelRegistry;
}

describe("prompt rebuilds a configuration reload starts on a prefix-bound model", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * A session on the gateway's claude-opus-5-5 (a 1M window unless `contextWindow` says otherwise) whose settings
	 * load `OVERLAY` and `overlay` as a `--config` file. `replies` answers requests by their 1-based number; the rest
	 * get text.
	 */
	async function startSession(
		tempDir: TempDir,
		options: {
			toolNames: string[];
			discoverContextFiles?: boolean;
			overlay?: string;
			contextWindow?: number;
			replies?: Record<number, (turn: number) => Response>;
		},
	): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), modelsYml(options.contextWindow ?? 1_000_000));
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, `${OVERLAY}${options.overlay ?? ""}`);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				const turn = requests.length;
				return (options.replies?.[turn] ?? textAnswer)(turn);
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: options.toolNames,
			...(options.discoverContextFiles ? {} : { contextFiles: [] }),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay, modelRegistry };
	}

	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuilds the change starts. */
	async function reloadOverlay(harness: Harness, content: string): Promise<void> {
		const rebuilds = [
			vi.spyOn(harness.session, "refreshBaseSystemPrompt"),
			vi.spyOn(harness.session, "reconcileBuiltinTools"),
			vi.spyOn(harness.session, "refreshSkillsAndCommands"),
		];
		await Bun.write(harness.overlay, content);
		await harness.settings.reloadFromDisk();
		// The settings listeners run in the microtask the reload queued for them.
		await Promise.resolve();
		await Promise.all(rebuilds.flatMap(spy => spy.mock.results.map(result => result.value)));
		for (const spy of rebuilds) spy.mockRestore();
	}

	function requestPair(harness: Harness): [MessagesRequest, MessagesRequest] {
		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		return [first, second];
	}

	it("keeps the system prompt and tools when a reload changes personality, and names the change in a notice", async () => {
		using tempDir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		const harness = await startSession(tempDir, { toolNames: ["read"] });
		await harness.session.prompt("first");

		await reloadOverlay(harness, `${OVERLAY}personality: pragmatic\n`);
		await harness.session.prompt("second");

		const [first, second] = requestPair(harness);
		expect(continuesCachedPrompt(first, second)).toBe(true);
		const notice = textOf(second.messages.slice(first.messages.length));
		expect(notice).toContain("`personality`");
		expect(notice).toContain('"default"');
		expect(notice).toContain('"pragmatic"');
	}, 30_000);

	it("keeps the tools when a reload disables todo, and refuses a call to it naming the setting", async () => {
		using tempDir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		const harness = await startSession(tempDir, {
			toolNames: ["read", "eval", "todo"],
			replies: { 2: turn => toolCallAnswer(turn, "todo", { op: "view" }) },
		});
		await harness.session.prompt("first");

		await reloadOverlay(harness, `${OVERLAY}todo:\n  enabled: false\n`);
		await harness.session.prompt("second");

		const [first, second] = requestPair(harness);
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		const notice = textOf(second.messages.slice(first.messages.length));
		expect(notice).toContain("`todo.enabled`");
		expect(notice).toContain("`todo`");

		// The model called `todo` in its answer to the second request; the third request carries the refusal.
		const third = harness.requests[2];
		if (!third) throw new Error("Expected the request after the refused call");
		const results = third.messages.flatMap(message =>
			Array.isArray(message.content)
				? (message.content as Array<Record<string, unknown>>).filter(block => block.type === "tool_result")
				: [],
		);
		const refusal = results.find(block => block.tool_use_id === "toolu_2");
		expect(refusal?.is_error).toBe(true);
		expect(textOf(refusal)).toContain("todo.enabled");
	}, 30_000);

	it("keeps the system prompt when a reload changes disabledProviders after a context file was edited", async () => {
		using tempDir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		await Bun.write(tempDir.join("AGENTS.md"), "# Rules\n\n- The rule the session started with.\n");
		const harness = await startSession(tempDir, { toolNames: ["read"], discoverContextFiles: true });
		await harness.session.prompt("first");

		await Bun.write(tempDir.join("AGENTS.md"), "# Rules\n\n- A rule added while the session runs.\n");
		await reloadOverlay(harness, `${OVERLAY}disabledProviders:\n  - ollama\n`);
		await harness.session.prompt("second");

		const [first, second] = requestPair(harness);
		expect(withoutCacheControl(first.system)).toContain("The rule the session started with.");
		expect(continuesCachedPrompt(first, second)).toBe(true);
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`disabledProviders`");
	}, 30_000);

	it("sends the rebuilt prompt at the first request after the held prompt's cache entry lapsed", async () => {
		using tempDir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		const harness = await startSession(tempDir, { toolNames: ["read"] });
		await harness.session.prompt("first");
		await reloadOverlay(harness, `${OVERLAY}personality: pragmatic\n`);
		await harness.session.prompt("second");
		// The entry is still live: the rebuild stays held.
		await harness.session.prompt("third");

		// Two hours on, the one-hour entry the third request wrote is gone.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * HOUR_MS);
		await harness.session.prompt("fourth");

		const [first, , third, fourth] = harness.requests;
		if (!first || !third || !fourth) throw new Error("Expected four requests");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(fourth.system)).not.toBe(withoutCacheControl(first.system));
		expect(textOf(fourth.messages.slice(third.messages.length))).not.toContain("`personality`");
	}, 30_000);

	it("keeps the held prompt across an admitted cut that keeps earlier messages, and sends it rebuilt after a compaction", async () => {
		// A forced auto-shake elides old read results and keeps the messages before them cached: the prompt stays held.
		// (A prefix-bound model prunes nothing inside a warm prefix, so the shake is the partial cut a session can make.)
		using shakeDir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		const parts = ["part1.txt", "part2.txt", "part3.txt", "part4.txt"];
		for (const [index, part] of parts.entries()) {
			const lines = Array.from(
				{ length: 400 },
				(_, line) => `${part} line ${line}: ${"alpha beta gamma delta ".repeat(5)}`,
			);
			await Bun.write(shakeDir.join(part), `${lines.join("\n")}\n${index}\n`);
		}
		const shake = "compaction:\n  methodOrder: [shake]\n  asyncEnabled: false\n";
		const shaken = await startSession(shakeDir, {
			toolNames: ["read"],
			overlay: shake,
			contextWindow: 100_000,
			replies: {
				...Object.fromEntries(
					parts.map((part, index) => [index + 2, (turn: number) => toolCallAnswer(turn, "read", { path: part })]),
				),
				// The reply after the reads fills the window past its reserve.
				[parts.length + 2]: (turn: number) => textAnswer(turn, 90_000),
			},
		});
		await shaken.session.prompt("first");
		await reloadOverlay(shaken, `${OVERLAY}${shake}personality: pragmatic\n`);
		await shaken.session.prompt("read the parts");
		await shaken.session.prompt("after the shake");
		const [shakeFirst] = shaken.requests;
		const afterShake = shaken.requests.at(-1);
		if (!shakeFirst || !afterShake) throw new Error("Expected the requests around the shake");
		expect(textOf(afterShake.messages)).toContain("[shaken ~");
		expect(withoutCacheControl(afterShake.system)).toBe(withoutCacheControl(shakeFirst.system));

		// A compaction forced by a full window rewrites every message anyway: the next request carries the rebuild.
		using compactDir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		const soft = "compaction:\n  methodOrder: [soft]\n  asyncEnabled: false\n  keepRecentTokens: 1\n";
		const compacted = await startSession(compactDir, {
			toolNames: ["read"],
			overlay: soft,
			contextWindow: 100_000,
			// The second request fills the window past its reserve.
			replies: { 2: turn => textAnswer(turn, 90_000) },
		});
		// No model to summarize with: the admitted compaction starts, then ends skipped.
		vi.spyOn(compacted.modelRegistry, "getAvailable").mockReturnValue([]);
		await compacted.session.prompt("first");
		await reloadOverlay(compacted, `${OVERLAY}${soft}personality: pragmatic\n`);
		await compacted.session.prompt("second");
		await compacted.session.prompt("third");
		const [compactFirst, compactSecond, compactThird] = compacted.requests;
		if (!compactFirst || !compactSecond || !compactThird) throw new Error("Expected three requests");
		expect(withoutCacheControl(compactSecond.system)).toBe(withoutCacheControl(compactFirst.system));
		expect(withoutCacheControl(compactThird.system)).not.toBe(withoutCacheControl(compactFirst.system));
	}, 60_000);
});
