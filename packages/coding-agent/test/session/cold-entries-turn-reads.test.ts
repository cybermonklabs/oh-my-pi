/**
 * The turns of a resumed long session read no older body: what every turn
 * reads of the whole branch stays in memory on a cold entry, for the values
 * real providers write, and the passes that run at the end of every turn read
 * no body before the cut, whatever the latest compaction kept.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "../../../agent/src/index";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Older tool rounds before the cut: more than the eight records a store keeps parsed. */
const OLDER_ROUNDS = 12;

function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

function usage() {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * The id an OpenAI Responses or Codex reply gives a tool call: its `call_id`
 * and the item id, as pi-ai joins them (`call_id|item_id`, 81 characters), in
 * the shapes the OpenAI API returns (`call_` and 24 characters, `fc_` and 48
 * hexadecimal digits).
 */
function responsesToolCallId(round: number): string {
	const suffix = String(round).padStart(4, "0");
	return `call_aGiFQkRWSWAIsMQ19fKq${suffix}|fc_6890e975e86c819c9338825b3e1994810694874912ae${suffix}`;
}

interface SessionShape {
	/** The tool call id of each older round. */
	callId: (round: number) => string;
	/** The model id the older replies record. */
	model?: string;
	/** The latest compaction keeps no entry, as an Anthropic native compaction that summarizes all does. */
	latestKeepsNothing?: boolean;
}

/**
 * A resumed session compacted three times. Between `c2` and `c3` lie
 * {@link OLDER_ROUNDS} rounds, each a prompt, a `probe` call, its start marker
 * and its result; `c3` keeps from `u6`, the cut, or nothing.
 */
function sessionText(cwd: string, shape: SessionShape): string {
	const lines: object[] = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: path.basename(cwd), timestamp: TIMESTAMP, cwd },
	];
	const add = (type: string, id: string, parentId: string | null, fields: object) =>
		lines.push({ type, id, parentId, timestamp: TIMESTAMP, ...fields });
	const user = (id: string, parentId: string) =>
		add("message", id, parentId, {
			message: { role: "user", content: [{ type: "text", text: text(id) }], attribution: "user", timestamp: 1 },
		});
	const assistant = (id: string, parentId: string, toolCall?: { id: string; name: string; arguments: object }) =>
		add("message", id, parentId, {
			message: {
				role: "assistant",
				content: [{ type: "text", text: text(id) }, ...(toolCall ? [{ type: "toolCall", ...toolCall }] : [])],
				api: "anthropic-messages",
				provider: "anthropic",
				model: shape.model ?? "claude-sonnet-4-5",
				usage: usage(),
				stopReason: toolCall ? "toolUse" : "stop",
				timestamp: 2,
			},
		});
	const compaction = (id: string, parentId: string, firstKeptEntryId: string) =>
		add("compaction", id, parentId, { summary: text(id), firstKeptEntryId, tokensBefore: 1000 });

	add("session_init", "s0", null, { systemPrompt: ["Test"], task: "Refactor the module tree", tools: ["probe"] });
	user("u1", "s0");
	assistant("a1", "u1");
	compaction("c1", "a1", "u1");
	user("u2", "c1");
	assistant("a2", "u2");
	compaction("c2", "a2", "u2");
	let last = "c2";
	for (let round = 1; round <= OLDER_ROUNDS; round++) {
		const callId = shape.callId(round);
		user(`hu${round}`, last);
		assistant(`ha${round}`, `hu${round}`, { id: callId, name: "probe", arguments: { value: `round ${round}` } });
		add("custom", `hx${round}`, `ha${round}`, {
			customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
			data: { toolCallId: callId, toolName: "probe", startedAt: TIMESTAMP },
		});
		add("message", `hr${round}`, `hx${round}`, {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "probe",
				content: [{ type: "text", text: text(`hr${round}`) }],
				details: { value: `round ${round}` },
				isError: false,
				timestamp: 3,
			},
		});
		last = `hr${round}`;
	}
	user("u6", last);
	assistant("a6", "u6");
	compaction("c3", "a6", shape.latestKeepsNothing ? "" : "u6");
	user("u7", "c3");
	assistant("a7", "u7");
	return lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

function probeTool(): AgentTool {
	const schema = type({ value: "string" });
	const tool: AgentTool<typeof schema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Echo a value",
		parameters: schema,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	return tool as AgentTool;
}

describe("the turns of a resumed long session read no older body", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	/**
	 * Resume the session and run six turns, each a `probe` call and a reply;
	 * the records read back from the store on each turn after the first.
	 */
	async function readsPerTurn(shape: SessionShape, settings: Record<string, unknown>): Promise<number[]> {
		const dir = TempDir.createSync("@omp-cold-turn-reads-");
		cleanups.push(() => dir.removeSync());
		const file = path.join(dir.path(), "sessions", "session.jsonl");
		await Bun.write(file, sessionText(dir.path(), shape));
		const manager = await SessionManager.open(file, path.dirname(file), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		cleanups.push(() => manager.close());
		expect(manager.coldStoreStats().coldEntries).toBeGreaterThan(OLDER_ROUNDS * 3);

		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const turns = 6;
		const responses: MockResponse[] = [];
		for (let turn = 0; turn < turns; turn++) {
			responses.push({ content: [{ type: "toolCall", name: "probe", arguments: { value: `turn ${turn}` } }] });
			responses.push({ content: [`turn ${turn} done`], stopReason: "stop" });
		}
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [probeTool()],
				messages: manager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "retry.enabled": false, ...settings }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});
		cleanups.push(() => session.dispose());

		await session.prompt("turn 0");
		await session.waitForIdle();
		const reads: number[] = [];
		for (let turn = 1; turn < turns; turn++) {
			const before = manager.coldStoreStats().materializations;
			await session.prompt(`turn ${turn}`);
			await session.waitForIdle();
			reads.push(manager.coldStoreStats().materializations - before);
		}
		return reads;
	}

	// An OpenAI Responses or Codex session reads every older tool result back from disk on each tool
	// call, so its turns slow down as it ages; the same session with short ids reads none.
	it("reads no older body on a turn of a session whose tool call ids an OpenAI Responses reply gave", async () => {
		expect(responsesToolCallId(1)).toHaveLength(81);
		expect(await readsPerTurn({ callId: round => `call_h${round}` }, { "compaction.enabled": false })).toEqual([
			0, 0, 0, 0, 0,
		]);
		expect(await readsPerTurn({ callId: responsesToolCallId }, { "compaction.enabled": false })).toEqual([
			0, 0, 0, 0, 0,
		]);
	});

	// A session on a model whose id is long (a Bedrock application inference profile ARN) reads every
	// older reply back from disk on each tool call.
	it("reads no older body on a turn of a session whose replies record a model id longer than 64 characters", async () => {
		const model = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6";
		expect(model.length).toBeGreaterThan(64);
		expect(await readsPerTurn({ callId: round => `call_h${round}`, model }, { "compaction.enabled": false })).toEqual(
			[0, 0, 0, 0, 0],
		);
	});

	// After a compaction that kept no entry, each turn's prune passes read every older reply back from
	// disk, so the turns of a long session slow down with its age; after one that kept an entry they read none.
	it("reads no older body on a turn after a compaction that kept no entry, with compaction on", async () => {
		const settings = { "compaction.enabled": true };
		expect(await readsPerTurn({ callId: round => `call_h${round}` }, settings)).toEqual([0, 0, 0, 0, 0]);
		expect(await readsPerTurn({ callId: round => `call_h${round}`, latestKeepsNothing: true }, settings)).toEqual([
			0, 0, 0, 0, 0,
		]);
	});
});
