/**
 * Contracts for the `entry_patch` records a session's passes append (an elide pass's placeholders, a
 * retry saga's marker, a compaction's corrected `tokensAfter`): every stats reader reads an entry with
 * the fields a later record sets, exactly as it reads the session with those fields written inline (the
 * control), and no reader lists a record as an entry.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getRequestDetails, getSessionEntryDetail } from "@oh-my-pi/omp-stats/client/api";
import { closeDb, getRecentRequests, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionEntry, parseAllSessionEntries, parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { handleApi } from "@oh-my-pi/omp-stats/server";
import { buildSessionTrace, getTraceEntry } from "@oh-my-pi/omp-stats/trace";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { SpotlightSessionBuilder } from "./helpers/spotlight-session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-entry-patches-");

afterEach(() => {
	vi.restoreAllMocks();
});

const T = Date.parse("2026-11-20T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const PROMPT = `Summarize this log:\n${"a line of a long pasted log\n".repeat(80)}(end of log)`;
const PROMPT_ELIDED = "Summarize this log:\n[shaken ~500 tokens — recover: artifact://7 (region 1)]";
const REPLY = `Here is the file:\n\`\`\`\n${"export const a = 1;\n".repeat(200)}\`\`\``;
const REPLY_ELIDED = "Here is the file:\n[shaken ~800 tokens — recover: artifact://7 (region 2)]";
const OUTPUT = "x".repeat(4000);
const OUTPUT_ELIDED = "[shaken ~1000 tokens — recover: artifact://7 (region 3)]";
const RECOVERY = {
	kind: "auto-retry",
	status: "superseded",
	attempt: 1,
	recovery: "wait",
	note: "Retried after a rate limit",
};
const USAGE = {
	input: 1000,
	output: 200,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1200,
	cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

/** How a session holds the fields its passes set: in `entry_patch` records after the entries, or written inline. */
type Form = "patched" | "inline";
const FORMS: readonly Form[] = ["patched", "inline"];

/** Entry ids of one form's session; each form has its own, since stats counts an entry a fork copied once. */
function ids(form: Form) {
	return {
		user: `user-${form}`,
		reply: `reply-${form}`,
		call: `call-${form}`,
		result: `result-${form}`,
		compaction: `compaction-${form}`,
		elide: `elide-${form}`,
		recovery: `recovery-${form}`,
		done: `done-${form}`,
	};
}

function replyContent(form: Form, text: string): Record<string, unknown>[] {
	return [
		{ type: "text", text },
		{ type: "toolCall", id: ids(form).call, name: "write", arguments: { path: "src/a.ts", content: "x" } },
	];
}

/**
 * A session's lines: a user prompt, a reply with a tool call, its result, a compaction, then the final
 * reply. Patched, an elide pass's record and a retry saga's record follow the compaction, and the final
 * reply names the last record as parent; inline, those fields are on the entries and the final reply
 * names the compaction.
 */
function sessionLines(form: Form): string[] {
	const id = ids(form);
	const inline = form === "inline";
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: `session-${form}`, timestamp: iso(T), cwd: "/repo" },
		{
			type: "message",
			id: id.user,
			parentId: null,
			timestamp: iso(T + 1000),
			message: { role: "user", content: inline ? PROMPT_ELIDED : PROMPT, timestamp: T + 1000 },
		},
		{
			type: "message",
			id: id.reply,
			parentId: id.user,
			timestamp: iso(T + 2000),
			message: {
				role: "assistant",
				content: replyContent(form, inline ? REPLY_ELIDED : REPLY),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-4-5",
				stopReason: "toolUse",
				timestamp: T + 1500,
				duration: 500,
				usage: USAGE,
				...(inline ? { elidedOutputTokens: 800, retryRecovery: RECOVERY } : {}),
			},
		},
		{
			type: "message",
			id: id.result,
			parentId: id.reply,
			timestamp: iso(T + 3000),
			message: {
				role: "toolResult",
				toolCallId: id.call,
				toolName: "write",
				content: [{ type: "text", text: inline ? OUTPUT_ELIDED : OUTPUT }],
				isError: false,
				timestamp: T + 3000,
				...(inline ? { prunedAt: T + 5000 } : {}),
			},
		},
		{
			type: "compaction",
			id: id.compaction,
			parentId: id.result,
			timestamp: iso(T + 4000),
			summary: "## Goal\nsummarized",
			firstKeptEntryId: id.result,
			tokensBefore: 100_000,
			tokensAfter: inline ? 20_000 : 80_000,
		},
	];
	if (!inline) {
		entries.push(
			{
				type: "custom",
				customType: "entry_patch",
				id: id.elide,
				parentId: id.compaction,
				timestamp: iso(T + 5000),
				data: {
					patches: [
						{ entryId: id.user, message: { content: PROMPT_ELIDED } },
						{
							entryId: id.reply,
							message: { content: replyContent(form, REPLY_ELIDED), elidedOutputTokens: 800 },
						},
						{
							entryId: id.result,
							message: { content: [{ type: "text", text: OUTPUT_ELIDED }], prunedAt: T + 5000 },
						},
					],
				},
			},
			{
				type: "custom",
				customType: "entry_patch",
				id: id.recovery,
				parentId: id.elide,
				timestamp: iso(T + 5500),
				data: {
					patches: [
						{ entryId: id.compaction, entry: { tokensAfter: 20_000 } },
						{ entryId: id.reply, message: { retryRecovery: RECOVERY } },
					],
				},
			},
		);
	}
	entries.push({
		type: "message",
		id: id.done,
		parentId: inline ? id.compaction : id.recovery,
		timestamp: iso(T + 6000),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Done." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-5",
			stopReason: "stop",
			timestamp: T + 6000,
			duration: 500,
			usage: USAGE,
		},
	});
	return entries.map(entry => JSON.stringify(entry));
}

