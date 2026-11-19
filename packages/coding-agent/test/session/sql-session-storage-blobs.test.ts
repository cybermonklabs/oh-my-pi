/**
 * Under SQL session storage a blob a session references and cannot draw
 * again is kept in `<table>_blobs` as well as in the local blob store, so a
 * session resumed where that store is gone (a new machine, a new pod) gets
 * its images back. A blob lands, outside every session's write fence, before
 * the transcript write that names it. Snapcompact frames stay out of the
 * table: their archive's text draws them again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	loadSessionMessagesReadOnly,
	resolveBlobRefsInEntriesSync,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, getBlobsDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { SQL } from "bun";
import {
	type GatedClient,
	gatedClient,
	LEASE_BACKENDS,
	type LeaseDb,
	openLeaseDb,
	ROW_LEASE_BACKENDS,
	rejection,
	transcript,
	until,
} from "./sql-session-lease-fixture";

const ID = "01a1f400-0000-7000-8000-000000000001";
/** An image payload long enough for persistence to put it in the blob store. */
const IMAGE_BYTES = Buffer.alloc(4096, 7);
const IMAGE = IMAGE_BYTES.toString("base64");
const IMAGE_HASH = sha256(IMAGE_BYTES);
const BLOB_REF = /blob:sha256:([0-9a-f]{64})/g;
/** A blob row's insert (not start-up's privilege probe, `INSERT … SELECT … WHERE 1 = 0`), whatever the dialect quotes its table name with. */
const BLOB_INSERT = /^INSERT INTO \S*_blobs \([^)]*\) VALUES/;
/** A reference row's insert, whatever the dialect quotes its table name with. */
const REF_INSERT = /^INSERT INTO \S*_refs\b/;
/** The drop of one session path's reference rows (not a sweep's, nor the drop of those under a directory). */
const REF_DELETE = /^DELETE FROM \S*_refs WHERE path = /;
/** A write's shared lock on the blob rows it names, before it touches the reference table. */
const BLOB_SHARE_LOCK = /^SELECT sha256 FROM \S*_blobs WHERE .* (?:FOR SHARE|LOCK IN SHARE MODE)$/;
/** An exclusive lock on blob rows. */
const BLOB_EXCLUSIVE_LOCK = /^SELECT sha256 FROM \S*_blobs WHERE .* FOR UPDATE$/;
/** A lease whose heartbeat stays out of the way, so the write's fence is what finds another holder. */
const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

function sha256(data: Buffer): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function imageTurn(text: string) {
	return {
		role: "user" as const,
		content: [
			{ type: "text" as const, text },
			{ type: "image" as const, data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 1,
	};
}

/** `client`, whose first `times` statements `pattern` matches fail as a reset connection does. */
function failing(client: SqlSessionStorageClient, pattern: RegExp, times: number): SqlSessionStorageClient {
	let failed = 0;
	const check = (query: string): void => {
		if (failed >= times || !pattern.test(query)) return;
		failed++;
		throw new Error("Connection reset by peer (injected)");
	};
	const wrap = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		async unsafe(query, values) {
			check(query);
			return executor.unsafe(query, values);
		},
	});
	return {
		options: client.options,
		async unsafe(query, values) {
			check(query);
			return client.unsafe(query, values);
		},
		transaction: callback => client.transaction(transaction => callback(wrap(transaction))),
		end: () => client.end?.() ?? Promise.resolve(),
	};
}

async function blobHashes(db: LeaseDb): Promise<string[]> {
	return (await db.sql(`SELECT sha256 FROM ${db.table}_blobs`)).map(row => String(row.sha256)).sort();
}

/** The image's blob row's `created_ms`: a row deleted and landed again gets a new one. */
async function blobCreatedMs(db: LeaseDb): Promise<number> {
	const [row] = await db.sql(`SELECT created_ms FROM ${db.table}_blobs WHERE sha256 = @1`, [IMAGE_HASH]);
	return Number(row?.created_ms);
}

/** `size` bytes of an image, distinct for each `seed`. */
function imageBytes(seed: number, size = 4096): Buffer {
	const data = Buffer.alloc(size);
	for (let index = 0; index < size; index++) data[index] = (index * 31 + seed * 17) % 251;
	return data;
}

/** A closed session, written through `storage`, whose one user turn carries `images`; answers its file. */
async function writeImageSession(db: LeaseDb, storage: SqlSessionStorage, images: readonly Buffer[]): Promise<string> {
	const manager = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), storage);
	manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "look" },
			...images.map(data => ({ type: "image" as const, data: data.toString("base64"), mimeType: "image/png" })),
		],
		timestamp: 1,
	});
	manager.appendMessage(assistant("seen"));
	await manager.flush();
	const file = manager.getSessionFile() ?? "";
	await manager.close();
	return file;
}

/** The data of every image block in `manager`'s user turns: base64, or the reference when it did not resolve. */
function imagesOf(manager: SessionManager): string[] {
	return manager
		.getEntries()
		.flatMap(entry =>
			entry.type === "message" && entry.message.role === "user" && typeof entry.message.content !== "string"
				? entry.message.content.filter((block): block is ImageContent => block.type === "image")
				: [],
		)
		.map(block => block.data);
}

function assistant(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

/** A snapcompact archive whose frames are large enough to go to the blob store. */
async function frameArchive(): Promise<snapcompact.Archive> {
	const result = await snapcompact.compact(
		{
			firstKeptEntryId: "kept",
			messagesToSummarize: [
				{ role: "user", content: `Head. ${"An archived fact. ".repeat(500)}Tail.`, timestamp: 0 },
			],
			turnPrefixMessages: [],
			tokensBefore: 1000,
			previousSummary: undefined,
			previousPreserveData: undefined,
			fileOps: snapcompact.createFileOps(),
		},
		{ model: { api: "anthropic-messages" }, frameSize: 320, maxFrames: 4 },
	);
	const archive = snapcompact.getPreservedArchive(result.preserveData);
	if (!archive) throw new Error("Expected a snapcompact archive");
	return archive;
}

/** The image block's data of the user turn `entryId`: its base64, or the reference when it did not resolve. */
function imageData(manager: SessionManager, entryId: string): string | undefined {
	const entry = manager.getEntry(entryId);
	if (entry?.type !== "message" || entry.message.role !== "user" || typeof entry.message.content === "string") {
		throw new Error(`Expected the user turn ${entryId}`);
	}
	return entry.message.content.find((block): block is ImageContent => block.type === "image")?.data;
}

/** A session with an image turn and a snapcompact compaction, written through `db`'s store and closed. */
async function writeSession(db: LeaseDb): Promise<{ sessionFile: string; sessionDir: string; userId: string }> {
	const sessionDir = db.dir.join("sessions");
	const manager = SessionManager.create(db.dir.join("project"), sessionDir, await db.open());
	const userId = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "look" },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 1,
	});
	manager.appendMessage(assistant("seen"));
	manager.appendCompaction("summary", undefined, userId, 1000, {
		preserveData: { [snapcompact.PRESERVE_KEY]: await frameArchive() },
	});
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	await manager.close();
	return { sessionFile, sessionDir, userId };
}

