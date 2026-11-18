import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model, Usage } from "@oh-my-pi/pi-ai";
import { NO_AUTH_SENTINEL } from "@oh-my-pi/pi-ai/auth-retry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { startCompletionProbe } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import { TempDir } from "@oh-my-pi/pi-utils";

const MINUTE = 60_000;

/** A source file's worth of tool output: about 20,000 tokens. */
const LARGE_TOOL_OUTPUT = Array.from(
	{ length: 2_000 },
	(_, line) => `line ${line}: const value${line} = compute(${line});`,
).join("\n");

const LOOKUP_TOOL = {
	name: "lookup",
	label: "Lookup",
	description: "Look up a value",
	parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	execute: async () => ({ content: [], details: {} }),
};

function usage(cache: Partial<Pick<Usage, "input" | "cacheRead" | "cacheWrite" | "cttl">>): Usage {
	const input = cache.input ?? 10;
	return {
		input,
		output: 2,
		cacheRead: cache.cacheRead ?? 0,
		cacheWrite: cache.cacheWrite ?? 0,
		...(cache.cttl ? { cttl: cache.cttl } : {}),
		totalTokens: input + 2 + (cache.cacheRead ?? 0) + (cache.cacheWrite ?? 0),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function reply(target: Model, replyUsage: Usage, timestamp = Date.now()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		api: target.api,
		provider: target.provider,
		model: target.id,
		usage: replyUsage,
		stopReason: "stop",
		timestamp,
	};
}

/** What a test session looks like when its probe schedule starts. */
interface ProbeScene {
	settings?: Record<string, unknown>;
	/** Messages the agent appended after its last request, such as that request's tool results. */
	after?: Message[];
	/** How long before the probe schedule starts the agent's last request was sent. */
	replyAgeMs?: number;
	/** Runs once the session exists, before the schedule starts: arms the request shape and changes it. */
	prepare?: (session: AgentSession) => void;
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve();
}

describe("completion probe and the agent's prompt cache", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	/** Declares a five-minute and a one-hour lifetime (the bundled Anthropic catalog). */
	let declared: Model;
	/** An Anthropic Messages gateway that declares no lifetime and names the tier it wrote in each response. */
	let gateway: Model;
	/** An OpenAI Responses gateway: no declared lifetime, and responses name no tier. */
	let responsesGateway: Model;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
		const anthropic = modelRegistry
			.getAll()
			.find(model => model.provider === "anthropic" && model.promptCache?.short);
		if (!anthropic) throw new Error("Expected a bundled Anthropic model that declares a prompt-cache lifetime");
		declared = anthropic;
		modelRegistry.registerProvider("cache-life-gateway", {
			api: "anthropic-messages",
			apiKey: NO_AUTH_SENTINEL,
			baseUrl: "https://gateway.example.test",
			compat: { supportsLongCacheRetention: true },
			models: [
				{
					id: "claude-gateway",
					name: "Claude Gateway",
					api: "anthropic-messages",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 64_000,
				},
			],
		});
		modelRegistry.registerProvider("cache-life-responses", {
			api: "openai-responses",
			apiKey: NO_AUTH_SENTINEL,
			baseUrl: "https://gateway.example.test/v1",
			models: [
				{
					id: "gpt-gateway",
					name: "GPT Gateway",
					api: "openai-responses",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 64_000,
				},
			],
		});
		const gatewayModel = modelRegistry.find("cache-life-gateway", "claude-gateway");
		const responsesModel = modelRegistry.find("cache-life-responses", "gpt-gateway");
		if (!gatewayModel || !responsesModel) throw new Error("Expected the runtime gateway models to register");
		expect(gatewayModel.promptCache).toBeUndefined();
		expect(responsesModel.promptCache).toBeUndefined();
		gateway = gatewayModel;
		responsesGateway = responsesModel;
	});

	afterAll(() => authStorage.close());
	afterEach(() => vi.useRealTimers());

	/**
	 * Starts a probe on a streaming session whose last request is `lastReply`, then advances the clock to each
	 * of `atMinutes` (minutes after the schedule starts) and returns how many probes had been sent by then.
	 */
	async function probesSent(
		target: Model,
		lastReply: Usage,
		atMinutes: number[],
		scene: ProbeScene = {},
	): Promise<number[]> {
		using tempDir = TempDir.createSync("@omp-completion-probe-cache-life-");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.mkdir(agentDir, { recursive: true });
		vi.useFakeTimers();
		const sessionManager = SessionManager.create(tempDir.path(), agentDir);
		sessionManager.appendMessage({ role: "user", content: "Do the task", timestamp: Date.now() });
		sessionManager.appendMessage(reply(target, lastReply, Date.now() - (scene.replyAgeMs ?? 0)));
		for (const message of scene.after ?? []) sessionManager.appendMessage(message);
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: target,
					systemPrompt: ["Test"],
					tools: [],
					messages: sessionManager.buildSessionContext().messages,
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, ...scene.settings }),
			modelRegistry,
		});
		scene.prepare?.(session);
		session.agent.state.isStreaming = true;
		const probe = vi.spyOn(session, "runEphemeralTurn").mockResolvedValue({
			replyText: '{"pct": 40, "stage": "reading"}',
			assistantMessage: reply(target, usage({})),
		});
		const controller = new AbortController();
		const counts: number[] = [];
		try {
			startCompletionProbe({ session: () => session, signal: controller.signal, onEstimate: () => {} });
			let now = 0;
			for (const minute of atMinutes) {
				vi.advanceTimersByTime((minute - now) * MINUTE);
				now = minute;
				await flushMicrotasks();
				counts.push(probe.mock.calls.length);
			}
		} finally {
			controller.abort();
			session.agent.state.isStreaming = false;
			await session.dispose();
		}
		return counts;
	}

	const long = { settings: { "providers.cacheRetention": "long" } };

	it("sends no probe once the agent's cache entry has outlived its declared lifetime", async () => {
		// A probe past the entry's life wrote the whole context again for one line of progress.
		const counts = await probesSent(declared, usage({ cacheWrite: 40_000, cttl: { ephemeral5m: 40_000 } }), [2, 7]);
		expect(counts).toEqual([1, 1]);
	});

	it("sends no probe when the agent's provider reported no cache use", async () => {
		// A provider that keeps no cache bills a probe's whole prompt as input every time.
		const counts = await probesSent(declared, usage({}), [2]);
		expect(counts).toEqual([0]);
	});

	it("sends no probe when no lifetime of the agent's cache can be shown", async () => {
		// The route caches (the reply read its cache), but no catalog entry and no response names how long.
		const counts = await probesSent(responsesGateway, usage({ cacheRead: 40_000 }), [2]);
		expect(counts).toEqual([0]);
	});

	it("probes inside the lifetime the provider named for the entry it wrote, and not after it", async () => {
		// Delays run 2, 5, 10, 30 and 60 minutes, so probes fall at 2, 7, 17, 47 and 107 minutes.
		const counts = await probesSent(
			gateway,
			usage({ cacheRead: 39_000, cacheWrite: 1_000, cttl: { ephemeral1h: 1_000 } }),
			[2, 7, 17, 47, 107],
			long,
		);
		expect(counts).toEqual([1, 2, 3, 4, 4]);
	});

	it("probes only inside the shorter lifetime when a response wrote entries of both lifetimes", async () => {
		// The cached prefix lives only as long as its shortest part: after 5 minutes the 5-minute part is gone.
		const counts = await probesSent(
			gateway,
			usage({ cacheRead: 39_000, cacheWrite: 1_000, cttl: { ephemeral5m: 900, ephemeral1h: 100 } }),
			[2, 7],
			long,
		);
		expect(counts).toEqual([1, 1]);
	});

	it("takes the shorter lifetime the provider named over the model's declared one", async () => {
		// The model declares an hour for the tier it asked for, but the response wrote part of its prefix for 5 minutes.
		const counts = await probesSent(
			declared,
			usage({ cacheRead: 39_000, cacheWrite: 1_000, cttl: { ephemeral5m: 900, ephemeral1h: 100 } }),
			[2, 7],
			long,
		);
		expect(counts).toEqual([1, 1]);
	});

	it("sends no probe when the agent's own request left most of its prompt uncached", async () => {
		// A route can cache only a fixed head (the Claude Code identity block with caching off): the reply
		// reports a read, but the conversation after it is billed as input, and a probe would pay for it again.
		const counts = await probesSent(
			gateway,
			usage({ input: 30_000, cacheRead: 7_000, cacheWrite: 30, cttl: { ephemeral1h: 30 } }),
			[2],
			long,
		);
		expect(counts).toEqual([0]);
	});

	it("sends no probe when a large tool result after the agent's last request is not in the cache", async () => {
		// The agent's request cached its whole prompt, but the probe also sends the tool result that came back
		// after it: under 95% of the probe's prompt would be cache reads.
		const after: Message[] = [
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: LARGE_TOOL_OUTPUT }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const cached = usage({ cacheRead: 39_000, cacheWrite: 1_000, cttl: { ephemeral1h: 1_000 } });
		expect(await probesSent(gateway, cached, [2], { ...long, after })).toEqual([0]);
		// Control: the same session without the tool result probes.
		expect(await probesSent(gateway, cached, [2], long)).toEqual([1]);
	});

	it.each([
		{ name: "nothing", change: () => {}, probes: [1] },
		{ name: "its tools", change: (session: AgentSession) => session.agent.setTools([LOOKUP_TOOL]), probes: [0] },
		{
			name: "its thinking level",
			before: (session: AgentSession) => session.setThinkingLevel(ThinkingLevel.Low),
			change: (session: AgentSession) => {
				session.setThinkingLevel(ThinkingLevel.High);
				expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			},
			probes: [0],
		},
	])("after the agent's last request, a change of $name gives probes $probes", async ({ before, change, probes }) => {
		// Tools and thinking settings come before the messages in the request, so a probe after a change reads a
		// prefix nobody cached.
		const counts = await probesSent(declared, usage({ cacheWrite: 40_000, cttl: { ephemeral5m: 40_000 } }), [2], {
			prepare: session => {
				before?.(session);
				session.startCacheWarming(declared, { messages: [] }, {});
				change(session);
			},
		});
		expect(counts).toEqual([...probes]);
	});

	it.each([
		{ beforeEnd: 31, probes: [1] },
		{ beforeEnd: 29, probes: [0] },
	])("a probe due $beforeEnd s before the entry ends gives probes $probes", async ({ beforeEnd, probes }) => {
		// A probe still waits for its provider slot and builds its request after the check: none goes out in the
		// last 30 seconds of the entry's life. The first probe falls 2 minutes after the schedule starts.
		const replyAgeMs = 5 * MINUTE - beforeEnd * 1_000 - 2 * MINUTE;
		const cached = usage({ cacheWrite: 40_000, cttl: { ephemeral5m: 40_000 } });
		expect(await probesSent(declared, cached, [2], { replyAgeMs })).toEqual([...probes]);
	});
});
