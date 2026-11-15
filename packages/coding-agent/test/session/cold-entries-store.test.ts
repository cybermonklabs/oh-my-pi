import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { RuntimeIdentity } from "@oh-my-pi/pi-coding-agent/session/runtime-identity";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getBlobsDir, getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
/** This account's store directory under `tmp`. */
function coldDirIn(tmp: string): string {
	const uid = process.getuid?.();
	return path.join(tmp, uid === undefined ? "omp-cold" : `omp-cold-${uid}`);
}
const COLD_DIR = coldDirIn(os.tmpdir());

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

/**
 * A session whose compaction keeps `u2` on: `u1` and `a1` lie before the cut,
 * and so does `m1`, a model change, which stays whole by kind. Its id is the
 * directory's name, so no two tests share a session (a manager another test
 * left open keeps its writer claim on its session).
 */
async function writeSession(dir: string, runtime?: RuntimeIdentity): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	const id = path.basename(dir);
	const header: SessionHeader = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: dir };
	const entries = [
		header,
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: `u1 ${BODY}`, timestamp: 1 },
		},
		{ type: "model_change", id: "m1", parentId: "u1", timestamp, model: "anthropic/claude-sonnet-4-20250514" },
		{ type: "message", id: "a1", parentId: "m1", timestamp, message: assistant(`a1 ${BODY}`) },
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp,
			message: { role: "user", content: `u2 ${BODY}`, timestamp: 3 },
		},
		{
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "u2",
			tokensBefore: 1000,
		},
		{ type: "message", id: "a2", parentId: "c1", timestamp, message: assistant(`a2 ${BODY}`) },
	];
	const lines = entries.map(record => JSON.stringify(runtime && record !== header ? { ...record, runtime } : record));
	await Bun.write(file, lines.map(line => `${line}\n`).join(""));
	return file;
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
async function writeImageSession(dir: string, images: [StoredImage, StoredImage]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const timestamp = "2026-01-01T00:00:00.000Z";
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp,
		cwd: dir,
	};
	const user = (id: string, parentId: string | null, image?: StoredImage) => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: {
			role: "user",
			content: [
				{ type: "text", text: `${id} ${BODY}` },
				...(image ? [{ type: "image", data: image.ref, mimeType: "image/png" }] : []),
			],
			timestamp: 1,
		},
	});
	const reply = (id: string, parentId: string, text = BODY) => ({
		type: "message",
		id,
		parentId,
		timestamp,
		message: assistant(`${id} ${text}`),
	});
	const compaction = (id: string, parentId: string, firstKeptEntryId: string) => ({
		type: "compaction",
		id,
		parentId,
		timestamp,
		summary: `${id} ${BODY}`,
		firstKeptEntryId,
		tokensBefore: 1000,
	});
	const entries = [
		header,
		user("u1", null, images[0]),
		reply("a1", "u1", UNCUT_TEXT),
		user("u2", "a1"),
		compaction("c1", "u2", "u2"),
		{
			...reply("a2", "c1"),
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
		user("u3", "a2", images[1]),
		reply("a3", "u3", UNCUT_TEXT),
		user("u4", "a3"),
	];
	await Bun.write(file, entries.map(record => `${JSON.stringify(record)}\n`).join(""));
	return file;
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

		// Back on the older compaction's branch, its kept entries are whole again.
		manager.branch("a2");
		manager.buildSessionContext();
		expect(manager.coldStoreStats().coldEntries).toBe(2);
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

	it.skipIf(!fs.existsSync("/proc/self/fd"))(
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

	it.skipIf(!fs.existsSync("/proc/self/fd"))(
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
	});
});
