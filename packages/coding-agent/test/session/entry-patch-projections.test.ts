/**
 * The readers of a session file that project its entries without loading the
 * session: each must show what an `entry_patch` record sets, as it shows the
 * same field written inline on the entry's own line (what a full rewrite of the
 * file leaves). Each case reads a transcript holding the original line and a
 * record, and the same transcript with the field written inline, through one
 * reader.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AgentActivityIndex } from "../../src/activity";
import { applyStrip, planStrip } from "@oh-my-pi/pi-coding-agent/cli/gc-strip";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildStage1RolloutItems } from "@oh-my-pi/pi-coding-agent/memories";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { AgentHubRemote } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { type AgentTranscriptSource, AgentTranscriptViewer } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** What an elide pass leaves in place of heavy content. */
const PLACEHOLDER = "ELIDEDMARK placeholder";
/** The heavy content an elide pass removes. */
const HEAVY = `HEAVYMARK ${"heavy output ".repeat(16)}`;
const AGENT_ID = "Worker";

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
		...overrides,
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function bashResult(toolCallId: string, text: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: 3,
	};
}

function header(id: string) {
	return { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd: "/tmp" };
}

function message(id: string, parentId: string | null, body: object) {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message: body };
}

function patchRecord(id: string, parentId: string, patches: object[]) {
	return { type: "custom", customType: "entry_patch", id, parentId, timestamp: TIMESTAMP, data: { patches } };
}

function jsonl(entries: readonly object[]): string {
	return entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
}

async function writeTranscript(file: string, entries: readonly object[]): Promise<string> {
	await Bun.write(file, jsonl(entries));
	return file;
}