function sessionPath(name: string): string {
	return path.join(getSessionsDir(), "--repo--", `${name}.jsonl`);
}

async function writeSession(form: Form): Promise<string> {
	const file = sessionPath(form);
	await Bun.write(file, `${sessionLines(form).join("\n")}\n`);
	return file;
}

/** `value` with the form in its ids replaced, so the two forms compare equal when they read the same. */
function sameIds<T>(value: T, form: Form): T {
	return JSON.parse(JSON.stringify(value).replaceAll(`-${form}`, "-x"));
}

/** Route the dashboard client's requests to the server's API handler. */
function serveApi(): void {
	const api = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) =>
			handleApi(new Request(`http://stats.test${input}`, init)),
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(api);
}

describe("a session whose passes appended entry_patch records reads as with those fields inline", () => {
	it("parseSessionFile derives its rows from the fields the records set", async () => {
		for (const form of FORMS) {
			const id = ids(form);
			const parsed = await parseSessionFile(await writeSession(form));
			expect({
				form,
				userChars: parsed.userStats.map(row => [row.entryId, row.chars]),
				callResultChars: parsed.toolCalls.map(row => [row.toolCallId, row.resultChars]),
				resultChars: parsed.toolResults.map(row => [row.toolCallId, row.resultChars]),
				requests: parsed.stats.map(row => row.entryId),
			}).toEqual({
				form,
				userChars: [[id.user, PROMPT_ELIDED.length]],
				callResultChars: [[id.call, OUTPUT_ELIDED.length]],
				resultChars: [[id.call, OUTPUT_ELIDED.length]],
				requests: [id.reply, id.done],
			});
		}
	});

	it("a sync that meets a record after it stored its target's rows replaces those rows", async () => {
		const stored = async (file: string) => {
			const db = await initDb();
			const user = db.prepare("SELECT chars FROM user_messages WHERE session_file = ?").get(file) as {
				chars: number;
			} | null;
			const call = db.prepare("SELECT result_chars FROM tool_calls WHERE session_file = ?").get(file) as {
				result_chars: number;
			} | null;
			return { userChars: user?.chars, resultChars: call?.result_chars };
		};
		const lines = sessionLines("patched");
		const firstRecord = lines.findIndex(line => line.includes('"entry_patch"'));
		const file = sessionPath("patched");
		await Bun.write(file, `${lines.slice(0, firstRecord).join("\n")}\n`);
		await syncAllSessions({ workers: 1 });
		expect(await stored(file)).toEqual({ userChars: PROMPT.length, resultChars: OUTPUT.length });

		await fs.appendFile(file, `${lines.slice(firstRecord).join("\n")}\n`);
		await syncAllSessions({ workers: 1 });
		const inline = await writeSession("inline");
		await syncAllSessions({ workers: 1 });
		expect(await stored(file)).toEqual({ userChars: PROMPT_ELIDED.length, resultChars: OUTPUT_ELIDED.length });
		expect(await stored(inline)).toEqual({ userChars: PROMPT_ELIDED.length, resultChars: OUTPUT_ELIDED.length });
	});

	it("a database that stored rows before its records applied derives them again once", async () => {
		const file = await writeSession("patched");
		await syncAllSessions({ workers: 1 });
		const db = await initDb();
		// As an older build left it: the record read past, the row derived from the original prompt.
		db.prepare("UPDATE user_messages SET chars = ? WHERE session_file = ?").run(PROMPT.length, file);
		db.prepare("DELETE FROM meta WHERE key = 'entry_patch_v1'").run();
		closeDb();
		await syncAllSessions({ workers: 1 });
		const row = (await initDb()).prepare("SELECT chars FROM user_messages WHERE session_file = ?").get(file) as {
			chars: number;
		};
		expect(row.chars).toBe(PROMPT_ELIDED.length);
	});

	it("the prefix scan of an offset-only read reads its entries with the fields the records set", async () => {
		for (const form of FORMS) {
			const b = new SpotlightSessionBuilder(T).header("/repo").marker();
			b.user("go");
			const [cut] = b.request({ cacheRead: 10_000, calls: [{ name: "read", args: { path: "src/a.ts:100-200" } }] });
			b.result(cut, {
				text: "100\tconst a = 1;\n… [120-178] (read artifact://0:21-79)\n179\tconst z = 2;",
				shape: {
					inTokens: 3000,
					outTokens: 1000,
					original: {
						url: "artifact://0",
						lines: 101,
						start: 100,
						path: "src/a.ts",
						kept: [
							[1, 20],
							[80, 101],
						],
					},
				},
			});
			const writeArgs = (file: string) => ({ path: file, content: "x" });
			// A write of src/a.ts stops the read of it; the record (any assistant content may be patched) names src/b.ts.
			const [write] = b.request({
				calls: [{ name: "write", args: writeArgs(form === "inline" ? "src/b.ts" : "src/a.ts") }],
			});
			b.result(write, { text: "ok" });
			const before = b.text();
			let prefix = before;
			if (form === "patched") {
				const reply = before
					.trim()
					.split("\n")
					.map(line => JSON.parse(line))
					.find(entry => entry.message?.content?.some?.((block: { id?: string }) => block.id === write));
				prefix += `${JSON.stringify({
					type: "custom",
					customType: "entry_patch",
					id: `record-${form}`,
					parentId: reply.id,
					timestamp: iso(T + 60_000),
					data: {
						patches: [
							{
								entryId: reply.id,
								message: {
									content: [{ type: "toolCall", id: write, name: "write", arguments: writeArgs("src/b.ts") }],
								},
							},
						],
					},
				})}\n`;
			}
			const [reread] = b.request({ calls: [{ name: "read", args: { path: "src/a.ts:150-160" } }] });
			b.result(reread, { text: "150\tline" });
			const file = sessionPath(`prefix-${form}`);
			await Bun.write(file, prefix + b.text().slice(before.length));

			const parsed = await parseSessionFile(file, Buffer.byteLength(prefix));
			expect({ form, needs: parsed.spotlight.needs.map(row => [row.toolCallId, row.reread]) }).toEqual({
				form,
				needs: [[cut, [[51, 61]]]],
			});
		}
	});

	it("parseAllSessionEntries lists the entries with the fields the records set, and no record", async () => {
		const [patched, inline] = await Promise.all(
			FORMS.map(async form =>
				sameIds(parseAllSessionEntries(await Bun.file(await writeSession(form)).bytes()), form),
			),
		);
		expect(patched).toEqual(inline);
		expect(patched.some(entry => "customType" in entry && entry.customType === "entry_patch")).toBe(false);
		expect(patched.find(entry => "id" in entry && entry.id === "done-x")).toMatchObject({ parentId: "compaction-x" });
	});

	it("the trace shows the fields the records set", async () => {
		const [patched, inline] = await Promise.all(
			FORMS.map(async form => {
				const trace = await buildSessionTrace(await writeSession(form));
				const [main] = trace.tracks;
				return sameIds({ spans: main.spans, markers: main.markers, summary: trace.summary }, form);
			}),
		);
		expect(patched).toEqual(inline);
		expect(patched.markers.map(marker => marker.label)).toEqual(["compaction 100k→20k"]);
		expect(patched.spans.filter(span => span.kind === "turn").map(span => span.label)).toEqual([
			PROMPT_ELIDED.replace(/\s+/g, " "),
		]);
		// The final reply is on the active branch: its parent, the last record, leads on to the compaction.
		expect(patched.spans.filter(span => span.kind === "model").map(span => span.detail)).toEqual([
			REPLY_ELIDED.replace(/\s+/g, " "),
			"Done.",
		]);
	});

	it("the span drawer reads an entry with the fields the records set, and no record", async () => {
		serveApi();
		for (const form of FORMS) {
			const id = ids(form);
			const file = await writeSession(form);
			const expected = { message: { content: [{ type: "text", text: OUTPUT_ELIDED }], prunedAt: T + 5000 } };
			const server = await getTraceEntry(file, id.result);
			const { entry: client } = await getSessionEntryDetail(file, id.result);
			expect({ form, server, client }).toMatchObject({ form, server: expected, client: expected });
		}
		const file = sessionPath("patched");
		expect(await getTraceEntry(file, ids("patched").elide)).toBeNull();
		await expect(getSessionEntryDetail(file, ids("patched").elide)).rejects.toThrow("entry not found");
	});

	it("the request drawer reads a request with the fields the records set, and no record", async () => {
		serveApi();
		const files = new Map<Form, string>();
		for (const form of FORMS) files.set(form, await writeSession(form));
		await syncAllSessions({ workers: 1 });
		await initDb();
		const expected = sameIds(
			{ content: replyContent("patched", REPLY_ELIDED), elidedOutputTokens: 800, retryRecovery: RECOVERY },
			"patched",
		);
		for (const form of FORMS) {
			const id = ids(form);
			const entry = await getSessionEntry(files.get(form) ?? "", id.reply);
			const row = getRecentRequests(10).find(request => request.entryId === id.reply);
			if (!row?.id) throw new Error(`no stored request for ${form}`);
			const details = await getRequestDetails(row.id);
			const read = { form, server: entry && "message" in entry ? entry.message : null, client: details.output };
			expect(sameIds(read, form)).toMatchObject({ form, server: expected, client: expected });
		}
		expect(await getSessionEntry(files.get("patched") ?? "", ids("patched").elide)).toBeNull();
	});
});
