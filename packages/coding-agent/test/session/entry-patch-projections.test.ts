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

	// `omp gc --strip` removes replay data from old turns. A record that sets an old
	// turn's content keeps the signature the strip removed from its line, and a
	// resume sets that content again: the strip must reach the record too.
	it("strips the replay data of a record's content for an old turn, as it strips the turn written inline", async () => {
		using dir = TempDir.createSync("@omp-patch-projections-");
		const signed = (text: string, signature: string) =>
			assistant([
				{ type: "thinking", thinking: "reasoning", thinkingSignature: signature },
				{ type: "text", text },
			]);
		const tail = [message("u2", "a1", user("and now")), message("a2", "u2", signed("latest answer", "sig-latest"))];
		const patched = await writeTranscript(path.join(dir.path(), "patched.jsonl"), [
			header("strip-patched"),
			message("u1", null, user("go")),
			message("a1", "u1", signed(HEAVY, "sig-old")),
			...tail,
			patchRecord("p1", "a2", [
				{
					entryId: "a1",
					message: {
						content: [
							{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-old" },
							{ type: "text", text: PLACEHOLDER },
						],
					},
				},
			]),
		]);
		const inline = await writeTranscript(path.join(dir.path(), "inline.jsonl"), [
			header("strip-inline"),
			message("u1", null, user("go")),
			message("a1", "u1", signed(PLACEHOLDER, "sig-old")),
			...tail,
		]);
		const storage = new FileSessionStorage();
		const oldTurnAfterStrip = async (file: string) => {
			const plan = await planStrip(file, Date.now() + 60_000);
			if (plan) await applyStrip(plan, storage);
			const messages = await loadSessionMessagesReadOnly(file, storage);
			const old = messages.find(entry => textOf(entry).includes("MARK"));
			return { text: textOf(old), signature: thinkingSignatureOf(old) };
		};
		const fromPatched = await oldTurnAfterStrip(patched);
		expect(fromPatched).toEqual({ text: PLACEHOLDER, signature: undefined });
		expect(fromPatched).toEqual(await oldTurnAfterStrip(inline));
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
});