function textOf(message: AgentMessage | undefined): string {
	if (message?.role !== "assistant") return "";
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function thinkingSignatureOf(message: AgentMessage | undefined): unknown {
	if (message?.role !== "assistant") return undefined;
	const thinking = message.content.find(block => block.type === "thinking");
	return thinking?.type === "thinking" ? thinking.thinkingSignature : undefined;
}

describe("entry patch records and the readers that project a session file", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Memory extraction sends a rollout to a model on every extraction: without the
	// record it sends the heavy content the elide pass removed, every time.
	it("sends the memory extraction model an elided tool result as its placeholder, as a rollout with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const call = assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -R" } }], {
			stopReason: "toolUse",
		});
		// Over a 1 MiB read window, so the record lies in a later window than its target.
		const filler = Array.from({ length: 4 }, (_, n) =>
			message(`f${n}`, n === 0 ? "t1" : `f${n - 1}`, user(`${n}${"x".repeat(300_000)}`)),
		);
		const before = [header("memory"), message("u1", null, user("list the files")), message("a1", "u1", call)];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			...before,
			message("t1", "a1", bashResult("call_1", HEAVY)),
			...filler,
			patchRecord("p1", "f3", [
				{ entryId: "t1", message: { content: [{ type: "text", text: PLACEHOLDER }], prunedAt: 5 } },
			]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			...before,
			message("t1", "a1", { ...bashResult("call_1", PLACEHOLDER), prunedAt: 5 }),
			...filler,
		]);
		const storage = new FileSessionStorage();
		const read = async (file: string, limit: number) => {
			const items = await buildStage1RolloutItems(file, limit, storage);
			return { heavy: items.includes("HEAVYMARK"), placeholder: items.includes(PLACEHOLDER), items };
		};
		for (const limit of [1_000, 10_000_000]) {
			const fromPatched = await read(patched, limit);
			const fromInline = await read(inline, limit);
			expect({ limit, heavy: fromPatched.heavy, placeholder: fromPatched.placeholder }).toEqual({
				limit,
				heavy: false,
				placeholder: true,
			});
			expect(fromPatched.items).toBe(fromInline.items);
		}
	});

	// Past its head budget, memory extraction reads the newest messages from the back of a rollout
	// file, window by window: without the records there, it sends the heavy content of a tool result
	// in the rollout's tail.
	it("sends the memory extraction model an elided tool result in the rollout's tail as its placeholder, as a rollout with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const call = assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -R" } }], {
			stopReason: "toolUse",
		});
		// A first prompt past the head budget: the head ends on it, and the tool result lies in the tail.
		const rollout = (result: string, withRecord: boolean) => [
			header("memory-tail"),
			message("u1", null, user(`list the files ${"y".repeat(10_000)}`)),
			message("a1", "u1", call),
			message("t1", "a1", bashResult("call_1", result)),
			message("u2", "t1", user("ok")),
			...(withRecord
				? [
						patchRecord("p1", "u2", [
							{ entryId: "t1", message: { content: [{ type: "text", text: PLACEHOLDER }] } },
						]),
					]
				: []),
		];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), rollout(HEAVY, true));
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), rollout(PLACEHOLDER, false));
		const storage = new FileSessionStorage();
		const fromPatched = await buildStage1RolloutItems(patched, 1_000, storage);
		const fromInline = await buildStage1RolloutItems(inline, 1_000, storage);
		// The tail is what the back windows read: the head ends inside the first prompt.
		expect(fromInline).toContain("...[truncated]...");
		expect({ heavy: fromPatched.includes("HEAVYMARK"), placeholder: fromPatched.includes(PLACEHOLDER) }).toEqual({
			heavy: false,
			placeholder: true,
		});
		expect(fromPatched).toBe(fromInline);
	});

	// The picker previews and searches the first prompt: without the record it
	// shows the text an elide pass replaced, which a rewrite of the file would not.
	it("previews and searches a prompt an elide pass shortened as its placeholder, as a session with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		// Past the 4 KiB prefix the picker reads: the record lies only in its tail window.
		const replies = Array.from({ length: 3 }, (_, n) =>
			message(
				`a${n}`,
				n === 0 ? "u1" : `a${n - 1}`,
				assistant([{ type: "text", text: `reply ${n} ${"r".repeat(2_000)}` }]),
			),
		);
		const patchedDir = path.join(dir.path(), "patched");
		const inlineDir = path.join(dir.path(), "inline");
		await writeTranscript(path.join(patchedDir, "session.jsonl"), [
			header("picker-patched"),
			message("u1", null, user(HEAVY)),
			...replies,
			patchRecord("p1", "a2", [{ entryId: "u1", message: { content: PLACEHOLDER } }]),
		]);
		await writeTranscript(path.join(inlineDir, "session.jsonl"), [
			header("picker-inline"),
			message("u1", null, user(PLACEHOLDER)),
			...replies,
		]);
		const storage = new FileSessionStorage();
		const [fromPatched] = await listSessions(patchedDir, storage);
		const [fromInline] = await listSessions(inlineDir, storage);
		const shown = (info: typeof fromPatched) => ({
			firstMessage: info?.firstMessage,
			searchHasHeavy: info?.allMessagesText.includes("HEAVYMARK"),
		});
		expect(shown(fromPatched)).toEqual({ firstMessage: PLACEHOLDER, searchHasHeavy: false });
		expect(shown(fromPatched)).toEqual(shown(fromInline));
	});

	// The picker marks a session by its last turn: a turn that ends in tool calls it never ran was
	// cut off. Without the record it reads the tool call the record took out of that turn and lists a
	// finished session as interrupted.
	it("lists the status of a last turn a record changed, as a session with the change inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const call = assistant([{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }]);
		const patchedDir = path.join(dir.path(), "patched");
		const inlineDir = path.join(dir.path(), "inline");
		await writeTranscript(path.join(patchedDir, "session.jsonl"), [
			header("status-patched"),
			message("u1", null, user("go")),
			message("a1", "u1", call),
			patchRecord("p1", "a1", [{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } }]),
		]);
		await writeTranscript(path.join(inlineDir, "session.jsonl"), [
			header("status-inline"),
			message("u1", null, user("go")),
			message("a1", "u1", assistant([{ type: "text", text: PLACEHOLDER }])),
		]);
		const storage = new FileSessionStorage();
		const [fromPatched] = await listSessions(patchedDir, storage);
		const [fromInline] = await listSessions(inlineDir, storage);
		expect(fromPatched?.status).toBe("complete");
		expect(fromPatched?.status).toBe(fromInline?.status);
	});

	// A first prompt behind a large leading entry is found only by the picker's line scan. Without
	// the records it read, or those of its tail window, the picker previews and searches the text an
	// elide pass replaced.
	it("previews a prompt only the line scan finds as the placeholder a record set, as a session with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		// Past the 4 KiB prefix the picker reads, so the prompt is not in it.
		const pad = {
			type: "custom",
			customType: "pad",
			id: "pad",
			parentId: null,
			timestamp: TIMESTAMP,
			data: "p".repeat(8_192),
		};
		// Past the 32 KiB tail window, and no turn: the window holds no record, so the scan reads on to the reply.
		const filler = Array.from({ length: 5 }, (_, n) => ({
			type: "custom",
			customType: "pad",
			id: `filler${n}`,
			parentId: n === 0 ? "a1" : `filler${n - 1}`,
			timestamp: TIMESTAMP,
			data: "f".repeat(8_192),
		}));
		const record = patchRecord("p1", "u1", [{ entryId: "u1", message: { content: PLACEHOLDER } }]);
		const reply = message("a1", "u1", assistant([{ type: "text", text: "done" }]));
		const layouts = {
			// The record is in the tail window, after the reply the scan stops at.
			"in the tail window": (prompt: string, withRecord: boolean) => [
				header("scan"),
				pad,
				message("u1", null, user(prompt)),
				reply,
				...(withRecord ? [record] : []),
			],
			// The record is between the prompt and the reply, which the scan reads on to.
			"among the lines the scan reads": (prompt: string, withRecord: boolean) => [
				header("scan"),
				pad,
				message("u1", null, user(prompt)),
				...(withRecord ? [record] : []),
				reply,
				...filler,
			],
		};
		const storage = new FileSessionStorage();
		for (const [where, layout] of Object.entries(layouts)) {
			const shown = async (name: string, prompt: string, withRecord: boolean) => {
				const sessionDir = path.join(dir.path(), name);
				await writeTranscript(path.join(sessionDir, "session.jsonl"), layout(prompt, withRecord));
				const [info] = await listSessions(sessionDir, storage);
				return {
					where,
					firstMessage: info?.firstMessage,
					searchHasHeavy: info?.allMessagesText.includes("HEAVYMARK"),
				};
			};
			const fromPatched = await shown(`${where}-patched`, HEAVY, true);
			expect(fromPatched).toEqual({ where, firstMessage: PLACEHOLDER, searchHasHeavy: false });
			expect(fromPatched).toEqual(await shown(`${where}-inline`, PLACEHOLDER, false));
		}
	});

	// A first prompt longer than the 4 KiB prefix (a pasted fenced block, what an elide pass shortens)
	// lies only partly in the prefix, and the picker's line scan reads it whole. Without the record in
	// the tail window, the picker previews and searches the block as first written. The search covers
	// the file's first 4 KiB as stored, so the reply past the block's line stays out of it.
	it("previews a first prompt longer than the prefix as the placeholder a record in the tail window set, as a session with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		// About 1,100 tokens of fenced log.
		const block = `HEAVYMARK see the log\n\`\`\`\n${"log line 0123456789\n".repeat(220)}\`\`\``;
		expect(Buffer.byteLength(block)).toBeGreaterThan(4_096);
		const reply = message("a1", "u1", assistant([{ type: "text", text: "done" }]));
		const storage = new FileSessionStorage();
		const shown = async (name: string, entries: readonly object[]) => {
			const sessionDir = path.join(dir.path(), name);
			await writeTranscript(path.join(sessionDir, "session.jsonl"), entries);
			const [info] = await listSessions(sessionDir, storage);
			const search = info?.allMessagesText ?? "";
			return {
				firstMessage: info?.firstMessage,
				searchHasPlaceholder: search.includes(PLACEHOLDER),
				searchHasOriginal: search.includes("HEAVYMARK") || search.includes("log line"),
			};
		};
		const fromPatched = await shown("patched", [
			header("long-patched"),
			message("u1", null, user(block)),
			reply,
			patchRecord("p1", "a1", [{ entryId: "u1", message: { content: PLACEHOLDER } }]),
		]);
		expect(fromPatched).toEqual({ firstMessage: PLACEHOLDER, searchHasPlaceholder: true, searchHasOriginal: false });
		expect(fromPatched).toEqual(
			await shown("inline", [header("long-inline"), message("u1", null, user(PLACEHOLDER)), reply]),
		);
	});

	// Agent Activity reads a growing transcript in windows: a record appended after
	// it showed a response must replace the text that response showed.
	it("shows a response an elide pass shortened after it was read as its placeholder, as a transcript with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			message("a1", null, assistant([{ type: "text", text: HEAVY }])),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			message("a1", null, assistant([{ type: "text", text: PLACEHOLDER }])),
		]);
		const patchedActivity = new AgentActivityIndex();
		await patchedActivity.sync(AGENT_ID, patched);
		await Bun.write(
			patched,
			jsonl([
				message("a1", null, assistant([{ type: "text", text: HEAVY }])),
				patchRecord("p1", "a1", [{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } }]),
			]),
		);
		await patchedActivity.sync(AGENT_ID, patched);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const summaries = (activity: AgentActivityIndex) => activity.query().map(row => row.summary);
		expect(summaries(patchedActivity)).toEqual([PLACEHOLDER]);
		expect(summaries(patchedActivity)).toEqual(summaries(inlineActivity));
	});

	// A record can set a turn's content to other tool calls, and give text to a turn that had none.
	// Agent Activity shows a response row for a turn's text and a tool row for each of its tool calls:
	// without the record it keeps the rows of the content the turn was first written with, and shows
	// no row for the text and the tool call the record gave it.
	it("shows the rows of a turn's content a record set after it was read, as a transcript with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const written = assistant(
			[
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: HEAVY } },
				{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "ls" } },
			],
			{ stopReason: "toolUse" },
		);
		const patchedContent = [
			{ type: "text", text: PLACEHOLDER },
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ELIDEDMARK command" } },
			{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "pwd" } },
		];
		const results = [
			message("t1", "a1", bashResult("call_1", "out")),
			message("t2", "t1", bashResult("call_2", "out")),
			message("t3", "t2", bashResult("call_3", "out")),
		];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			message("a1", null, written),
			...results,
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			message("a1", null, { ...written, content: patchedContent }),
			...results,
		]);
		const patchedActivity = new AgentActivityIndex();
		await patchedActivity.sync(AGENT_ID, patched);
		await Bun.write(
			patched,
			jsonl([
				message("a1", null, written),
				...results,
				patchRecord("p1", "t3", [{ entryId: "a1", message: { content: patchedContent } }]),
			]),
		);
		await patchedActivity.sync(AGENT_ID, patched);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const rows = (activity: AgentActivityIndex) =>
			activity.query().map(row => ({ kind: row.kind, title: row.title, summary: row.summary, status: row.status }));
		expect(rows(patchedActivity)).toEqual([
			{ kind: "response", title: "Response", summary: PLACEHOLDER, status: "success" },
			{ kind: "tool", title: "bash", summary: "ELIDEDMARK command", status: "success" },
			{ kind: "tool", title: "bash", summary: "pwd", status: "success" },
		]);
		expect(rows(patchedActivity)).toEqual(rows(inlineActivity));
	});

	// A record can come before the turn it names, as the Agent Hub's history of a parked agent reads it.
	// Agent Activity reads a growing transcript in windows: when the record is in an earlier window than
	// its turn, without holding it until the turn is read it shows the rows of the content the turn was
	// written with.
	it("shows the rows of a turn's content a record read before the turn set, as a transcript with it inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const written = assistant(
			[
				{ type: "text", text: HEAVY },
				{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
			],
			{ stopReason: "toolUse" },
		);
		const patchedContent = [
			{ type: "text", text: PLACEHOLDER },
			{ type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } },
		];
		// A turn the first window shows a row for: a later window of a transcript that showed none is read
		// as if it began mid-line.
		const before = [
			message("u1", null, user("do the task")),
			message("a0", "u1", assistant([{ type: "text", text: "On it" }])),
		];
		const record = patchRecord("p1", "a0", [{ entryId: "a1", message: { content: patchedContent } }]);
		const results = [
			message("t1", "a1", bashResult("call_1", "out")),
			message("t2", "t1", bashResult("call_2", "out")),
		];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [...before, record]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			...before,
			message("a1", "a0", { ...written, content: patchedContent }),
			...results,
		]);
		const patchedActivity = new AgentActivityIndex();
		await patchedActivity.sync(AGENT_ID, patched);
		await Bun.write(patched, jsonl([...before, record, message("a1", "p1", written), ...results]));
		await patchedActivity.sync(AGENT_ID, patched);
		const inlineActivity = new AgentActivityIndex();
		await inlineActivity.sync(AGENT_ID, inline);
		const rows = (activity: AgentActivityIndex) =>
			activity.query().map(row => ({ kind: row.kind, title: row.title, summary: row.summary, status: row.status }));
		expect(rows(patchedActivity)).toEqual([
			{ kind: "response", title: "Response", summary: "On it", status: "success" },
			{ kind: "response", title: "Response", summary: PLACEHOLDER, status: "success" },
			{ kind: "tool", title: "bash", summary: "pwd", status: "success" },
		]);
		expect(rows(patchedActivity)).toEqual(rows(inlineActivity));
	});

	// The Agent Hub's row for a parked agent counts the tool calls of its turns and credits the run
	// to the model of the newest turn that produced output. Without the records it counts a tool call
	// a record took out of a turn, and credits the run to a turn a record, here one written before
	// that turn, left without output.
	it("counts the tool calls and credits the model of turns a record changed, as a transcript with them inline does", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const fallback = { provider: "openai-codex", model: "gpt-5.6-sol" } as const;
		const modelChange = (id: string, parentId: string, model: string, role: string, isFallback: boolean) => ({
			type: "model_change",
			id,
			parentId,
			timestamp: TIMESTAMP,
			model,
			role,
			resolvedModelIsFallback: isFallback,
		});
		const head = [
			header(AGENT_ID),
			modelChange("m1", AGENT_ID, "anthropic/claude-sonnet-4-5", "task", false),
			{ type: "session_init", id: "si", parentId: "m1", timestamp: TIMESTAMP, agent: "task", task: "do the task" },
		];
		const read = { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } } as const;
		const shortened: AssistantMessage["content"] = [{ type: "text", text: PLACEHOLDER }, read];
		const noOutput: AssistantMessage["content"] = [{ type: "text", text: "  " }];
		const history = async (name: string, turns: readonly object[]) => {
			const root = path.join(dir.path(), name);
			await Bun.write(path.join(root, "main.jsonl"), "");
			await writeTranscript(path.join(root, "main", `${AGENT_ID}.jsonl`), [...head, ...turns]);
			const registry = new AgentRegistry();
			await registerPersistedSubagents(registry, path.join(root, "main.jsonl"));
			const summary = registry.get(AGENT_ID)?.history;
			return { tools: summary?.metrics?.tools, resolvedModel: summary?.resolvedModel };
		};
		const fromPatched = await history("patched", [
			message(
				"a1",
				"si",
				assistant([
					{ type: "text", text: HEAVY },
					read,
					{ type: "toolCall", id: "t2", name: "read", arguments: {} },
				]),
			),
			modelChange("m2", "a1", "openai-codex/gpt-5.6-sol", "fallback", true),
			patchRecord("p0", "m2", [{ entryId: "a2", message: { content: noOutput } }]),
			message("a2", "m2", assistant([{ type: "text", text: "partial answer" }], fallback)),
			patchRecord("p1", "a2", [{ entryId: "a1", message: { content: shortened } }]),
		]);
		expect(fromPatched).toEqual({ tools: 1, resolvedModel: "anthropic/claude-sonnet-4-5" });
		expect(fromPatched).toEqual(
			await history("inline", [
				message("a1", "si", assistant(shortened)),
				modelChange("m2", "a1", "openai-codex/gpt-5.6-sol", "fallback", true),
				message("a2", "m2", assistant(noOutput, fallback)),
			]),
		);
	});

	// `omp gc --strip` removes replay data from old turns and keeps it on the latest turn, which a
	// resume replays. A record that sets a turn's content keeps the signature of what it set, and a
	// resume sets that content again: the strip must reach the record of an old turn too, and leave
	// the record of the latest turn as it leaves that turn's line.
	it("strips the replay data of a record's content for an old turn and keeps it for the latest turn, as for the turns written inline", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const LATEST = "latest placeholder";
		const content = (text: string, signature: string): AssistantMessage["content"] => [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: signature },
			{ type: "text", text },
		];
		const signed = (text: string, signature: string) => assistant(content(text, signature));
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			header("strip-patched"),
			message("u1", null, user("go")),
			message("a1", "u1", signed(HEAVY, "sig-old")),
			message("u2", "a1", user("and now")),
			message("a2", "u2", signed(`latest ${HEAVY}`, "sig-latest")),
			patchRecord("p1", "a2", [
				{ entryId: "a1", message: { content: content(PLACEHOLDER, "sig-old") } },
				{ entryId: "a2", message: { content: content(LATEST, "sig-latest") } },
			]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			header("strip-inline"),
			message("u1", null, user("go")),
			message("a1", "u1", signed(PLACEHOLDER, "sig-old")),
			message("u2", "a1", user("and now")),
			message("a2", "u2", signed(LATEST, "sig-latest")),
		]);
		const storage = new FileSessionStorage();
		const turnsAfterStrip = async (file: string) => {
			const plan = await planStrip(file, Date.now() + 60_000);
			if (plan) await applyStrip(plan, storage);
			const messages = await loadSessionMessagesReadOnly(file, storage);
			const turn = (text: string) => {
				const found = messages.find(entry => textOf(entry) === text);
				return { text: textOf(found), signature: thinkingSignatureOf(found) };
			};
			return { old: turn(PLACEHOLDER), latest: turn(LATEST) };
		};
		const fromPatched = await turnsAfterStrip(patched);
		expect(fromPatched).toEqual({
			old: { text: PLACEHOLDER, signature: undefined },
			latest: { text: LATEST, signature: "sig-latest" },
		});
		expect(fromPatched).toEqual(await turnsAfterStrip(inline));
	});

	// A failed turn a continuation marked (`continued`) stays in model context and
	// joins the turn that continued it: a resume replays it, so the strip must keep
	// its signature, which it strips from a failed turn no record marked.
	it("keeps the replay data of a failed turn a record marks as continued, as it does with the marker inline", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const signed = (text: string, signature: string, overrides: Partial<AssistantMessage> = {}) =>
			assistant(
				[
					{ type: "thinking", thinking: "reasoning", thinkingSignature: signature },
					{ type: "text", text },
				],
				overrides,
			);
		const failed = { stopReason: "error", errorMessage: "503 service unavailable" } as const;
		const before = [
			header("strip-plan"),
			message("u1", null, user("go")),
			message("a1", "u1", signed("first answer", "sig-first")),
			message("u2", "a1", user("again")),
		];
		const continuation = message("a3", "a2", signed(" and the rest.", "sig-rest"));
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			...before,
			message("a2", "u2", signed("partial", "sig-failed", failed)),
			continuation,
			patchRecord("p1", "a3", [{ entryId: "a2", message: { continued: true } }]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			...before,
			message("a2", "u2", signed("partial", "sig-failed", { ...failed, continued: true })),
			continuation,
		]);
		const storage = new FileSessionStorage();
		const replayedSignature = async (file: string) => {
			const plan = await planStrip(file, Date.now() + 60_000);
			if (plan) await applyStrip(plan, storage);
			const messages = await loadSessionMessagesReadOnly(file, storage);
			return thinkingSignatureOf(messages.find(entry => textOf(entry) === "partial"));
		};
		const fromPatched = await replayedSignature(patched);
		expect(fromPatched).toBe("sig-failed");
		expect(fromPatched).toBe(await replayedSignature(inline));
	});
});

