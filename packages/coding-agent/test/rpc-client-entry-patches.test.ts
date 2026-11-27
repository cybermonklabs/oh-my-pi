import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionTreeNode,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	ENTRY_PATCH_CUSTOM_TYPE,
	type EntryPatch,
	entryAcceptsPatch,
	setPatchedFields,
} from "@oh-my-pi/pi-utils/entry-patches";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type FakeRpcRequest, fakeRpcAgent } from "./helpers/fake-rpc-agent";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** What an elide pass leaves in place of a heavy tool result. */
const PLACEHOLDER = [{ type: "text", text: "[elided: see artifact://1]" }];
const HEAVY = [{ type: "text", text: "heavy tool output ".repeat(16) }];

function header(dir: string): SessionHeader {
	return { type: "session", version: CURRENT_SESSION_VERSION, id: path.basename(dir), timestamp: TIMESTAMP, cwd: dir };
}

function userEntry(id: string, parentId: string | null, text: string) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function toolCallEntry(id: string, parentId: string | null, extra: object = {}) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls -R" } }],
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
			stopReason: "toolUse",
			timestamp: 2,
			...extra,
		},
	};
}

function toolResultEntry(id: string, parentId: string, content: object[]) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content, isError: false, timestamp: 3 },
	};
}

function patchRecord(id: string, parentId: string | null, patches: object[]) {
	return {
		type: "custom",
		customType: ENTRY_PATCH_CUSTOM_TYPE,
		id,
		parentId,
		timestamp: TIMESTAMP,
		data: { patches },
	};
}

function jsonl(entries: readonly object[]): string {
	return entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
}

/** The part of a fake agent that answers requests. */
interface Answerer {
	readonly requests: readonly FakeRpcRequest[];
	reply(request: FakeRpcRequest, data?: unknown): void;
}

/**
 * Call `call`, answer the request it writes with `data(request)`, and return
 * what the call resolves to. The client writes a request before its first await.
 */
async function answered<T>(
	agent: Answerer,
	call: () => Promise<T>,
	data: (request: FakeRpcRequest) => unknown,
): Promise<T> {
	const index = agent.requests.length;
	const pending = call();
	const request = agent.requests[index];
	if (!request) throw new Error("Expected the client to write a request");
	agent.reply(request, await data(request));
	return pending;
}

/** The content of the tool result among `messages`. */
function resultContent(messages: readonly AgentMessage[]): unknown {
	const result = messages.find(message => message.role === "toolResult");
	return result?.role === "toolResult" ? result.content : undefined;
}

/** `elidedOutputTokens` of each of `messages`, undefined for one that is not an assistant's. */
function elidedOutputTokens(messages: readonly AgentMessage[]): (number | undefined)[] {
	return messages.map(message => (message.role === "assistant" ? message.elidedOutputTokens : undefined));
}

