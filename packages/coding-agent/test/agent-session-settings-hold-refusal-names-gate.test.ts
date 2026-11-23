/**
 * A configuration sync turns a tool gate off (`todo.enabled: false`) in the same batch as other settings (a model-role
 * edit that drops a per-call entry, a new `personality`) under a Claude session whose prompt is bound. The batch is
 * held: `todo` stays declared until the rebuild and a call to it is refused. The refusal and the hidden settings notice
 * must name the setting that turned the tool off, `todo.enabled`. A model-role listener reconciles the tool set with
 * the batch's settings already applied, so the removal of `todo` is recorded under `modelRoles` alone.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const GATEWAY = "http://gateway.test.local:4000";
const SETTINGS_NOTICE = '<system-notice id="settings">';
const MINUTE_MS = 60_000;

const MODELS_YML = `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: not-a-secret
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
      - {id: claude-sonnet-5-5, name: Claude Sonnet 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

/** The overlay a sync rewrites: one-hour cache entries, `todo` on, and the batch's other settings as given. */
function overlay(todoEnabled: boolean, personality: string, perCall: boolean): string {
	return [
		"providers:\n  cacheRetention: long",
		"modelRoles:",
		"  default: anthropic/claude-opus-5-5",
		...(perCall ? ["  per-call-claude-sonnet-5-5: anthropic/claude-sonnet-5-5"] : []),
		"compaction:\n  enabled: false",
		"retry:\n  enabled: false",
		`todo:\n  enabled: ${todoEnabled}`,
		`personality: ${personality}`,
		"",
	].join("\n");
}

const BEFORE = overlay(true, "default", true);
const SYNCED = overlay(false, "pragmatic", false);

/** The real clock, read before a test moves it. */
const realNow = Date.now.bind(Date);

function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/** A streamed reply of one content block. */
function reply(turn: number, block: Record<string, unknown>, delta: Record<string, unknown>, stop: string): Response {
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
				usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: block },
		{ type: "content_block_delta", index: 0, delta },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface WireRequest {
	system?: unknown;
	messages: Array<{ role: string; content: unknown }>;
}

/** Every text a wire value carries. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.content].map(textOf).join("\n");
}

let root: string;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hold-refusal-gate-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

/**
 * Runs the session: a first answer binds the prompt, the sync applies the batch, and the next prompt's reply calls
 * `todo` inside the hold. Gives the gateway's requests and the result of the `todo` call.
 */
async function runSyncedTodoCall(): Promise<{ requests: WireRequest[]; todoResult: ToolResultMessage | undefined }> {
	const overlayPath = path.join(root, "overlay.yml");
	await Bun.write(overlayPath, BEFORE);
	await Bun.write(path.join(root, "models.yml"), MODELS_YML);
	const settings = await Settings.loadIsolated({ cwd: root, agentDir: root, configFiles: [overlayPath] });
	const requests: WireRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
		requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
		const turn = requests.length;
		if (turn === 2) {
			return reply(
				turn,
				{ type: "tool_use", id: "toolu_todo", name: "todo", input: {} },
				{ type: "input_json_delta", partial_json: JSON.stringify({ op: "append", items: ["check"] }) },
				"tool_use",
			);
		}
		return reply(turn, { type: "text", text: "" }, { type: "text_delta", text: `seen ${turn}` }, "end_turn");
	}) as unknown as typeof fetch);
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		authStorage,
		modelRegistry,
		model,
		settings,
		sessionManager: SessionManager.create(root, path.join(root, "sessions")),
		disableExtensionDiscovery: true,
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read", "todo"],
		contextFiles: [],
		skills: [],
	});
	try {
		setClock(0);
		await session.prompt("first");
		await reloadOverlay(session, settings, overlayPath, SYNCED);
		setClock(MINUTE_MS);
		await session.prompt("add a todo");
		const todoResult = session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "todo",
		);
		return { requests, todoResult };
	} finally {
		await session.dispose();
		authStorage.close();
	}
}

/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuilds and holds it starts. */
async function reloadOverlay(session: AgentSession, settings: Settings, overlayPath: string, content: string) {
	const calls = ["refreshBaseSystemPrompt", "reconcileBuiltinTools", "holdToolDeclarationChange"] as const;
	const spies = calls
		.filter(call => typeof (session as unknown as Record<string, unknown>)[call] === "function")
		.map(call => vi.spyOn(session as unknown as Record<string, () => Promise<void>>, call));
	await Bun.write(overlayPath, content);
	await settings.reloadFromDisk();
	// One event-loop turn, no delay: the settings listeners start their rebuilds in it.
	await Bun.sleep(0);
	await Promise.all(spies.flatMap(spy => spy.mock.results.map(result => result.value)));
	for (const spy of spies) spy.mockRestore();
}

it("names `todo.enabled` in the refusal of a todo call inside the hold", async () => {
	const { requests, todoResult } = await runSyncedTodoCall();
	const [first, held] = requests;
	if (!first || !held || !todoResult) throw new Error("Expected two requests and the todo call's result");
	// Preconditions: the batch is held (the request after it keeps the first prompt) and the call is refused.
	expect(textOf(held.system)).toBe(textOf(first.system));
	expect(todoResult.isError).toBe(true);
	expect(textOf(todoResult.content)).toContain("is disabled by a settings change");

	expect(textOf(todoResult.content)).toContain("`todo.enabled`");
}, 60_000);

it("names `todo.enabled` in the settings notice of the held batch", async () => {
	const { requests } = await runSyncedTodoCall();
	const [first, held] = requests;
	if (!first || !held) throw new Error("Expected two requests");
	const notice = textOf(held.messages.slice(first.messages.length));
	// Preconditions: the batch is held and the notice says `todo` is disabled.
	expect(textOf(held.system)).toBe(textOf(first.system));
	expect(notice).toContain(SETTINGS_NOTICE);
	expect(notice).toContain("`todo`");

	expect(notice).toContain("`todo.enabled`");
}, 60_000);
