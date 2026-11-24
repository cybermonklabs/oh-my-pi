/**
 * Child process for test/agent-session-prompt-cache-arm-release.test.ts. Runs one turn, records its request as the
 * newest main request (`startCacheWarming`, as the session's stream function does for every main request), disposes
 * the session while the probe still holds the disposed session itself, collects from fresh event-loop turns, and
 * prints whether the turn's reply was collected. With `held`, the probe keeps the reply too: the control, which must
 * not be collected.
 *
 * Run it in a process of its own with `BUN_JSC_useConcurrentJIT=0`: in a process that has warmed the session code,
 * an optimizing-JIT plan on a background thread can keep the reply reachable.
 */
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const reference = process.argv[2];
if (reference !== "dropped" && reference !== "held") {
	throw new Error("usage: prompt-cache-arm-release-probe <dropped|held>");
}

function createModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-fable-5-1",
		name: "Claude Fable 5.1",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function newSession(): AgentSession {
	const read = createTool("read");
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: createModel(), systemPrompt: ["initial"], tools: [read], messages: [] },
		convertToLlm,
		streamFn: async (requestModel, context, streamOptions) => mock.stream(requestModel, context, streamOptions),
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry: new Map<string, AgentTool>([[read.name, read]]),
		builtInToolNames: ["read"],
		rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
	});
}

let held: object | undefined;
/** The disposed session, held for the whole probe: what it still holds after dispose stays reachable. */
let disposed: AgentSession | undefined;

/** Kept out of the top level so no strong local binding outlives the capture. */
function weakRefToReply(session: AgentSession): WeakRef<object> {
	const reply = session.agent.state.messages.findLast(message => message.role === "assistant");
	if (!reply) throw new Error("the turn produced no reply");
	if (reference === "held") held = reply;
	return new WeakRef(reply);
}

async function collect(): Promise<void> {
	for (let pass = 0; pass < 3; pass++) {
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		Bun.gc(true);
	}
}

async function runAndDispose(): Promise<WeakRef<object>> {
	const session = newSession();
	await session.prompt("first");
	const model = session.model;
	if (!model) throw new Error("the session has no model");
	// The session's stream function records every main request this way; the mock stream function does not.
	session.startCacheWarming(model, { messages: [] }, {});
	const reply = weakRefToReply(session);
	await session.dispose();
	disposed = session;
	return reply;
}

const reply = await runAndDispose();
await collect();
process.stdout.write(
	JSON.stringify({
		collected: reply.deref() === undefined,
		held: held !== undefined,
		disposed: disposed !== undefined,
	}),
);
