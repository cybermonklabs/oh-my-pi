import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { BlobStore, type SessionBlobTier } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { convertToColdEntry, isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { ColdEntryStore } from "@oh-my-pi/pi-coding-agent/session/cold-entry-store";
import type { RuntimeIdentity } from "@oh-my-pi/pi-coding-agent/session/runtime-identity";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getBlobsDir, getConfigRootDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { coldDirIn, withoutAccountId } from "../helpers/account-id";
import { HAS_PROC_FD } from "../helpers/open-descriptors";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
const COLD_DIR = coldDirIn(os.tmpdir());
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function usage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: usage(),
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

/** A transcript record of a fixture: its id, and whatever else the record holds. */
type FixtureRecord = { readonly id: string } & Record<string, unknown>;

/**
 * Write `records` to `dir/session.jsonl` after a header, each stamped
 * {@link TIMESTAMP} and, unless it names its own parent, the child of the
 * record before it (the first a root). The session id is the directory's
 * name, so no two tests share a session (a manager another test left open
 * keeps its writer claim on its session).
 */
async function writeTranscript(dir: string, records: readonly FixtureRecord[]): Promise<string> {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	const entries = records.map(({ id, ...fields }, index) => ({
		type: fields.type,
		id,
		parentId: index === 0 ? null : records[index - 1]!.id,
		timestamp: TIMESTAMP,
		...fields,
	}));
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, [header, ...entries].map(line => `${JSON.stringify(line)}\n`).join(""));
	return file;
}

/**
 * A session whose compaction keeps `u2` on: `u1` and `a1` lie before the cut,
 * and so does `m1`, a model change, which stays whole by kind. Every entry
 * carries `runtime` when given.
 */
function writeSession(dir: string, runtime?: RuntimeIdentity): Promise<string> {
	const records: FixtureRecord[] = [
		{ type: "message", id: "u1", message: { role: "user", content: `u1 ${BODY}`, timestamp: 1 } },
		{ type: "model_change", id: "m1", model: "anthropic/claude-sonnet-4-20250514" },
		{ type: "message", id: "a1", message: assistant(`a1 ${BODY}`) },
		{ type: "message", id: "u2", message: { role: "user", content: `u2 ${BODY}`, timestamp: 3 } },
		{ type: "compaction", id: "c1", summary: `c1 ${BODY}`, firstKeptEntryId: "u2", tokensBefore: 1000 },
		{ type: "message", id: "a2", message: assistant(`a2 ${BODY}`) },
	];
	return writeTranscript(dir, runtime ? records.map(record => ({ ...record, runtime })) : records);
}

function open(file: string, coldStore = true): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true, coldStore });
}

function entry(manager: SessionManager, id: string): SessionEntry {
	const found = manager.getEntry(id);
	if (!found) throw new Error(`missing entry ${id}`);
	return found;
}

function messageOf(found: SessionEntry) {
	if (found.type !== "message") throw new Error(`entry ${found.id} is not a message`);
	return found.message;
}

/** The content of a user or assistant message entry of the fixture. */
function contentOf(found: SessionEntry): string | TextContent[] {
	const message = messageOf(found);
	if (message.role !== "user" && message.role !== "assistant") throw new Error(`entry ${found.id} has no text`);
	return message.content as string | TextContent[];
}

function textOf(found: SessionEntry): string {
	const content = contentOf(found);
	if (typeof content === "string") return content;
	return content.map(block => block.text).join("");
}

/** Descriptors of this process open on a cold store file in `dir`, by fd number. */
function coldStoreDescriptors(dir = COLD_DIR): Map<string, string> {
	const found = new Map<string, string>();
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		let target: string;
		try {
			target = fs.readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			continue;
		}
		if (target.startsWith(`${dir}${path.sep}`)) found.set(fd, target);
	}
	return found;
}

/**
 * Run full collections until `done` holds, at most `rounds` times. Finalizers
 * run as tasks after a collection, so each round yields one event-loop turn;
 * no clock is involved.
 */
async function collectGarbage(done: () => boolean, rounds = 20): Promise<void> {
	for (let round = 0; round < rounds && !done(); round++) {
		Bun.gc(true);
		await Bun.sleep(0);
	}
}

/** Text longer than a persisted line keeps: a full write cuts it. */
const UNCUT_TEXT = "y".repeat(600_000);
const TRUNCATION_NOTICE = "[Session persistence truncated large content]";

