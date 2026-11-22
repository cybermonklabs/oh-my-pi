/**
 * Resumes a session from the transcript of a prefix-bound first turn, disposes it before its first
 * request, collects from fresh event-loop turns, and prints whether the reply it restored was collected.
 * With `held`, the probe keeps the reply itself: the control, which must not be collected.
 *
 * Run it in a process of its own with `BUN_JSC_useConcurrentJIT=0`: in a process that has warmed the
 * session code, an optimizing-JIT plan on a background thread can keep the reply reachable.
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
	throw new Error("usage: restored-reply-release-probe <dropped|held>");
}

function createPrefixBindingModel(): Model<"anthropic-messages"> {
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

/** The session prefix-binding-tool-roster.test.ts builds, for one model and transcript. */
function newSession(sessionManager: SessionManager): AgentSession {
	const read = createTool("read");
	const bash = createTool("bash");
	const toolRegistry = new Map<string, AgentTool>([
		[read.name, read],
		[bash.name, bash],
	]);
	const mock = createMockModel({ responses: [{ content: ["ok"] }, { content: ["ok"] }] });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: createPrefixBindingModel(),
			systemPrompt: ["initial"],
			tools: [read],
			// A resumed session restores the transcript before it is constructed (sdk.ts).
			messages: sessionManager.buildSessionContext().messages,
		},
		convertToLlm,
		streamFn: async (requestModel, context, streamOptions) => mock.stream(requestModel, context, streamOptions),
	});
	return new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key" } as never,
		toolRegistry,
		builtInToolNames: ["read", "bash"],
		rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
	});
}

let held: object | undefined;

/** Kept out of the top level so no strong local binding outlives the capture. */
function weakRefToRestoredReply(session: AgentSession): WeakRef<object> {
	const reply = session.agent.state.messages.findLast(message => message.role === "assistant");
	if (!reply) throw new Error("resumed session restored no reply");
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

let transcriptEntries = 0;

async function resumeAndDispose(sessionManager: SessionManager): Promise<WeakRef<object>> {
	// The transcript of a process that sent its first turn with read and bash active.
	const live = newSession(sessionManager);
	await live.setActiveToolPresentation(["read", "bash"], []);
	await live.prompt("first");
	transcriptEntries = sessionManager.getEntries().length;
	const resumed = newSession(sessionManager);
	const reply = weakRefToRestoredReply(resumed);
	await live.dispose();
	await resumed.dispose();
	return reply;
}

// The transcript's manager stays reachable while the probe collects, as it does in the test it serves.
const transcript = SessionManager.inMemory();
const reply = await resumeAndDispose(transcript);
await collect();
process.stdout.write(
	JSON.stringify({ collected: reply.deref() === undefined, held: held !== undefined, transcriptEntries }),
);