describe("session blobs in the SQL session storage", () => {
	const originalAgentDir = getAgentDir();
	let agentDir: TempDir | undefined;

	beforeEach(() => {
		agentDir = TempDir.createSync("@omp-sql-blobs-agent-");
		setAgentDir(agentDir.path());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		agentDir?.removeSync();
	});

	for (const { adapter, url } of LEASE_BACKENDS) {
		describe.skipIf(!url)(adapter, () => {
			it("keeps an image block's blob in the table and no frame's, and a resume without the blob store gets the image back", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir, userId } = await writeSession(db);
				const imageHash = sha256(IMAGE_BYTES);

				const rows = await db.sql(`SELECT sha256, byte_len, mime_type FROM ${db.table}_blobs`);
				expect(rows.map(row => [String(row.sha256), Number(row.byte_len), row.mime_type])).toEqual([
					[imageHash, IMAGE_BYTES.byteLength, "image/png"],
				]);
				// The frames went to the blob store too, and none of them to the table.
				const refs = new Set([...((await db.row(sessionFile))?.content ?? "").matchAll(BLOB_REF)].map(m => m[1]));
				expect(refs.has(imageHash)).toBe(true);
				expect(refs.size).toBeGreaterThan(1);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(resumed, userId)).toBe(IMAGE);
				expect(await Bun.file(path.join(getBlobsDir(), imageHash)).exists()).toBe(true);
				await resumed.close();

				// Control: without the row, and the blob store gone again, the image stays a reference.
				await db.sql(`DELETE FROM ${db.table}_blobs`);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const bare = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(bare, userId)).toBe(`blob:sha256:${imageHash}`);
				await bare.close();
			});

			it("restores no row whose bytes do not hash to its key", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir, userId } = await writeSession(db);
				const imageHash = sha256(IMAGE_BYTES);
				await db.sql(`UPDATE ${db.table}_blobs SET content = @1 WHERE sha256 = @2`, [
					Buffer.from("not the image"),
					imageHash,
				]);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const warn = vi.spyOn(logger, "warn");

				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(resumed, userId)).toBe(`blob:sha256:${imageHash}`);
				expect(await Bun.file(path.join(getBlobsDir(), imageHash)).exists()).toBe(false);
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("does not hash to its key"),
					expect.objectContaining({ hash: imageHash }),
				);
				await resumed.close();
			});

			it("lands a blob whose first two writes fail, so a resume elsewhere still gets the image", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const sessionDir = db.dir.join("sessions");
				const storage = await db.open({ wrap: client => failing(client, BLOB_INSERT, 2) });
				const manager = SessionManager.create(db.dir.join("project"), sessionDir, storage);
				const userId = manager.appendMessage(imageTurn("look"));
				manager.appendMessage(assistant("seen"));
				await manager.flush();
				const sessionFile = manager.getSessionFile() ?? "";
				await manager.close();
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(resumed, userId)).toBe(IMAGE);
				await resumed.close();
			});

			it("writes back, when a session opens, a blob this machine holds and the table lacks", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir, userId } = await writeSession(db);
				// A row that never landed: a session written before the table, or by an older omp.
				await db.sql(`DELETE FROM ${db.table}_blobs`);
				const reopened = await SessionManager.open(sessionFile, sessionDir, await db.open());
				reopened.appendMessage(assistant("again"));
				await reopened.flush();
				await reopened.close();
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(resumed, userId)).toBe(IMAGE);
				await resumed.close();
			});

			it("gives the read-only loader an image the local blob store lacks, from the table, and writes nothing back", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile } = await writeSession(db);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				await db.sql(`DELETE FROM ${db.table}_blobs WHERE sha256 <> @1`, [IMAGE_HASH]);

				const messages = await loadSessionMessagesReadOnly(sessionFile, await db.open());
				const images = messages.flatMap(message =>
					message.role === "user" && typeof message.content !== "string"
						? message.content.filter((block): block is ImageContent => block.type === "image")
						: [],
				);
				expect(images.map(image => image.data)).toEqual([IMAGE]);
				expect(JSON.stringify(messages)).not.toContain("unavailable here");
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
			});

			it("reads blobs back in batches of at most 16 MiB", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const queries: string[] = [];
				const storage = await db.open({ wrap: client => recordingClient(client, queries) });
				const blobs = [1, 2, 3].map(fill => Buffer.alloc(6 * 1024 * 1024, fill));
				for (const data of blobs) storage.blobTier?.store(sha256(data), data, "image/png");
				await storage.drain();
				queries.length = 0;

				const seen: string[] = [];
				await storage.blobTier?.read(blobs.map(sha256), async (hash, data) => {
					expect(sha256(data)).toBe(hash);
					seen.push(hash);
				});
				expect(seen.sort()).toEqual(blobs.map(sha256).sort());
				// 6 + 6 MiB in one read; the third would pass 16 MiB, so it goes in a second.
				expect(queries.filter(query => query.includes("SELECT sha256, content, byte_len FROM"))).toHaveLength(2);
			});

			it("keeps a blob another session names when a session naming it is deleted, even one written before the reference table", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				// Control: a session written with its reference row keeps the blob when another session naming it goes.
				const storage = await db.open();
				const referenced = await writeImageSession(db, storage, [IMAGE_BYTES]);
				await storage.unlink(await writeImageSession(db, storage, [IMAGE_BYTES]));
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				await storage.unlink(referenced);
				expect(await blobHashes(db)).toEqual([]);

				// A session written before the reference table: its image only on this machine, no row, no reference.
				const written = await writeImageSession(db, storage, [IMAGE_BYTES]);
				await db.sql(`DELETE FROM ${db.table}_refs`);
				await db.sql(`DELETE FROM ${db.table}_blobs`);
				// Opening it writes the image back, and its reference with it.
				const store = await db.open();
				const opened = await SessionManager.open(written, path.dirname(written), store);
				await opened.close();
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				// A fork of it, naming the same image, is written and deleted.
				await store.unlink(await writeImageSession(db, store, [IMAGE_BYTES]));
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(written, path.dirname(written), await db.open());
				expect(imagesOf(resumed)).toEqual([IMAGE]);
				await resumed.close();
			});

			for (const suffix of ["blobs", "refs"] as const) {
				it.skipIf(adapter !== "postgres")(
					`refuses to start on a ${suffix} table that is an inheritance child or a partition`,
					async () => {
						await using db = await openLeaseDb(adapter, url ?? "");
						await (await db.open()).drain();
						const table = `${db.table}_${suffix}`;
						const columns =
							suffix === "blobs"
								? "sha256 text NOT NULL, content bytea NOT NULL, byte_len bigint NOT NULL, mime_type text, created_ms bigint NOT NULL"
								: "path text NOT NULL, sha256 text NOT NULL";
						const key = suffix === "blobs" ? "sha256" : "path, sha256";
						// The reference table's index goes with it, so each case's only problem is its parent.
						const index = suffix === "refs" ? `CREATE INDEX ${db.table}_rhash ON ${table} (sha256)` : undefined;
						try {
							// The table as the store declares it, but a child of another table.
							await db.sql(`DROP TABLE ${table}`);
							await db.sql(`CREATE TABLE ${table}_parent (${columns})`);
							await db.sql(
								`CREATE TABLE ${table} (${columns}, PRIMARY KEY (${key})) INHERITS (${table}_parent)`,
							);
							if (index) await db.sql(index);
							expect(String(await rejection(db.open({ createTable: false })))).toMatch(
								new RegExp(`${table} inherits from \\S*${table}_parent\\b`),
							);

							// The table as the store declares it, but a partition of another table.
							await db.sql(`DROP TABLE ${table}`);
							await db.sql(`DROP TABLE ${table}_parent`);
							await db.sql(`CREATE TABLE ${table}_parent (${columns}) PARTITION BY HASH (sha256)`);
							await db.sql(
								`CREATE TABLE ${table} PARTITION OF ${table}_parent FOR VALUES WITH (MODULUS 1, REMAINDER 0)`,
							);
							await db.sql(`ALTER TABLE ${table} ADD PRIMARY KEY (${key})`);
							if (index) await db.sql(index);
							expect(String(await rejection(db.open({ createTable: false })))).toMatch(
								new RegExp(`${table} is a partition of \\S*${table}_parent\\b`),
							);
						} finally {
							await db.sql(`DROP TABLE IF EXISTS ${table}_parent CASCADE`);
						}
					},
				);
			}

			it.skipIf(adapter !== "postgres")(
				"refuses to start on a reference table without its index on sha256",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					await (await db.open()).drain();
					// A delete's and the sweep's look for a blob's references reads by sha256 alone.
					await db.sql(`DROP INDEX ${db.table}_rhash`);
					expect(String(await rejection(db.open({ createTable: false })))).toContain(
						`${db.table}_refs has no index on column sha256`,
					);
				},
			);

			it("deletes a session's blob rows with the session, and keeps one another session still names", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				const shared = imageBytes(1);
				const own = imageBytes(2);
				const first = await writeImageSession(db, storage, [shared, own]);
				const second = await writeImageSession(db, storage, [shared]);
				expect(await blobHashes(db)).toEqual([sha256(shared), sha256(own)].sort());

				await storage.deleteSessionWithArtifacts(first);
				expect(await blobHashes(db)).toEqual([sha256(shared)]);
				await storage.unlink(second);
				expect(await blobHashes(db)).toEqual([]);
			});

			it("deletes, when a move replaces a session, the blob rows only the replaced session named", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				const moved = imageBytes(3);
				const replaced = imageBytes(4);
				const source = await writeImageSession(db, storage, [moved]);
				const target = await writeImageSession(db, storage, [replaced]);

				await storage.rename(source, target);
				expect(await blobHashes(db)).toEqual([sha256(moved)]);
				// The moved session's references went with it.
				await storage.unlink(target);
				expect(await blobHashes(db)).toEqual([]);
			});

			it("sweeps, for omp gc, the rows no session names, after dropping the references of sessions that are gone", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				const old = Date.now() - 3 * 86_400_000;
				// Referenced: a session names it and its reference row says so.
				const referenced = imageBytes(11);
				await writeImageSession(db, storage, [referenced]);
				await db.sql(`UPDATE ${db.table}_blobs SET created_ms = @1`, [old]);
				const row = async (data: Buffer, createdMs: number) =>
					db.sql(
						`INSERT INTO ${db.table}_blobs (sha256, content, byte_len, mime_type, created_ms) VALUES (@1, @2, @3, @4, @5)`,
						[sha256(data), data, data.byteLength, "image/png", createdMs],
					);
				// Named only by a transcript gc read; named only by the reference of a session that is gone; named by
				// nothing; written within the grace.
				const [transcriptOnly, dangling, orphan, fresh] = [12, 13, 14, 15].map(seed => imageBytes(seed));
				await row(transcriptOnly, old);
				await row(dangling, old);
				await row(orphan, old);
				await row(fresh, Date.now());
				await db.sql(`INSERT INTO ${db.table}_refs (path, sha256) VALUES (@1, @2)`, [
					db.dir.join("sessions", "gone.jsonl"),
					sha256(dangling),
				]);
				const named = new Set([sha256(transcriptOnly)]);
				const before = Date.now() - 60_000;

				expect(await storage.blobTier.sweep(named, before, false)).toEqual({
					candidates: 1,
					deleted: 0,
					bytes: orphan.byteLength,
				});
				expect(await storage.blobTier.sweep(named, before, true)).toEqual({
					candidates: 2,
					deleted: 2,
					bytes: orphan.byteLength + dangling.byteLength,
				});
				expect(await blobHashes(db)).toEqual([sha256(referenced), sha256(transcriptOnly), sha256(fresh)].sort());
				const refs = (await db.sql(`SELECT sha256 FROM ${db.table}_refs`)).map(found => String(found.sha256));
				expect(refs).toEqual([sha256(referenced)]);
			});

			it("stores a blob larger than one row takes in parts, gives it back whole, and deletes the parts with it", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const big = imageBytes(5, 200 * 1024);
				const limit = { maxBlobBytes: 64 * 1024 };
				const file = await writeImageSession(db, await db.open(limit), [big]);
				// Four parts and the row of the image itself, which lists them.
				expect(await blobHashes(db)).toHaveLength(5);
				expect(await blobHashes(db)).toContain(sha256(big));

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const storage = await db.open(limit);
				const resumed = await SessionManager.open(file, path.dirname(file), storage);
				expect(imagesOf(resumed)).toEqual([big.toString("base64")]);
				await resumed.close();
				await storage.unlink(file);
				expect(await blobHashes(db)).toEqual([]);
			});

			it("never stores local bytes that do not hash to their key, and rewrites a wrong row from the right bytes only", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir } = await writeSession(db);
				const wrong = Buffer.alloc(IMAGE_BYTES.byteLength, 9);
				// A row of the right length and the wrong bytes; this machine holds the right ones.
				await db.sql(`UPDATE ${db.table}_blobs SET content = @1 WHERE sha256 = @2`, [wrong, IMAGE_HASH]);
				const reopened = await SessionManager.open(sessionFile, sessionDir, await db.open());
				await reopened.close();
				const [row] = await db.sql(`SELECT content FROM ${db.table}_blobs WHERE sha256 = @1`, [IMAGE_HASH]);
				expect(sha256(Buffer.from(row?.content as Uint8Array))).toBe(IMAGE_HASH);

				// No row, and this machine holds wrong bytes under the hash: nothing is written back.
				await db.sql(`DELETE FROM ${db.table}_blobs`);
				await Bun.write(path.join(getBlobsDir(), IMAGE_HASH), wrong);
				const again = await SessionManager.open(sessionFile, sessionDir, await db.open());
				again.appendMessage(assistant("again"));
				await again.flush();
				await again.close();
				expect(await blobHashes(db)).toEqual([]);

				// A wrong row, and this machine holds other wrong bytes under the hash: the row is left as it is.
				const other = Buffer.alloc(IMAGE_BYTES.byteLength, 5);
				await db.sql(
					`INSERT INTO ${db.table}_blobs (sha256, content, byte_len, mime_type, created_ms) VALUES (@1, @2, @3, @4, @5)`,
					[IMAGE_HASH, other, other.byteLength, "image/png", Date.now()],
				);
				const third = await SessionManager.open(sessionFile, sessionDir, await db.open());
				await third.close();
				const [kept] = await db.sql(`SELECT content FROM ${db.table}_blobs WHERE sha256 = @1`, [IMAGE_HASH]);
				expect(Buffer.from(kept?.content as Uint8Array).equals(other)).toBe(true);
			});

			it("fails only the writes that name a blob that cannot be written", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open({ wrap: client => failing(client, BLOB_INSERT, Number.POSITIVE_INFINITY) });
				const withImage = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), storage);
				withImage.appendMessage(imageTurn("look"));
				withImage.appendMessage(assistant("seen"));
				const plain = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), storage);
				plain.appendMessage({ role: "user", content: "no image here", timestamp: 1 });
				plain.appendMessage(assistant("fine"));

				// A flush drains the whole store, whose first failed write (the image session's) it may report;
				// what this test holds is that the plain session's transcript landed.
				await plain.flush().catch(() => undefined);
				expect((await db.row(plain.getSessionFile() ?? ""))?.content ?? "").toContain("no image here");
				await withImage.flush().catch(() => undefined);
				expect((await db.row(withImage.getSessionFile() ?? ""))?.content ?? "").not.toContain(IMAGE_HASH);
				// Closing drains the shared store, which reports the image session's failed write again.
				await withImage.close().catch(() => undefined);
				await plain.close().catch(() => undefined);
				// Each blob write that fails is tried 3 times, 250 and 500 ms apart, and this test waits on four
				// such rounds (the store's own, the write's, the flush's and the close's): about 3 s of waiting.
			}, 15_000);

			it("draws again, in the read-only loader, the snapcompact frames this machine lacks", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile } = await writeSession(db);
				const content = (await db.row(sessionFile))?.content ?? "";
				const frames = [...new Set([...content.matchAll(BLOB_REF)].map(match => match[1] ?? ""))].filter(
					hash => hash !== IMAGE_HASH,
				);
				expect(frames.length).toBeGreaterThan(0);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });

				await loadSessionMessagesReadOnly(sessionFile, await db.open());
				const drawn = await Promise.all(frames.map(hash => Bun.file(path.join(getBlobsDir(), hash)).exists()));
				expect(drawn).toEqual(frames.map(() => true));
			});

			it("restores an image from the table with its display copy beside the blob", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir } = await writeSession(db);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				await resumed.close();
				expect(await Bun.file(path.join(getBlobsDir(), `${IMAGE_HASH}.png`)).exists()).toBe(true);
			});

			it("restores, after the synchronous foreign-entry path, an image only the table holds", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				await writeSession(db);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const storage = await db.open();
				const entries: FileEntry[] = [
					{
						type: "message",
						id: "foreign1",
						parentId: null,
						timestamp: "2026-11-18T00:00:00.000Z",
						message: {
							role: "user",
							content: [{ type: "image", data: `blob:sha256:${IMAGE_HASH}`, mimeType: "image/png" }],
							timestamp: 1,
						},
					} as FileEntry,
				];
				resolveBlobRefsInEntriesSync(entries, new BlobStore(getBlobsDir(), storage.blobTier));
				const image = () => {
					const entry = entries[0];
					return entry?.type === "message" &&
						entry.message.role === "user" &&
						typeof entry.message.content !== "string"
						? (entry.message.content[0] as ImageContent | undefined)?.data
						: undefined;
				};
				await until(() => image() === IMAGE);
				expect(image()).toBe(IMAGE);
			});

			it.skipIf(adapter !== "sqlite")(
				"refuses to start on SQLite when the blob table has no primary key",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					await (await db.open()).drain();
					await db.sql(`DROP TABLE ${db.table}_blobs`);
					await db.sql(
						`CREATE TABLE ${db.table}_blobs (sha256 TEXT, content BLOB NOT NULL, byte_len INTEGER NOT NULL, ` +
							"mime_type TEXT, created_ms INTEGER NOT NULL)",
					);
					expect(String(await rejection(db.open({ createTable: false })))).toContain(
						`table ${db.table}_blobs has no primary key`,
					);
				},
			);
		});
	}

	for (const { adapter, url } of ROW_LEASE_BACKENDS) {
		describe.skipIf(!url)(adapter, () => {
			it("writes no transcript naming an image before its blob's row commits", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				let gate: GatedClient | undefined;
				const storage = await db.open({
					wrap: client => {
						gate = gatedClient(client, BLOB_INSERT);
						return gate.client;
					},
				});
				const manager = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), storage);
				manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
				manager.appendMessage(assistant("seen"));
				await manager.flush();
				const sessionFile = manager.getSessionFile() ?? "";

				gate?.close();
				manager.appendMessage(imageTurn("look"));
				const flushing = manager.flush();
				try {
					// The blob's insert is held open; the flush of the line naming it must not finish first.
					const first = await Promise.race([
						gate?.paused().then(() => "blob insert held"),
						flushing.then(() => "transcript flushed"),
					]);
					expect(first).toBe("blob insert held");
					// A real wait: what must not happen is a commit on the database server, which
					// no fake clock reaches. Without the barrier the line commits well within it.
					await Bun.sleep(500);
					// The blob's row is inserted, not committed: the line naming it waits.
					expect((await db.row(sessionFile))?.content ?? "").not.toContain(IMAGE_HASH);
					expect(await blobHashes(db)).toEqual([]);
				} finally {
					gate?.open();
				}
				await flushing;
				expect((await db.row(sessionFile))?.content ?? "").toContain(IMAGE_HASH);
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				await manager.close();
			});

			it("writes no first, full transcript naming an image before its blob's row commits, and runs that write once", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				let gate: GatedClient | undefined;
				const queries: string[] = [];
				const storage = await db.open({
					wrap: client => {
						gate = gatedClient(recordingClient(client, queries), BLOB_INSERT);
						return gate.client;
					},
				});
				gate?.close();
				const manager = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), storage);
				// The session's first write is a full one (made once it has an assistant turn), and it names the image.
				manager.appendMessage(imageTurn("look"));
				manager.appendMessage(assistant("seen"));
				const sessionFile = manager.getSessionFile() ?? "";
				const flushing = manager.flush();
				try {
					const first = await Promise.race([
						gate?.paused().then(() => "blob insert held"),
						flushing.then(() => "transcript flushed"),
					]);
					expect(first).toBe("blob insert held");
					// A real wait: what must not happen is a commit on the database server, which no fake clock reaches.
					await Bun.sleep(500);
					expect((await db.row(sessionFile))?.content ?? "").not.toContain(IMAGE_HASH);
				} finally {
					gate?.open();
				}
				await flushing;
				expect((await db.row(sessionFile))?.content ?? "").toContain(IMAGE_HASH);
				// The write waited for its blob before it began, so it ran once: without that wait its first
				// transaction would find the row missing, roll back, and run again once the blob landed. A first
				// write makes the row if it is missing, which MySQL spells `INSERT IGNORE INTO`.
				const sessionRow = new RegExp(`^INSERT (?:IGNORE )?INTO \\S*\\b${db.table} \\(`);
				expect(queries.filter(query => sessionRow.test(query))).toHaveLength(1);
				await manager.close();
			});

			it("keeps a blob another session's delete would take while a write adding a reference to it is open", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				const deleted = await writeImageSession(db, storage, [IMAGE_BYTES]);
				let gate: GatedClient | undefined;
				const writer = await db.open({
					wrap: client => {
						gate = gatedClient(client, REF_INSERT);
						return gate.client;
					},
				});
				const manager = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), writer);
				manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
				manager.appendMessage(assistant("seen"));
				await manager.flush();

				gate?.close();
				manager.appendMessage(imageTurn("the same image"));
				const flushing = manager.flush();
				let first: string | undefined;
				let deleting: Promise<void> | undefined;
				try {
					// The write holds the blob's row shared, its reference not committed (a build without
					// references never gets here, and flushes first).
					await Promise.race([gate?.paused(), flushing]);
					deleting = storage.unlink(deleted);
					// A real wait: the delete must not finish while the write's transaction is open on the server.
					first = await Promise.race([
						deleting.then(() => "deleted"),
						Bun.sleep(1000).then(() => "waiting for the write"),
					]);
				} finally {
					gate?.open();
				}
				await Promise.all([flushing, deleting]);
				expect(first).toBe("waiting for the write");
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				await manager.close();
			});

			// A delete, or a rename replacing a session, that names a blob a write is referencing: the write paused
			// before its reference insert (the order case) and after it (the control). The delete takes the blob
			// rows' locks before it touches the reference table, as the write does, so on MySQL and MariaDB the
			// write's insert never waits on the delete's next-key locks: no deadlock, so neither side runs its
			// transaction again (each drops references once, the write inserts its own once), and the row is kept
			// as it was.
			for (const remover of ["delete", "replacing rename"] as const) {
				for (const when of ["before", "after"] as const) {
					it(`keeps the row, with no deadlock or retry, when a ${remover} meets a write paused ${when} its reference insert`, async () => {
						await using db = await openLeaseDb(adapter, url ?? "");
						const removerQueries: string[] = [];
						const storage = await db.open({ wrap: client => recordingClient(client, removerQueries) });
						const named = await writeImageSession(db, storage, [IMAGE_BYTES]);
						const other = remover === "delete" ? undefined : await writeImageSession(db, storage, []);
						const created = await blobCreatedMs(db);
						let gate: GatedClient | undefined;
						const queries: string[] = [];
						const writer = await db.open({
							wrap: client => {
								gate = gatedClient(recordingClient(client, queries), REF_INSERT, when);
								return gate.client;
							},
						});
						const manager = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), writer);
						manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
						manager.appendMessage(assistant("seen"));
						await manager.flush();

						queries.length = 0;
						removerQueries.length = 0;
						gate?.close();
						manager.appendMessage(imageTurn("the same image"));
						const flushing = manager.flush();
						let first: string | undefined;
						let removing: Promise<void> | undefined;
						try {
							// The write holds the blob's row shared, its reference not inserted (or not committed).
							await Promise.race([gate?.paused(), flushing]);
							removing = other ? storage.rename(other, named) : storage.unlink(named);
							// A real wait: the remover must not finish while the write's transaction is open on the server.
							first = await Promise.race([
								removing.then(() => "removed"),
								Bun.sleep(1000).then(() => "waiting for the write"),
							]);
						} finally {
							gate?.open();
						}
						await Promise.all([flushing, removing]);
						expect({
							first,
							blobs: await blobHashes(db),
							created: await blobCreatedMs(db),
							referenceInserts: queries.filter(query => REF_INSERT.test(query)).length,
							removerReferenceDeletes: removerQueries.filter(query => REF_DELETE.test(query)).length,
						}).toEqual({
							first: "waiting for the write",
							blobs: [IMAGE_HASH],
							created,
							referenceInserts: 1,
							removerReferenceDeletes: 1,
						});
						expect((await db.row(manager.getSessionFile() ?? ""))?.content ?? "").toContain(IMAGE_HASH);
						await manager.close();
					});
				}
			}

			it("keeps the row, with no deadlock or retry, when a delete meets a full write paused before its blob rows' lock", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const removerQueries: string[] = [];
				const storage = await db.open({ wrap: client => recordingClient(client, removerQueries) });
				let gate: GatedClient | undefined;
				const queries: string[] = [];
				const writer = await db.open({
					wrap: client => {
						gate = gatedClient(recordingClient(client, queries), BLOB_SHARE_LOCK, "before");
						return gate.client;
					},
				});
				// Paths sort by creation: the deleted session, one with parts and no reference (so the delete's
				// look at the parts table stops short of the writer's), then the writer's, whose reference row
				// comes right after the deleted session's in the reference table.
				const deleted = await writeImageSession(db, storage, [IMAGE_BYTES]);
				await writeImageSession(db, storage, []);
				const written = await writeImageSession(db, writer, [IMAGE_BYTES]);
				const created = await blobCreatedMs(db);
				const content = (await db.row(written))?.content ?? "";
				expect(content).toContain(IMAGE_HASH);

				queries.length = 0;
				removerQueries.length = 0;
				gate?.close();
				// A full write of the session's content: its references are replaced, after its blob rows' locks.
				const writing = writer.writeText(written, content).then(() => writer.drain());
				let removing: Promise<void> | undefined;
				try {
					await Promise.race([gate?.paused(), writing]);
					removing = storage.unlink(deleted);
					// A real wait: what is measured is whether the delete meets a lock of the write's on the server.
					await Promise.race([removing, Bun.sleep(1000)]);
				} finally {
					gate?.open();
				}
				await Promise.all([writing, removing]);
				expect({
					blobs: await blobHashes(db),
					created: await blobCreatedMs(db),
					refs: (await db.sql(`SELECT path FROM ${db.table}_refs`)).map(row => String(row.path)),
					writerReferenceDeletes: queries.filter(query => REF_DELETE.test(query)).length,
					removerReferenceDeletes: removerQueries.filter(query => REF_DELETE.test(query)).length,
				}).toEqual({
					blobs: [IMAGE_HASH],
					created,
					refs: [written],
					writerReferenceDeletes: 1,
					removerReferenceDeletes: 1,
				});
			});

			// A full write that stops naming a blob: session P named T and is rewritten to name only U; session Q
			// also names T, sorts just before P, and is deleted while P's write is paused after it deleted its
			// references. The write read those references first and locked T's row too, so the delete waits for
			// the write's commit and then takes T with its last reference. With U before T, the write's insert of
			// (P, U) falls in the gap the delete's reference delete would lock (on MySQL and MariaDB, the
			// deadlock of a write that locks only U's row); with U after T, the control, it does not.
			for (const order of ["before", "after"] as const) {
				it(`drops, with no deadlock or retry, the row of a blob a full write stops naming, when a delete of another session naming it meets the write (U sorts ${order} T)`, async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const removerQueries: string[] = [];
					const storage = await db.open({ wrap: client => recordingClient(client, removerQueries) });
					let gate: GatedClient | undefined;
					const queries: string[] = [];
					const writer = await db.open({
						wrap: client => {
							gate = gatedClient(recordingClient(client, queries), REF_DELETE, "after");
							return gate.client;
						},
					});
					const [low, high] = [imageBytes(21), imageBytes(22)].sort((a, b) => (sha256(a) < sha256(b) ? -1 : 1));
					const [kept, dropped] = order === "before" ? [low, high] : [high, low];
					// Q, then P: Q's references sort right before P's in the reference table.
					const q = await writeImageSession(db, storage, [dropped]);
					const p = await writeImageSession(db, writer, [dropped]);
					writer.blobTier.store(sha256(kept), kept, "image/png");
					await writer.drain();
					const [row] = await db.sql(`SELECT created_ms FROM ${db.table}_blobs WHERE sha256 = @1`, [sha256(kept)]);
					const created = Number(row?.created_ms);
					const content = ((await db.row(p))?.content ?? "").replaceAll(sha256(dropped), sha256(kept));

					queries.length = 0;
					removerQueries.length = 0;
					gate?.close();
					const writing = writer.writeText(p, content).then(() => writer.drain());
					let first: string | undefined;
					let removing: Promise<void> | undefined;
					try {
						await Promise.race([gate?.paused(), writing]);
						removing = storage.unlink(q);
						// A real wait: the delete must not finish while the write's transaction is open on the server.
						first = await Promise.race([
							removing.then(() => "removed"),
							Bun.sleep(1000).then(() => "waiting for the write"),
						]);
					} finally {
						gate?.open();
					}
					await Promise.all([writing, removing]);
					const [keptRow] = await db.sql(`SELECT created_ms FROM ${db.table}_blobs WHERE sha256 = @1`, [
						sha256(kept),
					]);
					expect({
						first,
						blobs: await blobHashes(db),
						created: Number(keptRow?.created_ms),
						refs: (await db.sql(`SELECT path, sha256 FROM ${db.table}_refs`)).map(found => [
							String(found.path),
							String(found.sha256),
						]),
						writerReferenceDeletes: queries.filter(query => REF_DELETE.test(query)).length,
						writerReferenceInserts: queries.filter(query => REF_INSERT.test(query)).length,
						removerReferenceDeletes: removerQueries.filter(query => REF_DELETE.test(query)).length,
					}).toEqual({
						first: "waiting for the write",
						blobs: [sha256(kept)],
						created,
						refs: [[p, sha256(kept)]],
						writerReferenceDeletes: 1,
						writerReferenceInserts: 1,
						removerReferenceDeletes: 1,
					});
				});
			}

			// The sweep against a write to a dangling reference's path: P named A, and a build that keeps no
			// references deleted P's row, so (P, A) is dangling. A write that re-creates P naming A is paused just
			// after its session row insert, and the sweep runs. The sweep takes P's session row (or its gap) before
			// A's row, as the write does, so on MySQL and MariaDB it waits for the write and then keeps the write's
			// reference, with no deadlock. The control: the write creates another session naming A, so the sweep
			// does not wait, and drops (P, A).
			for (const target of ["the dangling path", "another path"] as const) {
				it(`sweeps, with no deadlock or retry, the dangling references while a write to ${target} naming the blob is open`, async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const sweeperQueries: string[] = [];
					const storage = await db.open({ wrap: client => recordingClient(client, sweeperQueries) });
					const sessionRow = new RegExp(`^INSERT (?:IGNORE )?INTO \\S*\\b${db.table} \\(`);
					let gate: GatedClient | undefined;
					const queries: string[] = [];
					const writer = await db.open({
						wrap: client => {
							gate = gatedClient(recordingClient(client, queries), sessionRow, "after");
							return gate.client;
						},
					});
					const p = await writeImageSession(db, storage, [IMAGE_BYTES]);
					const content = (await db.row(p))?.content ?? "";
					await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [p]);
					await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [p]);
					const written = target === "the dangling path" ? p : db.dir.join("sessions", "other.jsonl");
					const created = await blobCreatedMs(db);

					queries.length = 0;
					sweeperQueries.length = 0;
					gate?.close();
					const writing = writer.writeText(written, content).then(() => writer.drain());
					let first: string | undefined;
					let sweeping: Promise<unknown> | undefined;
					try {
						await Promise.race([gate?.paused(), writing]);
						sweeping = storage.blobTier.sweep(new Set(), 0, true);
						// A real wait: what is measured is whether the sweep meets a lock of the write's on the server.
						first = await Promise.race([
							sweeping.then(() => "swept"),
							Bun.sleep(1000).then(() => "waiting for the write"),
						]);
					} finally {
						gate?.open();
					}
					await Promise.all([writing, sweeping]);
					// PostgreSQL locks no gap and its look takes no lock: its sweep drops (P, A) without waiting, and
					// the write then adds its own reference again.
					const waits = target === "the dangling path" && adapter === "mysql";
					expect({
						first,
						blobs: await blobHashes(db),
						created: await blobCreatedMs(db),
						refs: (await db.sql(`SELECT path, sha256 FROM ${db.table}_refs`)).map(found => [
							String(found.path),
							String(found.sha256),
						]),
						writerSessionRowInserts: queries.filter(query => sessionRow.test(query)).length,
						writerReferenceInserts: queries.filter(query => REF_INSERT.test(query)).length,
						sweeperBlobLocks: sweeperQueries.filter(query => BLOB_EXCLUSIVE_LOCK.test(query)).length,
					}).toEqual({
						first: waits ? "waiting for the write" : "swept",
						blobs: [IMAGE_HASH],
						created,
						refs: [[written, IMAGE_HASH]],
						writerSessionRowInserts: 1,
						writerReferenceInserts: 1,
						sweeperBlobLocks: 1,
					});
				});
			}

			it("lands again, from this machine's blob store, a blob a delete took while a write naming it waited", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				let gate: GatedClient | undefined;
				const storage = await db.open({
					wrap: client => {
						gate = gatedClient(client, /^DELETE FROM \S*_blobs\b/);
						return gate.client;
					},
				});
				const deleted = await writeImageSession(db, storage, [IMAGE_BYTES]);
				const writer = await db.open();
				const manager = SessionManager.create(db.dir.join("project"), db.dir.join("sessions"), writer);
				manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
				manager.appendMessage(assistant("seen"));
				await manager.flush();
				// The writer knows the blob is in the table, as a resume that read it does.
				await writer.blobTier.sizes([IMAGE_HASH]);

				gate?.close();
				const deleting = storage.unlink(deleted);
				let flushing: Promise<void> | undefined;
				try {
					// The delete took the row and has not committed.
					const held = await Promise.race([gate?.paused().then(() => true), deleting.then(() => false)]);
					expect(held).toBe(true);
					manager.appendMessage(imageTurn("the same image"));
					flushing = manager.flush();
					// A real wait: the write must reach its lock on the row before the delete commits.
					await Bun.sleep(500);
				} finally {
					gate?.open();
				}
				await Promise.all([deleting, flushing]);
				const sessionFile = manager.getSessionFile() ?? "";
				expect((await db.row(sessionFile))?.content ?? "").toContain(IMAGE_HASH);
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				await manager.close();
			});

			it("lands an image's blob when another holder took the session over, and the sibling the session moves to resumes with it", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open({ lease: STILL });
				const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
				await storage.writeText(file, transcript(ID, "before"));
				await storage.drain();
				const manager = await SessionManager.open(file, path.dirname(file), storage, { suppressBreadcrumb: true });
				await manager.claimOpenedSession();
				await manager.flush();

				// Another holder takes the session over; this store finds it at its next write's fence.
				await db.sql(`UPDATE ${db.leaseTable} SET holder = 'another-holder' WHERE session_id = @1`, [ID]);
				manager.appendMessage(imageTurn("look"));
				await until(() => manager.getSessionId() !== ID);
				await manager.flush();
				const sibling = manager.getSessionFile() ?? "";
				await manager.close();
				expect(sibling).not.toBe(file);
				expect((await db.row(sibling))?.content ?? "").toContain(IMAGE_HASH);
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(sibling, path.dirname(sibling), await db.open({ lease: STILL }));
				const images = resumed
					.getEntries()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "user" && typeof entry.message.content !== "string"
							? entry.message.content.filter((block): block is ImageContent => block.type === "image")
							: [],
					);
				expect(images.map(image => image.data)).toEqual([IMAGE]);
				await resumed.close();
			});

			it.skipIf(adapter !== "postgres")(
				"refuses to start on a blob table it cannot write: a column of another type, no primary key, no INSERT grant",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					await (await db.open()).drain();
					const blobs = `${db.table}_blobs`;
					const refusal = async () => String(await rejection(db.open({ createTable: false })));

					await db.sql(`ALTER TABLE ${blobs} ALTER COLUMN mime_type TYPE varchar(100)`);
					expect(await refusal()).toContain("column mime_type of type character varying(100), not text");
					await db.sql(`ALTER TABLE ${blobs} ALTER COLUMN mime_type TYPE text`);
					await db.sql(`ALTER TABLE ${blobs} DROP CONSTRAINT ${blobs}_pkey`);
					expect(await refusal()).toContain("no primary key");
					await db.sql(`ALTER TABLE ${blobs} ADD PRIMARY KEY (sha256)`);

					// A login with row access to the other tables, and only SELECT on the blob table.
					const role = `blob_reader_${process.pid}`;
					const others = `${db.table}, ${db.table}_parts, ${db.table}_refs, ${db.leaseTable}`;
					await db.sql(`CREATE ROLE ${role} LOGIN`);
					const client = new SQL(Object.assign(new URL(db.dsn), { username: role }).toString());
					try {
						await db.sql(`GRANT USAGE ON SCHEMA public TO ${role}`);
						await db.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${others} TO ${role}`);
						await db.sql(`GRANT SELECT ON ${blobs} TO ${role}`);
						const refused = String(
							await rejection(
								SqlSessionStorage.create({ client, table: db.table, createTable: false, claims: false }),
							),
						);
						expect(refused).toContain("no INSERT privilege for the store's login");
						expect(refused).toContain("no DELETE privilege for the store's login");
					} finally {
						await client.end();
						await db.sql(`REVOKE ALL ON ${others}, ${blobs} FROM ${role}`);
						await db.sql(`REVOKE ALL ON SCHEMA public FROM ${role}`);
						await db.sql(`DROP ROLE IF EXISTS ${role}`);
					}
				},
			);
		});
	}

	it("stores a blob larger than a MySQL server's max_allowed_packet takes in parts that fit it, and one that fits whole", async () => {
		const MIB = 1024 * 1024;
		const inserted: unknown[] = [];
		const storage = await SqlSessionStorage.create({
			client: mysqlStub(sql => {
				if (sql.startsWith("SELECT @@max_allowed_packet")) return [{ max_packet: 2 * MIB }];
				return undefined;
			}, inserted),
			claims: false,
		});
		const large = imageBytes(6, 1.5 * MIB);
		const small = imageBytes(7, MIB / 4);

		storage.blobTier.store(sha256(large), large, "image/png");
		storage.blobTier.store(sha256(small), small, "image/png");
		await storage.drain();
		// The bound is the packet less 1 MiB: the large image's own row, then its two parts in hash order (a
		// delete takes them in that order too), then the small one.
		expect(inserted).toEqual([
			sha256(large),
			...[sha256(large.subarray(0, MIB)), sha256(large.subarray(MIB))].sort(),
			sha256(small),
		]);
	});

	it("refuses to start on MySQL when the blob table has no primary key or the login cannot insert into it", async () => {
		const refused = String(
			await rejection(
				SqlSessionStorage.create({
					client: mysqlStub((sql, values) => {
						// The blob table without its key.
						if (sql.includes("information_schema.KEY_COLUMN_USAGE") && String(values?.[0]).endsWith("_blobs")) {
							return [];
						}
						if (sql.startsWith("INSERT INTO omp_session_files_blobs") && sql.endsWith("WHERE 1 = 0")) {
							throw new Error("INSERT command denied to user 'agent'@'%' for table 'omp_session_files_blobs'");
						}
						return undefined;
					}, []),
					claims: false,
				}),
			),
		);
		expect(refused).toContain("table omp_session_files_blobs has no primary key");
		expect(refused).toContain("the store's login cannot INSERT on table omp_session_files_blobs");
	});
});

/**
 * A MySQL server that answers start-up as one with every table in place
 * would, records the hash of each blob row inserted, and asks `special`
 * first (an answer, or undefined for the default).
 */
function mysqlStub(
	special: (sql: string, values: unknown[] | undefined) => SqlSessionStorageResult | undefined,
	inserted: unknown[],
): SqlSessionStorageClient {
	const columns = ["path", "content", "mtime_ms", "title", "title_source", "title_updated_at", "byte_len"];
	const answer = (sql: string, values: unknown[] | undefined): SqlSessionStorageResult => {
		const answered = special(sql, values);
		if (answered) return answered;
		if (sql.includes(" AS column_name FROM ")) return columns.map(column_name => ({ column_name }));
		if (sql === "SELECT VERSION() AS version") return [{ version: "8.4.13" }];
		if (sql.includes("information_schema.KEY_COLUMN_USAGE")) {
			return String(values?.[0]).endsWith("_refs") ? [{ name: "path" }, { name: "sha256" }] : [{ name: "sha256" }];
		}
		if (BLOB_INSERT.test(sql) && !sql.endsWith("WHERE 1 = 0")) {
			inserted.push(values?.[0]);
			return Object.assign([], { affectedRows: 1 });
		}
		return [];
	};
	const executor: SqlSessionStorageTransaction = { unsafe: async (sql, values) => answer(sql, values) };
	return { options: { adapter: "mysql" }, unsafe: executor.unsafe, transaction: callback => callback(executor) };
}

/** `client`, recording every statement it sends in `queries`. */
function recordingClient(client: SqlSessionStorageClient, queries: string[]): SqlSessionStorageClient {
	const wrap = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		unsafe(query, values) {
			queries.push(query);
			return executor.unsafe(query, values);
		},
	});
	return {
		options: client.options,
		unsafe(query, values) {
			queries.push(query);
			return client.unsafe(query, values);
		},
		transaction: callback => client.transaction(transaction => callback(wrap(transaction))),
		end: () => client.end?.() ?? Promise.resolve(),
	};
}