interface StoredImage {
	bytes: Buffer;
	hash: string;
	ref: string;
}

/** Two images, larger than a persisted line keeps inline, in the current agent's blob store. */
function storeImages(): [StoredImage, StoredImage] {
	const blobs = new BlobStore(getBlobsDir());
	const store = (fill: number): StoredImage => {
		const bytes = Buffer.alloc(3000, fill);
		const { hash, ref } = blobs.putSync(bytes, { extension: "png" });
		return { bytes, hash, ref };
	};
	return [store(1), store(2)];
}

/** An image a signed block carries: a persisted line keeps the block, and so the image, verbatim. */
const SIGNED_IMAGE = Buffer.alloc(3000, 3).toString("base64");

/**
 * A session whose compaction `c1` keeps `u2` on, so `u1` and `a1` load cold.
 * `u1` and `u3` hold an image each, as blob references the way a written
 * session holds them, and `a2` a signed tool call with {@link SIGNED_IMAGE};
 * `a1` and `a3` hold text a full write cuts. Ends at `u4`.
 */
function writeImageSession(dir: string, images: [StoredImage, StoredImage]): Promise<string> {
	const user = (id: string, image?: StoredImage): FixtureRecord => ({
		type: "message",
		id,
		message: {
			role: "user",
			content: [
				{ type: "text", text: `${id} ${BODY}` },
				...(image ? [{ type: "image", data: image.ref, mimeType: "image/png" }] : []),
			],
			timestamp: 1,
		},
	});
	const reply = (id: string, text = BODY): FixtureRecord => ({
		type: "message",
		id,
		message: assistant(`${id} ${text}`),
	});
	return writeTranscript(dir, [
		user("u1", images[0]),
		reply("a1", UNCUT_TEXT),
		user("u2"),
		{ type: "compaction", id: "c1", summary: `c1 ${BODY}`, firstKeptEntryId: "u2", tokensBefore: 1000 },
		{
			type: "message",
			id: "a2",
			message: {
				...assistant(`a2 ${BODY}`),
				content: [
					{ type: "text", text: `a2 ${BODY}` },
					{
						type: "toolCall",
						id: "call-a2",
						name: "inspect",
						arguments: { images: [{ data: SIGNED_IMAGE, mimeType: "image/png" }] },
						thoughtSignature: "signature-a2",
					},
				],
			},
		},
		user("u3", images[1]),
		reply("a3", UNCUT_TEXT),
		user("u4"),
	]);
}

/** A `tool_result_prune` record that blanks `r1` of {@link writeToolResultSession}. */
const R1_PRUNE = {
	type: "custom",
	customType: "tool_result_prune",
	id: "p1",
	data: { results: [{ entryId: "r1", notice: "[r1 pruned]", prunedAt: 7 }] },
};

/** An `entry_patch` record that sets the content of `r2` of {@link writeToolResultSession}. */
const R2_PATCH = {
	type: "custom",
	customType: "entry_patch",
	id: "x1",
	data: { patches: [{ entryId: "r2", message: { content: [{ type: "text", text: "r2 patched" }] } }] },
};

/**
 * A session whose compaction `c1` keeps `u2` on: before the cut, `r1` and
 * `r2`, tool results holding an image each as a blob reference the way a
 * written session holds them, load cold, and `records` follow `r2`. Ends at
 * `a3`.
 */
