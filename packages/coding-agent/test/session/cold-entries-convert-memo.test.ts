/**
 * Bodies of the turns a running session sent to the model leave memory once a
 * compaction moves the cut past them. The turns were converted for the model
 * while they were in the context; once they lie before the cut their entries are
 * cold, and nothing the session keeps for the next request may still hold their
 * bodies, or a long session's memory grows with every compacted turn.
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
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

/** Larger than any value a cold entry keeps in memory. */
function large(label: string): string {
	return `${label} ${"payload ".repeat(4000)}`;
}

/** A resumed session compacted three times: `c3` keeps from `u4`. */
function sessionText(cwd: string): string {
	const lines: object[] = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: path.basename(cwd), timestamp: TIMESTAMP, cwd },
	];
	const add = (type: string, id: string, parentId: string | null, fields: object) =>
		lines.push({ type, id, parentId, timestamp: TIMESTAMP, ...fields });
	const user = (id: string, parentId: string) =>
		add("message", id, parentId, {
			message: { role: "user", content: [{ type: "text", text: text(id) }], timestamp: 1 },
		});
	const assistant = (id: string, parentId: string) =>
		add("message", id, parentId, {
			message: {
				role: "assistant",
				content: [{ type: "text", text: text(id) }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
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
	user("u3", "c2");
	assistant("a3", "u3");
	compaction("c3", "a3", "u3");
	user("u4", "c3");
	assistant("a4", "u4");
	return lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

/** A tool whose result is a body. */
function probeTool(): AgentTool {
	const schema = type({ value: "string" });
	const tool: AgentTool<typeof schema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Echo a value",
		parameters: schema,
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: large(`result ${params.value}`) }], details: params };
		},
	};
	return tool as AgentTool;
}

interface BodyRef {
	label: string;
	ref: WeakRef<object>;
}

/** Weak references to each message's `content` and its blocks, read while the entries are whole. */
function refsToBodies(entries: readonly SessionEntry[]): BodyRef[] {
	const refs: BodyRef[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || !("content" in entry.message)) continue;
		const content: unknown = entry.message.content;
		if (!Array.isArray(content)) continue;
		const label = `${entry.message.role} ${entry.id}`;
		refs.push({ label: `${label}.content`, ref: new WeakRef(content) });
		content.forEach((block: object, index) => {
			refs.push({ label: `${label}.content[${index}]`, ref: new WeakRef(block) });
		});
	}
	return refs;
}

/**
 * Full collections, each in a later task than the last read, until `done`
 * holds or `rounds` pass: a `WeakRef` keeps its target alive until the task
 * that made or read it ends, and `Bun.sleep(0)` ends the task without waiting
 * for a clock.
 */
async function collectGarbage(done: () => boolean, rounds = 20): Promise<void> {
	for (let round = 0; round < rounds && !done(); round++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
	await Bun.sleep(0);
}

function alive(refs: readonly BodyRef[]): string[] {
	return refs.filter(({ ref }) => ref.deref() !== undefined).map(({ label }) => label);
}

describe("bodies of compacted live turns", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	// A user whose long session compacts keeps every prompt and tool output it ever sent in
	// memory: the process grows with the session's age although the entries went to the store.
	it("releases the prompts and tool results a compaction moves before the cut, once the next turn ran", async () => {
		const dir = TempDir.createSync("@omp-cold-convert-memo-");
		cleanups.push(() => dir.removeSync());
		const file = path.join(dir.path(), "sessions", "session.jsonl");
		await Bun.write(file, sessionText(dir.path()));
		const manager = await SessionManager.open(file, path.dirname(file), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		cleanups.push(() => manager.close());

		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const responses: MockResponse[] = [];
		for (let turn = 0; turn < 3; turn++) {
			responses.push({ content: [{ type: "toolCall", name: "probe", arguments: { value: `turn ${turn}` } }] });
			responses.push({ content: [`turn ${turn} done`], stopReason: "stop" });
		}
		responses.push({ content: ["after the compaction"], stopReason: "stop" });
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
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
		session.subscribe(() => {});
		cleanups.push(() => session.dispose());

		const resumed = new Set(manager.getEntries().map(entry => entry.id));
		for (let turn = 0; turn < 3; turn++) {
			await session.prompt(large(`prompt ${turn}`));
			await session.waitForIdle();
		}
		const turns = manager.getEntries().filter(entry => !resumed.has(entry.id) && entry.type === "message");
		const lastPrompt = turns.findLast(entry => entry.type === "message" && entry.message.role === "user");
		if (!lastPrompt) throw new Error("The turns appended no prompt");
		const compacted = turns.slice(0, turns.indexOf(lastPrompt));
		const refs = refsToBodies(compacted);
		expect(refs.length).toBeGreaterThan(8);

		// The compaction keeps from the last prompt; the session rebuilds its context from it, as after any
		// compaction, and runs one more turn.
		manager.appendCompaction("summary of the earlier turns", undefined, lastPrompt.id, 5000);
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
		expect(compacted.map(isColdEntry)).toEqual(compacted.map(() => true));
		await session.prompt("next");
		await session.waitForIdle();
		// The model's recorded requests hold the bodies they sent; a provider keeps none.
		mock.reset();

		await collectGarbage(() => alive(refs).length === 0);
		expect(alive(refs)).toEqual([]);
	});
});
