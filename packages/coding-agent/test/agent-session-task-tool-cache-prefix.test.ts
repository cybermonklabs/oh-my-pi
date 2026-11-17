import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentDefinition, refreshAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** An Anthropic gateway reached on a `.local` host, configured as a deployment's `models.yml` declares it. */
const GATEWAY = "http://gateway.test.local:4000";
const MODELS_YML = `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;

interface ToolDefinition {
	name: string;
}

interface MessagesRequest {
	system?: unknown;
	tools?: ToolDefinition[];
	messages: unknown[];
}

function answer(turn: number): Response {
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
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `seen ${turn}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	];
	const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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

function taskTool(request: MessagesRequest | undefined): string {
	const tool = request?.tools?.find(candidate => candidate.name === "task");
	if (!tool) throw new Error("Expected the task tool in the request");
	return withoutCacheControl(tool);
}

function agent(name: string, description: string): AgentDefinition {
	return { name, description, systemPrompt: `You are ${name}.`, source: "project" };
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	/** Definitions the next agent discovery scan returns. */
	discovered: AgentDefinition[];
}

describe("task tool definition across requests", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(tempDir: TempDir, settings: Settings): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				if (String(input) !== `${GATEWAY}/v1/messages`) throw new Error(`Unexpected request to ${String(input)}`);
				requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
				return answer(requests.length);
			}),
		);
		const discovered = [agent("explore", "Reads the repository and reports.")];
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => ({
			agents: [...discovered],
			projectAgentsDir: null,
		}));
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
			toolNames: ["read", "task"],
			contextFiles: [],
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
		return { session, settings, requests, discovered };
	}

	it("keeps the task tool's bytes when agent discovery gains an agent, and tells the model by a notice", async () => {
		using tempDir = TempDir.createSync("@pi-task-tool-cache-prefix-");
		const harness = await startSession(tempDir, Settings.isolated({ "providers.cacheRetention": "long" }));
		await harness.session.prompt("first");

		// An agent file written mid-session reaches discovery through a rescan (the agents hub, a plugin reload).
		harness.discovered.push(agent("rec-helper", "Helps with recording tests."));
		await refreshAgentDiscovery(harness.session.sessionManager.getCwd(), harness.session.effectiveExtensionRoots);
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		expect(taskTool(first)).not.toContain("rec-helper");
		expect(taskTool(second)).toBe(taskTool(first));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		// The new messages of the second request: the prompt and the hidden notice after it.
		const notice = withoutCacheControl(second.messages.slice(first.messages.length));
		expect(notice).toContain("`rec-helper`: Helps with recording tests.");
		expect(notice).not.toContain("`explore`");
	}, 30_000);

	it("keeps the task tool's bytes when the approved per-call models change, and tells the model by a notice", async () => {
		using tempDir = TempDir.createSync("@pi-task-tool-cache-prefix-");
		const settings = Settings.isolated({
			"providers.cacheRetention": "long",
			"task.perCallModel": "on",
			modelRoles: { "per-call-claude-opus-5-5": "anthropic/claude-opus-5-5:high" },
		});
		const harness = await startSession(tempDir, settings);
		await harness.session.prompt("first");

		// An operator config edit approves another per-call model mid-session.
		settings.setModelRole("per-call-claude-opus-5-5-low", "anthropic/claude-opus-5-5:low");
		await harness.session.prompt("second");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		expect(taskTool(first)).toContain("`anthropic/claude-opus-5-5:high` (per-call-claude-opus-5-5)");
		expect(taskTool(second)).toBe(taskTool(first));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		const notice = withoutCacheControl(second.messages.slice(first.messages.length));
		expect(notice).toContain("`anthropic/claude-opus-5-5:high` (per-call-claude-opus-5-5)");
		expect(notice).toContain("`anthropic/claude-opus-5-5:low` (per-call-claude-opus-5-5-low)");
	}, 30_000);
});