describe("entry patch records and the Agent Hub transcript viewer", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A transcript whose answer `a1` ends the first window and whose second window holds the rest. */
	function transcript(answer: string, rest: readonly object[]): { content: Buffer; cut: number } {
		const first = jsonl([
			header(AGENT_ID),
			message("u1", null, user("do the task")),
			message("a1", "u1", assistant([{ type: "text", text: answer }])),
		]);
		return { content: Buffer.from(first + jsonl(rest)), cut: Buffer.byteLength(first) };
	}

	const record = patchRecord("p1", "a1", [
		{ entryId: "a1", message: { content: [{ type: "text", text: PLACEHOLDER }] } },
	]);
	const reply = message("u2", "p1", user("next step"));

	function viewerOver(source: AgentTranscriptSource, remote?: AgentHubRemote): AgentTranscriptViewer {
		const agents = new AgentRegistry();
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: "/sessions/main/Worker.jsonl",
			status: "parked",
		});
		return new AgentTranscriptViewer({
			transcript: source,
			agentId: AGENT_ID,
			registry: agents,
			remote,
			ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
			cwd: "/tmp",
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+s"],
			requestRender: () => {},
			onClose: () => {},
			onHubClose: () => {},
		});
	}

	function bodyOf(viewer: AgentTranscriptViewer): { heavy: boolean; placeholder: boolean; nextStep: boolean } {
		const body = viewer
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		return {
			heavy: body.includes("HEAVYMARK"),
			placeholder: body.includes("ELIDEDMARK"),
			nextStep: body.includes("next step"),
		};
	}

	/** Render the transcript a local read answers in two windows split at `cut`. */
	async function renderLocal({ content, cut }: { content: Buffer; cut: number }) {
		let read = Promise.resolve("");
		let reads = 0;
		const source: AgentTranscriptSource = {
			stat: () => ({ size: content.byteLength, mtimeMs: 1 }),
			// The first read answers one window, as a read of a long transcript does; the next ones read to the end.
			readFrom: (_file, offset) => {
				const end = reads++ === 0 ? cut : content.byteLength;
				read = Promise.resolve(content.subarray(offset, end).toString("utf-8"));
				return read;
			},
			parseEntries: agentTranscriptSource.parseEntries,
		};
		vi.useFakeTimers();
		const viewer = viewerOver(source);
		try {
			await read;
			for (let poll = 0; poll < 4; poll++) {
				vi.advanceTimersByTime(250);
				await read;
			}
			return bodyOf(viewer);
		} finally {
			viewer.dispose();
		}
	}

	/** Render the transcript a host answers in two replies split at `cut`. */
	async function renderRemote({ content, cut }: { content: Buffer; cut: number }) {
		let read: Promise<unknown> = Promise.resolve();
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: (_id, fromByte) => {
				const end = fromByte === 0 ? cut : content.byteLength;
				const result = Promise.resolve({ text: content.subarray(fromByte, end).toString("utf-8"), newSize: end });
				read = result;
				return result;
			},
		};
		const source: AgentTranscriptSource = {
			stat: () => {
				throw new Error("a guest reads the host's transcript");
			},
			readFrom: () => Promise.reject(new Error("a guest reads the host's transcript")),
			parseEntries: agentTranscriptSource.parseEntries,
		};
		vi.useFakeTimers();
		const viewer = viewerOver(source, remote);
		try {
			await read;
			for (let poll = 0; poll < 4; poll++) {
				vi.advanceTimersByTime(250);
				await read;
			}
			return bodyOf(viewer);
		} finally {
			viewer.dispose();
		}
	}

	// A transcript over one read window: the record arrives after the viewer
	// rendered its target, which kept the heavy text an elide pass removed.
	it("shows an answer a record in a later local window shortened as its placeholder, as a transcript with it inline does", async () => {
		const fromPatched = await renderLocal(transcript(HEAVY, [record, reply]));
		expect(fromPatched).toEqual({ heavy: false, placeholder: true, nextStep: true });
		expect(fromPatched).toEqual(await renderLocal(transcript(PLACEHOLDER, [reply])));
	});

	// A collab guest reads the host's transcript in replies of at most 4 MiB.
	it("shows an answer a record in a later host reply shortened as its placeholder, as a transcript with it inline does", async () => {
		const fromPatched = await renderRemote(transcript(HEAVY, [record, reply]));
		expect(fromPatched).toEqual({ heavy: false, placeholder: true, nextStep: true });
		expect(fromPatched).toEqual(await renderRemote(transcript(PLACEHOLDER, [reply])));
	});

	// A record may come before the entry it names: a guest that applied a reply's records only to
	// the entries it had read shows the heavy text when the answer arrives in the next reply.
	it("shows an answer a record in an earlier host reply shortened as its placeholder, as a transcript with it inline does", async () => {
		const first = jsonl([header(AGENT_ID), message("u1", null, user("do the task")), record]);
		const rest = jsonl([message("a1", "u1", assistant([{ type: "text", text: HEAVY }])), reply]);
		const fromPatched = await renderRemote({ content: Buffer.from(first + rest), cut: Buffer.byteLength(first) });
		expect(fromPatched).toEqual({ heavy: false, placeholder: true, nextStep: true });
		expect(fromPatched).toEqual(await renderRemote(transcript(PLACEHOLDER, [reply])));
	});
});