describe("RpcClient and entry_patch records", () => {
	// A subagent transcript is read in windows: a record that an elide pass
	// appends lands in a later window than the tool result it shortens. If this
	// regresses, a host polling the transcript keeps showing the heavy result,
	// and lists the record as an entry.
	it("returns the patch of a record in a later get_subagent_messages reply, which applies to the earlier entry", async () => {
		using dir = TempDir.createSync("@omp-rpc-entry-patch-");
		const file = path.join(dir.path(), "subagent.jsonl");
		await Bun.write(
			file,
			jsonl([
				header(dir.path()),
				userEntry("u1", null, "list the files"),
				toolCallEntry("a1", "u1"),
				toolResultEntry("t1", "a1", HEAVY),
			]),
		);
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		// The server's own reader answers each request.
		const serve = (request: FakeRpcRequest) =>
			readRpcSubagentTranscript(file, typeof request.fromByte === "number" ? request.fromByte : 0);

		const first = await answered(agent, () => client.getSubagentMessages({ sessionFile: file }), serve);
		expect(resultContent(first.messages)).toEqual(HEAVY);
		await fs.appendFile(
			file,
			jsonl([
				patchRecord("p1", "t1", [{ entryId: "t1", message: { content: PLACEHOLDER } }]),
				userEntry("u2", "p1", "thanks"),
			]),
		);
		const second = await answered(
			agent,
			() => client.getSubagentMessages({ sessionFile: file, fromByte: first.nextByte }),
			serve,
		);
		// What a caller that holds the earlier entries does with the patches.
		for (const patch of second.entryPatches) {
			const target = first.entries.find(entry => entry.type !== "session" && entry.id === patch.entryId);
			if (target && entryAcceptsPatch(target, patch)) setPatchedFields(target, patch);
		}

		// Control: the same transcript with the field written inline, read in one reply.
		const inlineFile = path.join(dir.path(), "inline.jsonl");
		await Bun.write(
			inlineFile,
			jsonl([
				header(dir.path()),
				userEntry("u1", null, "list the files"),
				toolCallEntry("a1", "u1"),
				toolResultEntry("t1", "a1", PLACEHOLDER),
				userEntry("u2", "t1", "thanks"),
			]),
		);
		const inline = await answered(
			agent,
			() => client.getSubagentMessages({ sessionFile: inlineFile }),
			request => readRpcSubagentTranscript(inlineFile, typeof request.fromByte === "number" ? request.fromByte : 0),
		);

		expect({
			secondReply: second.entries.map(entry => (entry.type === "session" ? "session" : [entry.id, entry.parentId])),
			secondMessages: second.messages.map(message => message.role),
			entryPatches: second.entryPatches,
		}).toEqual({
			secondReply: [["u2", "t1"]],
			secondMessages: ["user"],
			entryPatches: [{ entryId: "t1", message: { content: PLACEHOLDER } }],
		});
		// The patched entry reads as the inline file's, and the message the first reply returned with it.
		expect(first.entries).toEqual(inline.entries.slice(0, 4));
		expect(resultContent(first.messages)).toEqual(resultContent(inline.messages));
		expect(inline.entryPatches).toEqual([]);
	});

	// The records of one reply apply to its entries whatever the server did,
	// and only a patch whose target the reply lacks comes back.
	it("applies a get_subagent_messages record to an entry of its own reply and returns only the others", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		const elideAndMark: EntryPatch[] = [
			{ entryId: "t1", message: { content: PLACEHOLDER } },
			{ entryId: "a0", message: { elidedOutputTokens: 9 } },
		];
		const entries = [
			toolCallEntry("a1", "a0"),
			toolResultEntry("t1", "a1", HEAVY),
			patchRecord("p1", "t1", elideAndMark),
		];

		const read = await answered(
			agent,
			() => client.getSubagentMessages({ sessionFile: "/s.jsonl", fromByte: 100 }),
			() => ({
				sessionFile: "/s.jsonl",
				fromByte: 100,
				nextByte: 200,
				reset: false,
				entries,
				messages: entries.flatMap(entry => ("message" in entry ? [entry.message] : [])),
			}),
		);

		expect(read.entries.map(entry => (entry.type === "session" ? "session" : entry.id))).toEqual(["a1", "t1"]);
		expect(resultContent(read.messages)).toEqual(PLACEHOLDER);
		expect(elidedOutputTokens(read.messages)).toEqual([undefined, undefined]);
		expect(read.entryPatches).toEqual([{ entryId: "a0", message: { elidedOutputTokens: 9 } }]);
	});

	// A host that mirrors the session with get_entries(since) or get_tree sees
	// each record as an entry, and an entry after it whose parent is no entry
	// it lists.
	describe("get_entries and get_tree over the real server", () => {
		let client: RpcClient | undefined;
		let directory: TempDir | undefined;

		afterEach(async () => {
			const ownClient = client;
			const ownDirectory = directory;
			client = undefined;
			directory = undefined;
			await ownClient?.stop();
			ownDirectory?.removeSync();
		});

		async function readSession(file: string) {
			const dir = path.dirname(file);
			client = new RpcClient({
				command: [process.execPath, path.join(import.meta.dir, "fixtures", "tree-rpc-agent.ts"), dir, file],
				cwd: dir,
				env: { PI_CODING_AGENT_DIR: dir, PI_NO_TITLE: "1" },
			});
			await client.start();
			const entries = await client.getEntries();
			const tree = await client.getTree();
			await client.stop();
			client = undefined;
			return { entries, tree };
		}

		/** The tree as nested ids, each with its entry's parent; walked, as a session tree nests one level per entry. */
		function shape(tree: readonly SessionTreeNode[]): unknown[] {
			const roots: unknown[] = [];
			const stack: Array<{ node: SessionTreeNode; into: unknown[] }> = tree.map(node => ({ node, into: roots }));
			stack.reverse();
			while (stack.length > 0) {
				const { node, into } = stack.pop()!;
				const children: unknown[] = [];
				into.push({ id: node.entry.id, parentId: node.entry.parentId, children });
				for (let index = node.children.length - 1; index >= 0; index--) {
					stack.push({ node: node.children[index]!, into: children });
				}
			}
			return roots;
		}

		it("lists no record, and an entry after a record and a leaf on one take the record's parent", async () => {
			directory = TempDir.createSync("@omp-rpc-entry-patch-");
			const patchedDir = path.join(directory.path(), "patched");
			const inlineDir = path.join(directory.path(), "inline");
			await fs.mkdir(patchedDir);
			await fs.mkdir(inlineDir);
			const patchedFile = path.join(patchedDir, "session.jsonl");
			const inlineFile = path.join(inlineDir, "session.jsonl");
			// The original lines, a record that elides the result, and a record that is the leaf.
			await Bun.write(
				patchedFile,
				jsonl([
					header(patchedDir),
					userEntry("u1", null, "list the files"),
					toolCallEntry("a1", "u1"),
					toolResultEntry("t1", "a1", HEAVY),
					patchRecord("p1", "t1", [{ entryId: "t1", message: { content: PLACEHOLDER } }]),
					userEntry("u2", "p1", "thanks"),
					patchRecord("p2", "u2", [{ entryId: "a1", message: { elidedOutputTokens: 7 } }]),
				]),
			);
			// Control: the same session with the fields written inline.
			await Bun.write(
				inlineFile,
				jsonl([
					header(inlineDir),
					userEntry("u1", null, "list the files"),
					toolCallEntry("a1", "u1", { elidedOutputTokens: 7 }),
					toolResultEntry("t1", "a1", PLACEHOLDER),
					userEntry("u2", "t1", "thanks"),
				]),
			);

			const patched = await readSession(patchedFile);
			const inline = await readSession(inlineFile);

			expect(patched.entries.entries.map(entry => entry.id)).toEqual(["u1", "a1", "t1", "u2"]);
			expect(patched.entries).toEqual(inline.entries);
			expect(patched.entries.leafId).toBe("u2");
			expect(shape(patched.tree.tree)).toEqual(shape(inline.tree.tree));
			expect(patched.tree.tree).toEqual(inline.tree.tree);
			expect(patched.tree.leafId).toBe("u2");
		}, 60_000);
	});

	// The server serves its live entries, which already carry each record; a
	// record it holds keeps a value a later rewrite-only pass replaced in its
	// entry. If the client applied the record again, the replaced value (here,
	// images a later pass dropped from an elided result) would come back.
	it("does not apply a get_entries record again over its entry's later value", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		const withImage = [...PLACEHOLDER, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }];

		const read = await answered(
			agent,
			() => client.getEntries(),
			() => ({
				entries: [
					toolCallEntry("a1", null),
					toolResultEntry("t1", "a1", PLACEHOLDER),
					patchRecord("p1", "t1", [{ entryId: "t1", message: { content: withImage } }]),
				],
				leafId: "p1",
			}),
		);

		const result = read.entries.find(entry => entry.id === "t1");
		expect(result?.type === "message" ? result.message : undefined).toMatchObject({ content: PLACEHOLDER });
		expect(read.entries.map(entry => entry.id)).toEqual(["a1", "t1"]);
		expect(read.leafId).toBe("t1");
	});

	// A host polls get_entries with `since` the last entry it lists. A record
	// at the end of one reply comes again at the start of the next; one that
	// is not comes again only in a read of the whole history.
	it("relinks an entry to the parent of a record an earlier get_entries reply returned", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		const whole = await answered(
			agent,
			() => client.getEntries(),
			() => ({
				entries: [
					userEntry("u1", null, "go"),
					patchRecord("p1", "u1", []),
					userEntry("x1", "u1", "a branch from u1"),
				],
				leafId: "x1",
			}),
		);
		const next = await answered(
			agent,
			() => client.getEntries("x1"),
			() => ({ entries: [userEntry("u2", "p1", "after the record")], leafId: "u2" }),
		);
		const leafOnRecord = await answered(
			agent,
			() => client.getEntries("u2"),
			() => ({ entries: [], leafId: "p1" }),
		);

		expect(whole.entries.map(entry => [entry.id, entry.parentId])).toEqual([
			["u1", null],
			["x1", "u1"],
		]);
		expect(next.entries.map(entry => [entry.id, entry.parentId])).toEqual([["u2", "u1"]]);
		expect(leafOnRecord.leafId).toBe("u1");
	});

	it("splices get_tree record nodes out, a root record and a record under a record among them", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();
		const node = (entry: object, children: object[] = []) => ({ entry, children });

		const read = await answered(
			agent,
			() => client.getTree(),
			() => ({
				tree: [
					node(patchRecord("r0", null, []), [
						node(userEntry("u1", "r0", "go"), [
							node(patchRecord("p1", "u1", []), [
								node(patchRecord("p2", "p1", []), [node(userEntry("u2", "p2", "after the records"))]),
							]),
							node(userEntry("x1", "u1", "a branch from u1")),
						]),
					]),
				],
				leafId: "p2",
			}),
		);

		const shapeOf = (nodes: readonly SessionTreeNode[]): unknown[] =>
			nodes.map(child => ({
				id: child.entry.id,
				parentId: child.entry.parentId,
				children: shapeOf(child.children),
			}));
		expect(shapeOf(read.tree)).toEqual([
			{
				id: "u1",
				parentId: null,
				children: [
					{ id: "u2", parentId: "u1", children: [] },
					{ id: "x1", parentId: "u1", children: [] },
				],
			},
		]);
		expect(read.leafId).toBe("u1");
	});
});
