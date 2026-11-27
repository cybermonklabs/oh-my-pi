import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { stringifyJsonIteratively, TempDir } from "@oh-my-pi/pi-utils";
import { DEEP_LEVELS, nestedChain, nestingOf } from "../../../ai/test/helpers/deep-nesting";
import { runAnonymizeCommand } from "../../src/cli/anonymize-cli";
import { ENTRY_PATCH_CUSTOM_TYPE } from "@oh-my-pi/pi-utils/entry-patches";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The arguments of the tool call `entry`, an assistant message entry, holds. */
function toolCallArguments(entry: SessionEntry | undefined): unknown {
	if (entry?.type !== "message" || entry.message.role !== "assistant") throw new Error("not an assistant entry");
	const call = entry.message.content.find(block => block.type === "toolCall");
	if (call?.type !== "toolCall") throw new Error("no tool call");
	return call.arguments;
}

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A session whose `entry_patch` record `p1` sets the content of the assistant
 * turn `a1` (as an elide pass does) to a text block and a tool call whose
 * arguments nest {@link DEEP_LEVELS} levels: the record holds the whole content.
 */
async function writeSession(dir: string): Promise<string> {
	const content = [
		{ type: "text", text: "[elided]" },
		{ type: "toolCall", id: "call-1", name: "inspect", arguments: nestedChain() },
	];
	const lines: unknown[] = [
		{ type: "session", version: CURRENT_SESSION_VERSION, id: path.basename(dir), timestamp: TIMESTAMP, cwd: dir },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: { role: "user", content: "inspect it", timestamp: 1 },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: TIMESTAMP,
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "a long answer the elide pass shortened" },
					{ type: "toolCall", id: "call-1", name: "inspect", arguments: { leaf: "bottom" } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "r1",
			parentId: "a1",
			timestamp: TIMESTAMP,
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "inspect",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			},
		},
		{
			type: "custom",
			id: "p1",
			parentId: "r1",
			timestamp: TIMESTAMP,
			customType: ENTRY_PATCH_CUSTOM_TYPE,
			data: { patches: [{ entryId: "a1", message: { content } }] },
		},
	];
	const file = path.join(dir, "sessions", "main.jsonl");
	await Bun.write(file, lines.map(line => `${stringifyJsonIteratively(line)}\n`).join(""));
	return file;
}

// An elide pass writes a turn's whole content into an `entry_patch` record, and a tool call's arguments are any
// JSON; the session writer writes such a record at any depth, so every reader that applies the records must too.
describe("a session holding an entry_patch record nested 50,000 levels", () => {
	it("resumes with the patched content", async () => {
		using dir = TempDir.createSync("@omp-deep-patch-");
		const manager = await SessionManager.open(await writeSession(dir.path()), dir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(nestingOf(toolCallArguments(manager.getEntry("a1")))).toEqual({
				levels: DEEP_LEVELS,
				bottom: { leaf: "bottom" },
			});
		} finally {
			await manager.close();
		}
	}, 30_000);

	it("forks with the patched content", async () => {
		using dir = TempDir.createSync("@omp-deep-patch-");
		const fork = await SessionManager.forkFrom(
			await writeSession(dir.path()),
			dir.path(),
			path.join(dir.path(), "forks"),
			new FileSessionStorage(),
			{ suppressBreadcrumb: true },
		);
		try {
			const forked = fork.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant");
			expect(nestingOf(toolCallArguments(forked))).toEqual({ levels: DEEP_LEVELS, bottom: { leaf: "bottom" } });
		} finally {
			await fork.close();
		}
	}, 30_000);

	it("is anonymized by omp anonymize", async () => {
		using dir = TempDir.createSync("@omp-deep-patch-");
		const out = path.join(dir.path(), "out");
		await runAnonymizeCommand({ session: await writeSession(dir.path()), out });
		const records = (await Bun.file(path.join(out, "session.jsonl")).text())
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line) as SessionEntry);
		// Entry ids are short names, which the export maps; the assistant turn is the one record of its role.
		const assistant = records.find(record => record.type === "message" && record.message.role === "assistant");
		// `inspect` is no built-in tool: its arguments export as one opaque marker.
		expect(toolCallArguments(assistant)).toMatch(/^\[redacted #\d+: \d+ chars, 1 line\]$/);
	}, 30_000);
});