function writeToolResultSession(
	dir: string,
	images: [StoredImage, StoredImage],
	records: readonly FixtureRecord[] = [],
): Promise<string> {
	const call = (id: string, callId: string): FixtureRecord => ({
		type: "message",
		id,
		message: {
			...assistant(`${id} ${BODY}`),
			content: [{ type: "toolCall", id: callId, name: "inspect", arguments: {} }],
			stopReason: "toolUse",
		},
	});
	const result = (id: string, callId: string, image: StoredImage): FixtureRecord => ({
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: "inspect",
			content: [
				{ type: "text", text: `${id} ${BODY}` },
				{ type: "image", data: image.ref, mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		},
	});
	return writeTranscript(dir, [
		{ type: "message", id: "u1", message: { role: "user", content: `u1 ${BODY}`, timestamp: 1 } },
		call("a1", "call-1"),
		result("r1", "call-1", images[0]),
		call("a2", "call-2"),
		result("r2", "call-2", images[1]),
		...records,
		{ type: "message", id: "u2", message: { role: "user", content: `u2 ${BODY}`, timestamp: 3 } },
		{ type: "compaction", id: "c1", summary: `c1 ${BODY}`, firstKeptEntryId: "u2", tokensBefore: 1000 },
		{ type: "message", id: "a3", message: assistant(`a3 ${BODY}`) },
	]);
}

describe("cold entry store", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps entries before the cut cold except the kinds kept whole, and serves a read from the record once", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));

		const before = manager.coldStoreStats();
		expect(before.coldEntries).toBe(2);
		expect(before.storeBytes).toBeGreaterThan(0);
		expect(before.materializations).toBe(0);

		expect(textOf(entry(manager, "u1"))).toBe(`u1 ${BODY}`);
		expect(textOf(entry(manager, "u1"))).toBe(`u1 ${BODY}`);
		expect(manager.coldStoreStats().materializations).toBe(1);

		const modelChange = entry(manager, "m1");
		expect(Object.getOwnPropertyDescriptor(modelChange, "model")?.get).toBeUndefined();
		expect(manager.buildSessionContext().messages.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
		]);
	});

	it("serializes every entry exactly as a manager holding every entry does", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const file = await writeSession(dir.path());
		const cold = await open(file);
		const whole = await open(file, false);
		expect(cold.coldStoreStats().coldEntries).toBeGreaterThan(0);
		expect(whole.coldStoreStats().coldEntries).toBe(0);

		expect(cold.getEntries().map(found => JSON.stringify(found))).toEqual(
			whole.getEntries().map(found => JSON.stringify(found)),
		);
		expect(cold.getEntries().map(found => structuredClone(found))).toEqual(
			whole.getEntries().map(found => structuredClone(found)),
		);
		expect({ ...messageOf(entry(cold, "a1")) }).toEqual({ ...messageOf(entry(whole, "a1")) });
	});

	it("keeps each entry and its message the same objects while they go cold and whole", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		const view = manager.getBranchView();
		const a2 = entry(manager, "a2");
		const a2Message = messageOf(a2);

		const a3 = manager.appendMessage(assistant(`a3 ${BODY}`));
		manager.appendCompaction(`c2 ${BODY}`, undefined, a3, 2000);
		manager.buildSessionContext();
		expect(manager.coldStoreStats().coldEntries).toBeGreaterThan(2);

		expect(entry(manager, "a2")).toBe(a2);
		expect(messageOf(a2)).toBe(a2Message);
		expect(view).toContain(a2);
		expect(textOf(a2)).toBe(`a2 ${BODY}`);
	});

	it("moves the cut to the new compaction once the context is rebuilt from it", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		expect(manager.coldStoreStats().coldEntries).toBe(2);

		const a3 = manager.appendMessage(assistant(`a3 ${BODY}`));
		manager.appendCompaction(`c2 ${BODY}`, undefined, a3, 2000);
		const context = manager.buildSessionContext();

		// u1, a1, u2, c1 and a2 now lie before the cut at a3.
		expect(manager.coldStoreStats().coldEntries).toBe(5);
		expect(context.messages.map(message => message.role)).toEqual(["compactionSummary", "assistant"]);
		expect(textOf(entry(manager, a3))).toBe(`a3 ${BODY}`);
		expect(Object.getOwnPropertyDescriptor(messageOf(entry(manager, a3)), "content")?.get).toBeUndefined();

		// Back on the older compaction's branch, its kept entries are whole again;
		// a3 and c2, off the current path after the move, are cold with u1 and a1.
		manager.branch("a2");
		manager.buildSessionContext();
		expect(manager.coldStoreStats().coldEntries).toBe(4);
	});

	it("returns frozen values from a cold body, so a nested write fails loudly", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		const content = contentOf(entry(manager, "a1")) as TextContent[];

		expect(() => {
			content[0]!.text = "changed";
		}).toThrow(TypeError);
		expect(() => content.push({ type: "text", text: "more" })).toThrow(TypeError);
		expect(textOf(entry(manager, "a1"))).toBe(`a1 ${BODY}`);
	});

	it("makes a cold entry whole when one of its fields is assigned, and persists the write", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const file = await writeSession(dir.path());
		const manager = await open(file);
		const a1 = entry(manager, "a1");
		const message = messageOf(a1);
		if (message.role !== "assistant") throw new Error("expected an assistant message");

		message.content = [{ type: "text", text: "replaced" }];
		const stats = manager.coldStoreStats();
		expect(stats.coldEntries).toBe(1);
		expect(stats.hydrations).toBeGreaterThanOrEqual(1);
		expect(messageOf(entry(manager, "a1"))).toBe(message);
		(message.content[0] as TextContent).text = "edited in place";
		expect(message.usage.totalTokens).toBe(2);

		await manager.rewriteEntries();
		await manager.close();
		const reopened = await open(file, false);
		expect(textOf(entry(reopened, "a1"))).toBe("edited in place");
		expect(textOf(entry(reopened, "u1"))).toBe(`u1 ${BODY}`);
	});

	// Late usage lands on every turn's branch; a build after it must not walk every entry again for a cut that did not move.
	it("does not compute the cut again at the next build after a usage record appended off the current leaf", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));
		manager.buildSessionContext();
		// A write makes a1 whole; it goes back to the store when the cut is applied again, or at a recool.
		const message = messageOf(entry(manager, "a1"));
		if (message.role !== "assistant") throw new Error("expected an assistant message");
		message.content = [{ type: "text", text: `rewritten ${BODY}` }];
		expect(manager.coldStoreStats().coldEntries).toBe(1);

		const recorded = manager.appendModelUsage(
			{
				purpose: "title",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				usage: usage(),
				stopReason: "stop",
			},
			{ sessionId: manager.getSessionId(), parentId: "u2" },
		);
		expect(recorded).toBeDefined();
		expect(manager.getLeafId()).toBe("a2");
		manager.buildSessionContext();
		expect(manager.coldStoreStats().coldEntries).toBe(1);

		// Control: the entry belongs in the store, so applying the cut would have cooled it.
		manager.recoolEntries();
		expect(manager.coldStoreStats().coldEntries).toBe(2);
	});

	it("applies updateEntryBody to a cold entry's nested values and keeps the entry cold", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const manager = await open(await writeSession(dir.path()));

		manager.updateEntryBody("a1", target => {
			const content = contentOf(target) as TextContent[];
			content[0]!.text = `updated ${BODY}`;
		});

		expect(textOf(entry(manager, "a1"))).toBe(`updated ${BODY}`);
		expect(manager.coldStoreStats().coldEntries).toBe(2);
	});

	it("lets a clone read cold entries after the original manager is released", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		let original: SessionManager | undefined = await open(await writeSession(dir.path()));
		const clone = original.cloneCurrentSession({ persist: false });
		original.releaseRetainedEntries();
		original = undefined;
		await collectGarbage(() => false, 3);

		expect(clone.coldStoreStats().coldEntries).toBe(2);
		expect(textOf(entry(clone, "u1"))).toBe(`u1 ${BODY}`);
		expect(textOf(entry(clone, "a1"))).toBe(`a1 ${BODY}`);
	});

	it.skipIf(!HAS_PROC_FD)(
		"leaves no store file in the directory and closes its descriptor once the last cold entry is gone",
		async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const file = await writeSession(dir.path());
			const before = coldStoreDescriptors();

			const opened = async (): Promise<string[]> => {
				const manager = await open(file);
				expect(manager.coldStoreStats().coldEntries).toBe(2);
				const added = [...coldStoreDescriptors()].filter(([fd, target]) => before.get(fd) !== target);
				expect(added).toHaveLength(1);
				const [fd, target] = added[0]!;
				expect(target.endsWith(" (deleted)")).toBe(true);
				expect(fs.readdirSync(COLD_DIR)).not.toContain(path.basename(target.replace(/ \(deleted\)$/, "")));
				manager.releaseRetainedEntries();
				return [fd, target];
			};
			const [fd, target] = await opened();

			const stillOpen = () => coldStoreDescriptors().get(fd) === target;
			await collectGarbage(() => !stillOpen());
			expect(stillOpen()).toBe(false);
		},
	);

	it.skipIf(!HAS_PROC_FD)(
		"opens its store in a directory of the account's own that no other account can enter",
		async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			using tmp = TempDir.createSync("@omp-cold-tmpdir-");
			const file = await writeSession(dir.path());
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
			const coldDir = coldDirIn(tmp.path());

			const manager = await open(file);
			expect(manager.coldStoreStats().coldEntries).toBe(2);
			expect(coldStoreDescriptors(coldDir).size).toBe(1);
			expect(fs.statSync(coldDir).mode & 0o777).toBe(0o700);
			expect(textOf(entry(manager, "u1"))).toBe(`u1 ${BODY}`);
		},
	);

	it("shares one runtime object among the loaded entries a source checkout wrote", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const runtime: RuntimeIdentity = {
			version: "18.18.6",
			commit: "0123456789abcdef0123456789abcdef01234567",
			branch: "feature/session-memory",
		};
		const manager = await open(await writeSession(dir.path(), runtime));

		// u1 and a1 are cold, u2 and a2 whole.
		const runtimes = ["u1", "a1", "u2", "a2"].map(id => entry(manager, id).runtime);
		expect(runtimes[0]).toEqual(runtime);
		for (const shared of runtimes) expect(shared).toBe(runtimes[0]);
	});

	// /resume --from-claude persists an imported in-memory session; that live session must still free older bodies.
	it("cools the entries before the cut of a copy persisted from an in-memory session", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		const source = SessionManager.inMemory(dir.path());
		source.appendMessage({ role: "user", content: `u1 ${BODY}`, timestamp: 1 });
		source.appendMessage(assistant(`a1 ${BODY}`));
		const u2 = source.appendMessage({ role: "user", content: `u2 ${BODY}`, timestamp: 3 });
		source.appendCompaction(`c1 ${BODY}`, undefined, u2, 1000);
		source.appendMessage(assistant(`a2 ${BODY}`));
		expect(source.coldStoreStats().coldEntries).toBe(0);

		const copy = await source.persistCopy(
			{ sessionDir: path.join(dir.path(), "sessions"), suppressBreadcrumb: true },
			new FileSessionStorage(),
		);
		try {
			expect(copy.buildSessionContext().messages.map(message => message.role)).toEqual([
				"compactionSummary",
				"user",
				"assistant",
			]);
			expect(copy.coldStoreStats().coldEntries).toBe(2);
		} finally {
			await copy.close();
		}
	});

	// bash detach on /delete keeps a clone of the dropped session; closing both must free the store's disk now.
	it.skipIf(!HAS_PROC_FD)(
		"closes the store once the manager and a clone made without persistence are both closed",
		async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			using tmp = TempDir.createSync("@omp-cold-tmpdir-");
			const file = await writeSession(dir.path());
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
			const coldDir = coldDirIn(tmp.path());

			const manager = await open(file);
			const clone = manager.cloneCurrentSession({ persist: false });
			expect(clone.coldStoreStats().coldEntries).toBe(2);
			expect(coldStoreDescriptors(coldDir).size).toBe(1);
			await manager.close();
			expect(coldStoreDescriptors(coldDir).size).toBe(1);
			await clone.close();
			expect(coldStoreDescriptors(coldDir).size).toBe(0);
		},
	);

	// If this regresses, a session where the platform gives no account id (Windows) writes its older
	// entries unmasked to a file under the temporary directory, which takes that directory's access list,
	// and no directory owner can be checked against an account id there.
	it("keeps older entries compressed in memory without an account id, making no file under the temporary directory", async () => {
		using dir = TempDir.createSync("@omp-cold-entries-");
		using tmp = TempDir.createSync("@omp-cold-tmpdir-");
		const file = await writeSession(dir.path());
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
		withoutAccountId();

		const manager = await open(file);
		try {
			const { coldEntries, storeInMemory } = manager.coldStoreStats();
			expect({
				coldEntries,
				storeInMemory,
				underTmp: fs.readdirSync(tmp.path()),
				u1: textOf(entry(manager, "u1")),
			}).toEqual({ coldEntries: 2, storeInMemory: true, underTmp: [], u1: `u1 ${BODY}` });
		} finally {
			await manager.close();
		}
	});

	// If this regresses, a record read after its store closed reads the store's descriptor number, which
	// the process can have given to another file since, and parses that file's bytes as the entry.
	it.skipIf(process.getuid === undefined)("refuses a read of a record from its file once the store closed", () => {
		using tmp = TempDir.createSync("@omp-cold-closed-");
		const store = ColdEntryStore.open(new BlobStore(tmp.join("blobs")));
		const record = store.append(Buffer.from(JSON.stringify({ type: "custom", id: "c1", data: BODY })));
		const before = store.parse(record, false);
		store.close();

		expect({ inMemory: store.inMemory, before }).toEqual({
			inMemory: false,
			before: { type: "custom", id: "c1", data: BODY },
		});
		expect(() => store.parse(record, false)).toThrow("read after its session closed");
	});

	// If this regresses, a store kept in memory puts a large tool result in one block with the records
	// before it, and each read of one of those records decompresses the large one with it.
	it("gives a record larger than a batch a block of its own, so a read of the record before it decompresses only that one", () => {
		using tmp = TempDir.createSync("@omp-cold-batch-");
		withoutAccountId();
		const store = ColdEntryStore.open(new BlobStore(tmp.join("blobs")));
		try {
			const user = (id: string, content: string): SessionEntry => ({
				type: "message",
				id,
				parentId: null,
				timestamp: TIMESTAMP,
				message: { role: "user", content, timestamp: 1 },
			});
			const small = user("small", `small ${BODY}`);
			const large = user("large", "z".repeat(2 * 1024 * 1024));
			const after = user("after", `after ${BODY}`);
			const recordBytes = [small, large].map(record => Buffer.byteLength(JSON.stringify(record)));
			const compress = vi.spyOn(Bun, "zstdCompressSync");
			const decompress = vi.spyOn(Bun, "zstdDecompressSync");
			for (const record of [small, large, after]) {
				expect(convertToColdEntry(record, () => store, { imagesExternalized: true })).toBe(true);
			}

			const smallText = textOf(small);
			const decompressedForSmall = decompress.mock.results.map(result => (result.value as Uint8Array).byteLength);
			expect({
				store: store.inMemory,
				blocks: compress.mock.calls.map(([data]) => Buffer.byteLength(data)),
				decompressedForSmall,
				smallText,
				largeLength: textOf(large).length,
				afterText: textOf(after),
			}).toEqual({
				store: true,
				blocks: recordBytes,
				decompressedForSmall: [recordBytes[0]],
				smallText: `small ${BODY}`,
				largeLength: 2 * 1024 * 1024,
				afterText: `after ${BODY}`,
			});
		} finally {
			store.close();
		}
	});

	describe("full rewrites of entries with images", () => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		let agentDir: TempDir;

		beforeEach(() => {
			agentDir = TempDir.createSync("@omp-cold-agent-");
			setAgentDir(agentDir.path());
		});

		afterEach(() => {
			if (originalAgentDir) {
				setAgentDir(originalAgentDir);
			} else {
				setAgentDir(path.join(getConfigRootDir(), "agent"));
				delete process.env.PI_CODING_AGENT_DIR;
			}
			agentDir.removeSync();
		});

		/**
		 * Compact after a new reply, with ids and clock fixed so two runs append the
		 * same entries: the cut moves to that reply, and `u2` to `u4`, whole in
		 * memory until now, go cold, `u1` and `a1` already being so.
		 */
		function compactDuringSession(manager: SessionManager): void {
			let uuids = 0;
			vi.spyOn(crypto, "randomUUID").mockImplementation(
				() => `00000000-0000-4000-8000-${(++uuids).toString(16).padStart(12, "0")}`,
			);
			setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
			try {
				const a4 = manager.appendMessage(assistant(`a4 ${BODY}`));
				manager.appendCompaction(`c2 ${BODY}`, undefined, a4, 2000);
				manager.buildSessionContext();
			} finally {
				setSystemTime();
				vi.restoreAllMocks();
			}
		}

		it("write the bytes a manager holding every entry writes, images and cut text included", async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const images = storeImages();
			const file = await writeImageSession(dir.path(), images);
			const original = await Bun.file(file).bytes();
			const rewrite = async (coldStore: boolean): Promise<{ coldEntries: number; text: string }> => {
				await Bun.write(file, original);
				const manager = await open(file, coldStore);
				compactDuringSession(manager);
				const { coldEntries } = manager.coldStoreStats();
				await manager.rewriteEntries();
				await manager.close();
				return { coldEntries, text: await Bun.file(file).text() };
			};

			const withStore = await rewrite(true);
			const withoutStore = await rewrite(false);
			expect(withStore.coldEntries).toBe(8);
			expect(withoutStore.coldEntries).toBe(0);
			expect(withStore.text).toBe(withoutStore.text);
			for (const image of images) expect(withStore.text).toContain(image.ref);
			expect(withStore.text).toContain(SIGNED_IMAGE);
			expect(withStore.text.split(TRUNCATION_NOTICE)).toHaveLength(3);
		});

		it("leave the images of cold entries as blob references, reading and storing none of them again", async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const images = storeImages();
			const manager = await open(await writeImageSession(dir.path(), images));
			compactDuringSession(manager);
			expect(manager.coldStoreStats().coldEntries).toBe(8);

			const reads = vi.spyOn(BlobStore.prototype, "getSync");
			const stores = vi.spyOn(BlobStore.prototype, "putSync");
			await manager.rewriteEntries();
			const hashes = new Set(images.map(image => image.hash));
			expect(reads.mock.calls.filter(([hash]) => hashes.has(hash))).toEqual([]);
			expect(stores.mock.calls.filter(([data]) => images.some(image => data.equals(image.bytes)))).toEqual([]);
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a session file");
			const text = await Bun.file(file).text();
			for (const image of images) expect(text).toContain(image.ref);
			await manager.close();
		});

		// If this regresses, every resume reads the images of every cold tool result a prune or patch
		// record names, which the record then replaces, until a full rewrite folds the records in.
		it("apply at a resume the prune and patch records of cold tool results without reading their images", async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const images = storeImages();
			const file = await writeToolResultSession(dir.path(), images, [R1_PRUNE, R2_PATCH]);
			const reads = vi.spyOn(BlobStore.prototype, "getSync");

			const manager = await open(file);
			try {
				const hashes = new Set(images.map(image => image.hash));
				const imageReads = reads.mock.calls.filter(([hash]) => hashes.has(hash));
				const r1 = messageOf(entry(manager, "r1"));
				const r2 = messageOf(entry(manager, "r2"));
				expect({
					imageReads,
					cold: ["r1", "r2"].map(id => isColdEntry(entry(manager, id))),
					r1: r1.role === "toolResult" ? { content: r1.content, prunedAt: r1.prunedAt } : undefined,
					r2: r2.role === "toolResult" ? r2.content : undefined,
				}).toEqual({
					imageReads: [],
					cold: [true, true],
					r1: { content: [{ type: "text", text: "[r1 pruned]" }], prunedAt: 7 },
					r2: [{ type: "text", text: "r2 patched" }],
				});
			} finally {
				await manager.close();
			}
		});

		// If this regresses, a session whose previous process, or another writer, appends a prune record
		// reads the images of the cold tool result the record names, which the record then replaces.
		it("apply a prune record another writer appends to a cold tool result without reading its image", async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const images = storeImages();
			const file = await writeToolResultSession(dir.path(), images);
			const manager = await open(file);
			try {
				const coldBefore = isColdEntry(entry(manager, "r1"));
				const prune = { ...R1_PRUNE, parentId: "a3", timestamp: TIMESTAMP };
				fs.appendFileSync(file, `${JSON.stringify(prune)}\n`);
				const reads = vi.spyOn(BlobStore.prototype, "getSync");
				// This manager's next append finds the record past what it wrote, and keeps it.
				manager.appendMessage({ role: "user", content: "next", timestamp: 4 });
				await manager.flush();

				const hashes = new Set(images.map(image => image.hash));
				const r1 = messageOf(entry(manager, "r1"));
				expect({
					coldBefore,
					adopted: manager.getEntry(R1_PRUNE.id) !== undefined,
					imageReads: reads.mock.calls.filter(([hash]) => hashes.has(hash)),
					coldAfter: isColdEntry(entry(manager, "r1")),
					r1: r1.role === "toolResult" ? { content: r1.content, prunedAt: r1.prunedAt } : undefined,
				}).toEqual({
					coldBefore: true,
					adopted: true,
					imageReads: [],
					coldAfter: true,
					r1: { content: [{ type: "text", text: "[r1 pruned]" }], prunedAt: 7 },
				});
			} finally {
				await manager.close();
			}
		});
	});

	describe("records read back with their images", () => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		let agentDir: TempDir;

		beforeEach(() => {
			agentDir = TempDir.createSync("@omp-cold-agent-");
			setAgentDir(agentDir.path());
		});

		afterEach(() => {
			if (originalAgentDir) {
				setAgentDir(originalAgentDir);
			} else {
				setAgentDir(path.join(getConfigRootDir(), "agent"));
				delete process.env.PI_CODING_AGENT_DIR;
			}
			agentDir.removeSync();
		});

		// One loop over older screenshots must not keep eight resolved images in memory.
		it("are kept no more than the cache bound holds, counted with their images resolved", async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const cacheBytes = 16 * 1024 * 1024;
			const blobs = new BlobStore(getBlobsDir());
			const imageBytes = 3 * 1024 * 1024;
			const ids = Array.from({ length: 8 }, (_, index) => `u${index}`);
			const screenshots = ids.map((id, index): FixtureRecord => {
				const { ref } = blobs.putSync(Buffer.alloc(imageBytes, index + 1), { extension: "png" });
				return {
					type: "message",
					id,
					message: {
						role: "user",
						content: [
							{ type: "text", text: `${id} screenshot` },
							{ type: "image", data: ref, mimeType: "image/png" },
						],
						timestamp: 1,
					},
				};
			});
			const file = await writeTranscript(dir.path(), [
				...screenshots,
				{ type: "message", id: "keep", message: { role: "user", content: "keep", timestamp: 2 } },
				{ type: "compaction", id: "c1", summary: "summary", firstKeptEntryId: "keep", tokensBefore: 1000 },
			]);
			const manager = await open(file);
			try {
				expect(manager.coldStoreStats().coldEntries).toBe(8);
				const readAll = (): void => {
					for (const id of ids) {
						const content = contentOf(entry(manager, id));
						expect(Array.isArray(content) ? content.length : 0).toBe(2);
					}
				};
				readAll();
				const afterFirstPass = manager.coldStoreStats().materializations;
				readAll();
				// Each record holds a reference in the store but its whole image once read.
				const resolvedBytes = Math.ceil(imageBytes / 3) * 4;
				const fitting = Math.floor(cacheBytes / resolvedBytes);
				expect(manager.coldStoreStats().materializations - afterFirstPass).toBeGreaterThanOrEqual(
					ids.length - fitting,
				);
			} finally {
				await manager.close();
			}
		});

		// A record is frozen once read: the tier pass that restores its image later must not write into it.
		it("give an image only the blob tier holds once the tier has restored it, writing nothing into a read record", async () => {
			using dir = TempDir.createSync("@omp-cold-entries-");
			const bytes = Buffer.alloc(3000, 9);
			const hash = new Bun.SHA256().update(bytes).digest("hex");
			const ref = `blob:sha256:${hash}`;
			const tierRead = Promise.withResolvers<void>();
			const tier: SessionBlobTier = {
				store: () => {},
				sizes: async hashes => new Map(hashes.filter(name => name === hash).map(name => [name, bytes.length])),
				read: async (hashes, visit) => {
					for (const name of hashes) if (name === hash) await visit(name, bytes);
					tierRead.resolve();
				},
				repair: async () => 0,
				reference: async () => {},
				sweep: async () => ({ candidates: 0, deleted: 0, bytes: 0 }),
			};
			const store = ColdEntryStore.open(new BlobStore(dir.path(), tier));
			if (!store) throw new Error("the store did not open");
			const warn = vi.spyOn(logger, "warn");
			try {
				const cold: SessionEntry = {
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: TIMESTAMP,
					message: {
						role: "user",
						content: [
							{ type: "text", text: "look" },
							{ type: "image", data: ref, mimeType: "image/png" },
						],
						timestamp: 1,
					},
				};
				expect(convertToColdEntry(cold, () => store, { imagesExternalized: true })).toBe(true);
				const image = (): string | undefined => {
					const message = messageOf(cold);
					if (message.role !== "user" || typeof message.content === "string") return undefined;
					return message.content.find((block): block is ImageContent => block.type === "image")?.data;
				};

				expect(image()).toBe(ref);
				await tierRead.promise;
				// One event-loop turn: what the pass does after the tier's read runs in microtasks.
				await Bun.sleep(0);
				expect(image()).toBe(bytes.toString("base64"));
				expect(store.materializations).toBe(2);
				expect(warn.mock.calls.map(call => call[0])).not.toContain(
					"Restoring the missing blobs of adopted session entries failed",
				);
			} finally {
				warn.mockRestore();
				store.close();
			}
		});
	});
});
