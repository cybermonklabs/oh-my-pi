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
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	loadSessionMessagesReadOnly,
	resolveBlobRefsInEntriesSync,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { entryRecordText } from "@oh-my-pi/pi-coding-agent/session/session-persistence";
import { copyTranscript } from "@oh-my-pi/pi-coding-agent/session/session-transcript-tree";
import {
	SessionRenameRaceError,
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
	STILL,
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

/** `client`, adding to `into` each deadlock its transactions' statements meet. */
function deadlockLog(client: SqlSessionStorageClient, into: string[]): SqlSessionStorageClient {
	const wrap = (executor: SqlSessionStorageTransaction): SqlSessionStorageTransaction => ({
		async unsafe(query, values) {
			try {
				return await executor.unsafe(query, values);
			} catch (err) {
				if (err instanceof Error && /deadlock/i.test(err.message)) into.push(query.slice(0, 80));
				throw err;
			}
		},
	});
	return {
		options: client.options,
		unsafe: (query, values) => client.unsafe(query, values),
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

/**
 * Keep a read view open on a connection of its own, so InnoDB purges no row a
 * delete marks after it, until the returned function runs (any number of times).
 */
async function holdPurge(db: LeaseDb): Promise<() => Promise<void>> {
	const holder = new SQL(db.dsn);
	const opened = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const held = holder.transaction(async transaction => {
		await transaction.unsafe(`SELECT COUNT(*) AS n FROM ${db.table}`);
		opened.resolve();
		await release.promise;
	});
	held.catch((err: unknown) => opened.reject(err));
	await opened.promise;
	let ended: Promise<void> | undefined;
	return () => {
		release.resolve();
		ended ??= held.then(
			() => holder.end(),
			() => holder.end(),
		);
		return ended;
	};
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

			// A body the spool streams to `writeFullStream` (a session's full rewrite) replaces its path's references as
			// a whole write's does, from every reference the staged parts hold, one cut across two parts included.
			it("replaces a session's references through a streamed full write, and the sweep keeps only the blob it names", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const queries: string[] = [];
				const storage = await db.open({ wrap: client => recordingClient(client, queries) });
				const [dropped, named] = [imageBytes(21), imageBytes(22)];
				for (const data of [dropped, named]) storage.blobTier.store(sha256(data), data, "image/png");
				await storage.drain();
				const file = db.dir.join("sessions", "streamed.jsonl");
				await storage.writeText(file, transcript(ID, `blob:sha256:${sha256(dropped)}`));
				await storage.drain();
				// The new body names the other image 20 bytes before 1 MiB, where the first staged part ends.
				const at = transcript(ID, "@").indexOf("@");
				const body = transcript(ID, `${"x".repeat(1024 * 1024 - 20 - at)}blob:sha256:${sha256(named)} seen`);
				queries.length = 0;
				await storage.writeLinesAtomic(file, body.split(/(?<=\n)/));
				await storage.drain();
				// The staged swap ran: its rename of the staging parts is the only `UPDATE … SET path` here.
				expect(queries.filter(query => /^UPDATE \S*_parts SET path\b/.test(query))).toHaveLength(1);
				expect((await db.row(file))?.content).toBe(body);
				const refs = await db.sql(`SELECT sha256 FROM ${db.table}_refs WHERE path = @1`, [file]);
				expect(refs.map(row => String(row.sha256))).toEqual([sha256(named)]);

				// Both rows are older than the sweep's grace: only the reference keeps one.
				await db.sql(`UPDATE ${db.table}_blobs SET created_ms = @1`, [Date.now() - 3 * 86_400_000]);
				expect(await storage.blobTier.sweep(new Set(), Date.now() - 60_000, true)).toEqual({
					candidates: 1,
					deleted: 1,
					bytes: dropped.byteLength,
				});
				expect(await blobHashes(db)).toEqual([sha256(named)]);
			});

			// As a rename moves no parts its source lacks (on MySQL an update that finds no row still locks a gap).
			it("renames no staging parts when a streamed full write stages none", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const queries: string[] = [];
				const storage = await db.open({ wrap: client => recordingClient(client, queries) });
				const file = db.dir.join("sessions", "emptied.jsonl");
				await storage.writeText(file, transcript(ID, "something"));
				await storage.drain();
				queries.length = 0;
				await storage.writeLinesAtomic(file, []);
				await storage.drain();
				expect((await db.row(file))?.content).toBe("");
				// The swap ran (its look at the staged parts), and renamed nothing.
				expect(queries.filter(query => /AS len FROM \S*_parts WHERE path = /.test(query))).toHaveLength(1);
				expect(queries.filter(query => /^UPDATE \S*_parts SET path\b/.test(query))).toEqual([]);
			});

			// A copy (`copyTranscript`, as a session's subagent transcripts are copied to a fork) appends the source's
			// text in batches; each append references the blobs it names, so no batch may cut a reference.
			it("references from a copied transcript a blob whose reference the source's stored parts cut, so deleting the source keeps it", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				const image = imageBytes(24);
				storage.blobTier.store(sha256(image), image, "image/png");
				await storage.drain();
				const from = db.dir.join("sessions", "from.jsonl");
				const to = db.dir.join("sessions", "to.jsonl");
				// The reference starts 20 bytes before 1 MiB, where the source's first stored part ends.
				const at = transcript(ID, "@").indexOf("@");
				const body = transcript(ID, `${"x".repeat(1024 * 1024 - 20 - at)}blob:sha256:${sha256(image)} seen`);
				await storage.writeText(from, body);
				await storage.drain();

				expect(await copyTranscript(storage, from, to)).toBe(true);
				await storage.drain();
				expect((await db.row(to))?.content).toBe(body);
				const refs = await db.sql(`SELECT sha256 FROM ${db.table}_refs WHERE path = @1`, [to]);
				expect(refs.map(row => String(row.sha256))).toEqual([sha256(image)]);
				await storage.unlink(from);
				expect(await blobHashes(db)).toEqual([sha256(image)]);
			});

			// Lines a writer queues on a path before its next append starts go to the database in one batch of appends
			// (`appendBatch`), which references the blobs its lines name as each line's own append does.
			it("references the blobs every line of a batch of appends names, so deleting another session that names them keeps them", async () => {
				// If this regresses, a session whose lines were stored in one batch (a busy session's, or a copy of
				// another's transcript) keeps no reference to its images: deleting another session that names the same
				// image deletes the image's row, and the session, resumed on another machine, shows the image as missing.
				await using db = await openLeaseDb(adapter, url ?? "");
				const queries: string[] = [];
				const storage = await db.open({ wrap: client => recordingClient(client, queries) });
				const source = await writeImageSession(db, storage, [IMAGE_BYTES]);
				// The source's lines as the store wrote them: its header, the user turn naming the image, the reply.
				const lines = ((await db.row(source))?.content ?? "").split(/(?<=\n)/);
				expect(lines.length).toBeGreaterThan(1);
				const batched = path.join(path.dirname(source), "batched.jsonl");

				queries.length = 0;
				const writer = storage.openWriter(batched);
				const appendSync = writer.appendSync?.bind(writer);
				if (!appendSync) throw new Error("the SQL store's writer appends synchronously");
				// Queued in one tick: they join the path's batch before its append operation starts.
				for (const line of lines) appendSync(line);
				await writer.close();
				// One batch stored every line: one part insert of a batch's, and no single line's append (PostgreSQL's
				// inside its `WITH`).
				expect(queries.filter(query => /^INSERT INTO \S*_parts \([^)]*\) VALUES/.test(query))).toHaveLength(1);
				expect(queries.filter(query => /INSERT INTO \S*_parts \([^)]*\) SELECT/.test(query))).toEqual([]);
				expect((await db.row(batched))?.content).toBe(lines.join(""));

				await storage.unlink(source);
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				const refs = await db.sql(`SELECT sha256 FROM ${db.table}_refs WHERE path = @1`, [batched]);
				expect(refs.map(row => String(row.sha256))).toEqual([IMAGE_HASH]);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(batched, path.dirname(batched), await db.open());
				expect(imagesOf(resumed)).toEqual([IMAGE]);
				await resumed.close();
			});

			// A streamed load keeps entries before a compaction's kept start out of memory; the open still writes back,
			// and references from the session, every blob the whole session names.
			it("writes back and references, when a session opens, a blob only an entry the load keeps out of memory names", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const sessionDir = db.dir.join("sessions");
				const writer = SessionManager.create(db.dir.join("project"), sessionDir, await db.open());
				const imageId = writer.appendMessage({
					role: "user",
					content: [
						{ type: "text", text: "look ".repeat(100) },
						{ type: "image", data: IMAGE, mimeType: "image/png" },
					],
					timestamp: 1,
				});
				writer.appendMessage(assistant("seen"));
				const keptId = writer.appendMessage({ role: "user", content: "later", timestamp: 3 });
				writer.appendMessage(assistant("again"));
				writer.appendCompaction("summary", undefined, keptId, 1000);
				await writer.flush();
				const sessionFile = writer.getSessionFile() ?? "";
				await writer.close();
				// A session written before the reference table: its image only on this machine, no row, no reference.
				await db.sql(`DELETE FROM ${db.table}_refs`);
				await db.sql(`DELETE FROM ${db.table}_blobs`);

				const store = await db.open();
				const opened = await SessionManager.open(sessionFile, sessionDir, store);
				const imageEntry = opened.getEntry(imageId);
				expect(imageEntry !== undefined && isColdEntry(imageEntry)).toBe(true);
				await opened.close();
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
				const refs = await db.sql(`SELECT sha256 FROM ${db.table}_refs WHERE path = @1`, [sessionFile]);
				expect(refs.map(row => String(row.sha256))).toEqual([IMAGE_HASH]);
				// Another session naming the image is written and deleted: the opened session's reference keeps the row.
				await store.unlink(await writeImageSession(db, store, [IMAGE_BYTES]));
				expect(await blobHashes(db)).toEqual([IMAGE_HASH]);
			});

			// An entry's record text (a cold entry's, kept out of memory) externalizes its images as a persisted line
			// does: each one goes to the tier too, so a transcript naming it never waits on a blob the table lacks.
			it("hands the tier each image an entry's record externalizes, and no snapcompact frame", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				const blobs = new BlobStore(getBlobsDir(), storage.blobTier);
				const image = imageBytes(25);
				const turn: FileEntry = {
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-11-20T00:00:00.000Z",
					message: {
						role: "user",
						content: [
							{ type: "text", text: "look" },
							{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
						],
						timestamp: 1,
					},
				};
				const compaction: FileEntry = {
					type: "compaction",
					id: "c1",
					parentId: "u1",
					timestamp: "2026-11-20T00:00:01.000Z",
					summary: "summary",
					firstKeptEntryId: "u1",
					tokensBefore: 1000,
					preserveData: { [snapcompact.PRESERVE_KEY]: await frameArchive() },
				};
				expect(entryRecordText(turn, blobs)).toContain(`blob:sha256:${sha256(image)}`);
				expect(entryRecordText(compaction, blobs)).toContain("blob:sha256:");
				await storage.drain();
				expect(await blobHashes(db)).toEqual([sha256(image)]);
			});
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

			it("writes no streamed full transcript naming an image before its blob's row commits", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				let gate: GatedClient | undefined;
				const storage = await db.open({
					wrap: client => {
						gate = gatedClient(client, BLOB_INSERT);
						return gate.client;
					},
				});
				const file = db.dir.join("sessions", "streamed.jsonl");
				const image = imageBytes(23);
				gate?.close();
				storage.blobTier.store(sha256(image), image, "image/png");
				// Through the spool and `writeFullStream`: staged parts, then one swap.
				const writing = storage
					.writeLinesAtomic(file, transcript(ID, `blob:sha256:${sha256(image)}`).split(/(?<=\n)/))
					.then(() => storage.drain());
				try {
					const first = await Promise.race([
						gate?.paused().then(() => "blob insert held"),
						writing.then(() => "transcript written"),
					]);
					expect(first).toBe("blob insert held");
					// A real wait: what must not happen is a commit on the database server, which no fake clock reaches.
					await Bun.sleep(500);
					// The blob's row is inserted, not committed: the swap that publishes the body naming it waits.
					expect(await db.row(file)).toBeUndefined();
				} finally {
					gate?.open();
				}
				await writing;
				expect((await db.row(file))?.content ?? "").toContain(sha256(image));
				expect(await blobHashes(db)).toEqual([sha256(image)]);
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
			// before its reference insert and after it. The delete locks the blob's row before it deletes a reference
			// or looks for a remaining one, so on MySQL and MariaDB it waits there for the write's shared lock and then sees
			// the write's reference: no deadlock, so neither side runs its transaction again (each drops references
			// once, the write inserts its own once), and the row is kept as it was. The delete takes each reference
			// by its key, which locks no gap the write's insert could meet, so this pair alone does not show the
			// order; the two deletes below do.
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

			// Two deletes, at once, of two sessions that name one blob. The first is paused before it locks the
			// blob's row; the second then runs whole. Each locks the blob's row before it deletes a reference or
			// looks for a remaining one, so the second takes the row, drops its own reference, sees the first's, keeps
			// the row and commits, and the first then drops its reference and the row. Out of that order (a
			// delete's references deleted before its blob locks), on MySQL and MariaDB the first holds its deleted
			// reference's index entry, the second's look for a remaining reference waits on it while holding the
			// blob's row, and the first then waits for that row: a deadlock.
			it.skipIf(adapter === "sqlite")(
				"deletes at once two sessions that name one blob, with no deadlock or retry",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const deadlocks: string[] = [];
					const storage = await db.open({ wrap: client => deadlockLog(client, deadlocks) });
					let gate: GatedClient | undefined;
					const first = await db.open({
						wrap: client => {
							gate = gatedClient(deadlockLog(client, deadlocks), BLOB_EXCLUSIVE_LOCK, "before");
							return gate.client;
						},
					});
					const p = await writeImageSession(db, storage, [IMAGE_BYTES]);
					const q = await writeImageSession(db, storage, [IMAGE_BYTES]);
					await first.refresh();

					gate?.close();
					const deletingP = first.unlink(p);
					let deletingQ: Promise<void> | undefined;
					let early: string | undefined;
					try {
						await Promise.race([gate?.paused(), deletingP]);
						deletingQ = storage.unlink(q);
						// A real wait: what is measured is whether the second delete meets a lock of the first's on the server.
						early = await Promise.race([
							deletingQ.then(() => "deleted"),
							Bun.sleep(1000).then(() => "waiting for the first delete"),
						]);
					} finally {
						gate?.open();
					}
					await Promise.all([deletingP, deletingQ]);
					expect({
						early,
						deadlocks,
						paths: await db.paths(),
						blobs: await blobHashes(db),
						refs: await db.sql(`SELECT path FROM ${db.table}_refs`),
					}).toEqual({ early: "deleted", deadlocks: [], paths: [], blobs: [], refs: [] });
				},
			);

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
				// A full write of the session's content: it locks its blob rows, then deletes only the references the
				// content no longer names (none here) and inserts the ones it names.
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
					writerReferenceDeletes: 0,
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
			// after its session row insert, and the sweep runs. The sweep locks no session row on any engine: it
			// locks A's row, which the write takes only after its own, drops (P, A), since the write's row is not
			// committed, and does not wait; the write then references A again, with no deadlock. The control: the
			// write creates another session naming A.
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
					// No engine's sweep waits: it locks no session row, and the write takes A's row only after the sweep.
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
						first: "swept",
						blobs: [IMAGE_HASH],
						created,
						refs: [[written, IMAGE_HASH]],
						writerSessionRowInserts: 1,
						writerReferenceInserts: 1,
						sweeperBlobLocks: 1,
					});
				});
			}

			// Two writes create again, at once, two dangling paths of one blob that sort next to each other, while
			// the sweep runs, paused before its first blob-table statement. A build that keeps no references deleted
			// the two rows; InnoDB keeps them delete-marked until purge, held back here by a read view another
			// connection keeps open until both writes have reached the server. At 726a4311 the sweep held a share lock
			// on each delete-marked row (`lockSessionRows`), so each write waited in its insert's duplicate check;
			// purge then removed both rows and made each write's waiting lock a gap lock before the next row, and
			// each write waited to insert into the gap the other held: a deadlock, after which one write ran again.
			// The sweep now locks no session row, so neither write waits for it.
			it.skipIf(adapter !== "mysql")(
				"creates again two dangling paths of one gap while the sweep runs and purge removes their rows, with no deadlock or retry",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const storage = await db.open();
					let gate: GatedClient | undefined;
					const sweeper = await db.open({
						wrap: client => {
							gate = gatedClient(client, /^SELECT .* FROM \S*_blobs\b/, "before");
							return gate.client;
						},
					});
					const deadlocks: string[] = [];
					const queries: string[][] = [[], []];
					const writers = [
						await db.open({
							wrap: client => deadlockLog(recordingClient(client, queries[0] as string[]), deadlocks),
						}),
						await db.open({
							wrap: client => deadlockLog(recordingClient(client, queries[1] as string[]), deadlocks),
						}),
					];
					const sessionRow = new RegExp(`^INSERT (?:IGNORE )?INTO \\S*\\b${db.table} \\(`);
					const p = await writeImageSession(db, storage, [IMAGE_BYTES]);
					const content = (await db.row(p))?.content ?? "";
					const [a, k1, k2, z] = ["a", "k1", "k2", "z"].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [
						string,
						string,
						string,
						string,
					];
					for (const path of [a, k1, k2, z]) await storage.writeText(path, content);
					await storage.drain();

					const releasePurge = await holdPurge(db);
					let early: string | undefined;
					let sweeping: Promise<unknown> | undefined;
					let writing: Promise<unknown> | undefined;
					try {
						for (const path of [k1, k2]) {
							await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [path]);
							await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [path]);
						}
						gate?.close();
						sweeping = sweeper.blobTier.sweep(new Set(), 0, true);
						await Promise.race([gate?.paused(), sweeping]);
						let settled = false;
						writing = Promise.all(
							writers.map((writer, index) =>
								writer.writeText(index === 0 ? k1 : k2, content).then(() => writer.drain()),
							),
						).finally(() => {
							settled = true;
						});
						// A real wait: what is measured is whether the writes meet a lock of the sweep's on the server.
						early = await Promise.race([
							writing.then(() => "written"),
							Bun.sleep(1000).then(() => "waiting for the sweep"),
						]);
						await releasePurge();
						// Purge runs when InnoDB schedules it, and shows only in what it does to writes still waiting
						// here: both waiting writes deadlock once it has removed the rows.
						await until(() => settled || deadlocks.length > 0, 30_000).catch(() => undefined);
					} finally {
						await releasePurge();
						gate?.open();
					}
					await Promise.all([writing, sweeping]);
					expect({
						early,
						deadlocks,
						writerSessionRowInserts: queries.map(list => list.filter(query => sessionRow.test(query)).length),
						paths: await db.paths(),
						refs: (await db.sql(`SELECT path, sha256 FROM ${db.table}_refs ORDER BY path`)).map(found => [
							String(found.path),
							String(found.sha256),
						]),
					}).toEqual({
						early: "written",
						deadlocks: [],
						writerSessionRowInserts: [1, 1],
						paths: [p, a, k1, k2, z],
						refs: [p, a, k1, k2, z].map(path => [path, IMAGE_HASH]),
					});
				},
			);

			// The sweep reads the session rows only after it locks the blob's row: a write that creates a dangling
			// path again, naming the blob, and commits while the sweep waits at that lock keeps its reference. A read
			// before the lock (of the blob rows or the session rows) would fix MySQL's snapshot before that write
			// committed, and the sweep would drop the reference the write had just added.
			it("keeps the reference of a write that creates a dangling path again while the sweep waits to lock the blob's row", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const storage = await db.open();
				let gate: GatedClient | undefined;
				const sweeper = await db.open({
					wrap: client => {
						gate = gatedClient(client, BLOB_EXCLUSIVE_LOCK, "before");
						return gate.client;
					},
				});
				const p = await writeImageSession(db, storage, [IMAGE_BYTES]);
				const content = (await db.row(p))?.content ?? "";
				await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [p]);
				await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [p]);

				gate?.close();
				const sweeping = sweeper.blobTier.sweep(new Set(), 0, true);
				let writing: Promise<unknown> | undefined;
				let first: string | undefined;
				try {
					await Promise.race([gate?.paused(), sweeping]);
					writing = storage.writeText(p, content).then(() => storage.drain());
					// A real wait: what is measured is whether the write meets a lock of the sweep's on the server.
					first = await Promise.race([
						writing.then(() => "written"),
						Bun.sleep(1000).then(() => "waiting for the sweep"),
					]);
				} finally {
					gate?.open();
				}
				await Promise.all([writing, sweeping]);
				expect({
					first,
					blobs: await blobHashes(db),
					refs: (await db.sql(`SELECT path, sha256 FROM ${db.table}_refs`)).map(found => [
						String(found.path),
						String(found.sha256),
					]),
				}).toEqual({
					// SQLite runs one writer at a time.
					first: adapter === "sqlite" ? "waiting for the sweep" : "written",
					blobs: [IMAGE_HASH],
					refs: [[p, IMAGE_HASH]],
				});
			});

			// A rename onto a dangling path whose row InnoDB keeps delete-marked (purge held back) while the sweep
			// runs: S sorts after D, and both had references to the blob. At 726a4311 the sweep, paused after locking
			// D's delete-marked row shared, then wanted S's row, which the rename held; the rename held S and its
			// UPDATE waited for D's key, outside path order: a deadlock (seen on MariaDB in the soak). The sweep now
			// locks no session row, so there is nothing for it to pause at, and neither transaction waits for the other.
			it.skipIf(adapter !== "mysql")(
				"renames a session onto a dangling path, delete-marked until purge, while the sweep runs, with no deadlock or retry",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const deadlocks: string[] = [];
					const storage = await db.open({ wrap: client => deadlockLog(client, deadlocks) });
					let gate: GatedClient | undefined;
					const sweeper = await db.open({
						wrap: client => {
							gate = gatedClient(
								deadlockLog(client, deadlocks),
								new RegExp(`FROM \\S*\\b${db.table} WHERE .*LOCK IN SHARE MODE$`),
							);
							return gate.client;
						},
					});
					const p = await writeImageSession(db, storage, [IMAGE_BYTES]);
					const content = (await db.row(p))?.content ?? "";
					const [d, s] = ["d", "s"].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [string, string];
					for (const path of [d, s]) await storage.writeText(path, content);
					await storage.drain();

					const releasePurge = await holdPurge(db);
					let renaming: Promise<unknown> | undefined;
					let sweeping: Promise<unknown> | undefined;
					try {
						for (const path of [d, s]) {
							await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [path]);
							await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [path]);
						}
						await storage.refresh();
						gate?.close();
						sweeping = sweeper.blobTier.sweep(new Set(), 0, true);
						await Promise.race([gate?.paused(), sweeping]);
						await storage.writeText(s, content);
						renaming = storage.rename(s, d);
						// A real wait: what is measured is whether the rename meets a lock of the sweep's on the server.
						await Promise.race([renaming, Bun.sleep(1000)]);
					} finally {
						gate?.open();
						await releasePurge();
					}
					await Promise.all([renaming, sweeping]);
					expect({
						deadlocks,
						paths: await db.paths(),
						d: (await db.row(d))?.content,
						refs: (await db.sql(`SELECT path, sha256 FROM ${db.table}_refs ORDER BY path`)).map(found => [
							String(found.path),
							String(found.sha256),
						]),
					}).toEqual({
						deadlocks: [],
						paths: [p, d],
						d: content,
						refs: [p, d].map(path => [path, IMAGE_HASH]),
					});
				},
			);

			// A replacing rename whose destination another client creates after the rename read which rows there
			// are, paused just before its UPDATE: on MySQL and MariaDB a destination with no row is not locked, and
			// PostgreSQL locks no row that is not there, so the UPDATE meets the new row on the primary key (1062,
			// 23505). `rename` replaces its destination, so it runs again, and the next attempt locks and replaces
			// that row.
			it.skipIf(adapter === "sqlite")(
				"replaces, through rename, a destination another client creates after the rename read which rows there are",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					let gate: GatedClient | undefined;
					const renamer = await db.open({
						claims: false,
						wrap: client => {
							gate = gatedClient(client, new RegExp(`^UPDATE \\S*\\b${db.table} SET path\\b`), "before");
							return gate.client;
						},
					});
					const other = await db.open({ claims: false });
					const [src, dst] = ["a-src", "b-dst"].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [
						string,
						string,
					];
					const moved = transcript(ID, "moved");
					await renamer.writeText(src, moved);
					await renamer.drain();

					gate?.close();
					const renaming = renamer.rename(src, dst).then(
						() => undefined,
						(err: unknown) => err,
					);
					try {
						await Promise.race([gate?.paused(), renaming]);
						await other.writeText(dst, transcript(ID, "created meanwhile"));
						await other.drain();
					} finally {
						gate?.open();
					}
					const error = await renaming;
					expect({
						error: error instanceof Error ? error.message : error,
						paths: await db.paths(),
						dst: (await db.row(dst))?.content,
					}).toEqual({ error: undefined, paths: [dst], dst: moved });
				},
			);

			// A replacing rename whose every attempt meets a destination created after its read: the collision is
			// injected into each attempt's UPDATE (T4 above is the real one). After as many attempts as a
			// deadlock's retry (5), the rename rejects with SessionRenameRaceError, the last collision its cause,
			// and nothing changed.
			it("rejects with SessionRenameRaceError, changing nothing, a rename whose every attempt meets a new destination", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const renameRow = new RegExp(`^UPDATE \\S*\\b${db.table} SET path\\b`);
				let collisions = 0;
				const collide = (query: string): void => {
					if (!renameRow.test(query)) return;
					collisions++;
					throw Object.assign(
						new Error("Duplicate entry (injected)"),
						{
							mysql: { errno: 1062 },
							postgres: { errno: "23505" },
							sqlite: { code: "SQLITE_CONSTRAINT_PRIMARYKEY" },
						}[adapter],
					);
				};
				const renamer = await db.open({
					claims: false,
					wrap: client => ({
						options: client.options,
						unsafe: (query, values) => client.unsafe(query, values),
						transaction: callback =>
							client.transaction(transaction =>
								callback({
									unsafe(query, values) {
										collide(query);
										return transaction.unsafe(query, values);
									},
								}),
							),
						end: () => client.end?.() ?? Promise.resolve(),
					}),
				});
				const [src, dst] = ["a-src", "b-dst"].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [
					string,
					string,
				];
				const content = transcript(ID, "not moved");
				await renamer.writeText(src, content);
				await renamer.drain();

				const error = await rejection(renamer.rename(src, dst));
				expect({
					name: error instanceof Error ? error.name : undefined,
					raced: error instanceof SessionRenameRaceError ? [error.src, error.dst, error.attempts] : undefined,
					cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
					collisions,
					paths: await db.paths(),
					src: (await db.row(src))?.content,
				}).toEqual({
					name: "SessionRenameRaceError",
					raced: [src, dst, 5],
					cause: "Duplicate entry (injected)",
					collisions: 5,
					paths: [src],
					src: content,
				});
			});

			// The one deadlock the lock order leaves (docs/session.md, "Races"): a rename whose destination has no
			// row takes that key by its UPDATE, after the source's lock, and a delete with the artifacts directory
			// locks, on MySQL and MariaDB, the rows under the directory and the gaps around them, in path order. The
			// rename D → B, both under the directory of A, is paused before its UPDATE, holding D; the delete of A
			// with its artifacts locks A, then M with the gap before it, where B goes, and waits for D; the rename's
			// UPDATE then waits for that gap. InnoDB rolls one back, and the deadlock retry runs it again: they end
			// as one after the other does, the rename first (the delete then takes B) or the delete first (the
			// rename then finds no D).
			it.skipIf(adapter !== "mysql")(
				"deadlocks once, and runs the rolled-back side again, when a delete with artifacts locks the gap of a rename's destination under the directory",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					const deadlocks: string[] = [];
					let gate: GatedClient | undefined;
					const renamer = await db.open({
						claims: false,
						wrap: client => {
							gate = gatedClient(
								deadlockLog(client, deadlocks),
								new RegExp(`^UPDATE \\S*\\b${db.table} SET path\\b`),
								"before",
							);
							return gate.client;
						},
					});
					const deleter = await db.open({ claims: false, wrap: client => deadlockLog(client, deadlocks) });
					const [a, c] = ["a", "c"].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [string, string];
					const [b, m, d] = ["b-dst", "m", "z-src"].map(name => db.dir.join("sessions", "a", `${name}.jsonl`)) as [
						string,
						string,
						string,
					];
					for (const path of [a, m, d, c]) await renamer.writeText(path, transcript(ID, "kept apart"));
					await renamer.drain();
					await deleter.refresh();

					gate?.close();
					const renaming = renamer.rename(d, b).then(
						() => "renamed",
						(err: unknown) => (err instanceof Error && "code" in err ? String(err.code) : String(err)),
					);
					let deleting: Promise<void> | undefined;
					try {
						await Promise.race([gate?.paused(), renaming]);
						deleting = deleter.deleteSessionWithArtifacts(a);
						// A real wait: the delete's lock must reach the rename's row on the server before the UPDATE runs.
						await Promise.race([deleting, Bun.sleep(1000)]);
					} finally {
						gate?.open();
					}
					const [renamed] = await Promise.all([renaming, deleting]);
					expect({ deadlocks: deadlocks.length, paths: await db.paths() }).toEqual({ deadlocks: 1, paths: [c] });
					// The rename first, or the delete first, which leaves it no source.
					expect(["renamed", "ENOENT"]).toContain(renamed);
				},
			);

			// A delete with the artifacts directory locks, on MySQL and MariaDB, the session rows under the directory
			// by its key range: those rows, the gaps between them and the gaps at either end, up to the nearest row
			// outside (MariaDB locks the first row past the range too). Another session's row, or a gap away from the
			// directory, is not locked: its writes commit while the delete runs.
			it.skipIf(adapter !== "mysql")(
				"commits another client's append, full write and new session away from the directory while a delete with artifacts holds its locks",
				async () => {
					// If this regresses, on MySQL and MariaDB a session delete with its artifacts locks every row and gap of
					// the session table until it commits: every other session's append, full write and new session on that
					// database waits for it.
					await using db = await openLeaseDb(adapter, url ?? "");
					let gate: GatedClient | undefined;
					const deleter = await db.open({
						claims: false,
						wrap: client => {
							gate = gatedClient(
								client,
								new RegExp(`^SELECT path FROM \\S*\\b${db.table} WHERE path IN \\(.* FOR UPDATE$`),
							);
							return gate.client;
						},
					});
					const other = await db.open({ claims: false });
					// Sorted: the session before the deleted one, the deleted one and its transcript, the next session (by
					// which the directory's range ends), one after it, and a new session at the end.
					const [before, deleted, next, after, fresh] = [
						"a-before",
						"b-deleted",
						"c-next",
						"d-after",
						"e-fresh",
					].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [string, string, string, string, string];
					const child = db.dir.join("sessions", "b-deleted", "task.jsonl");
					const kept = transcript(ID, "kept");
					for (const path of [before, deleted, child, next, after]) await deleter.writeText(path, kept);
					await deleter.drain();
					await other.refresh();
					const line = `${JSON.stringify({ type: "custom", customType: "note", data: "appended" })}\n`;
					const rewritten = transcript(ID, "rewritten");
					const created = transcript(ID, "created");
					// Whether `write` commits within 10 s while the delete holds its locks. A real wait: a write that waits
					// for a lock sits in the server, which tells the client nothing until the lock wait ends (50 s).
					const outcome = (write: () => Promise<void>): Promise<string> =>
						Promise.race([
							write().then(() => "committed"),
							Bun.sleep(10_000).then(() => "waited for the delete"),
						]);

					gate?.close();
					const deleting = deleter.deleteSessionWithArtifacts(deleted);
					let writes: string[] = [];
					let seen: Record<string, string | undefined> = {};
					try {
						await Promise.race([gate?.paused(), deleting]);
						writes = await Promise.all([
							outcome(async () => {
								const writer = other.openWriter(before);
								await writer.append(line);
								await writer.close();
							}),
							outcome(() => other.writeText(after, rewritten)),
							outcome(() => other.writeText(fresh, created)),
						]);
						seen = {
							before: (await db.row(before))?.content,
							after: (await db.row(after))?.content,
							fresh: (await db.row(fresh))?.content,
						};
					} finally {
						gate?.open();
					}
					await deleting;
					await other.drain();
					expect({ writes, seen, paths: await db.paths() }).toEqual({
						writes: ["committed", "committed", "committed"],
						seen: { before: kept + line, after: rewritten, fresh: created },
						paths: [before, next, after, fresh],
					});
				},
				120_000,
			);

			// A rename moves its source's references one key at a time, from a read after it locks the source's row:
			// another client's append that adds a reference to the source and commits while the rename waits to lock
			// it is in that read, so its reference moves too. On MySQL a read without a lock inside the rename's
			// transaction before that lock would fix the snapshot first, and the appended reference would stay behind.
			it.skipIf(adapter === "sqlite")(
				"moves every reference of a source another client appends to while the rename waits to lock it",
				async () => {
					await using db = await openLeaseDb(adapter, url ?? "");
					let gate: GatedClient | undefined;
					const renamer = await db.open({
						claims: false,
						wrap: client => {
							gate = gatedClient(
								client,
								new RegExp(`^SELECT path FROM \\S*\\b${db.table} WHERE path IN \\(.* FOR UPDATE$`),
								"before",
							);
							return gate.client;
						},
					});
					const appender = await db.open({ claims: false });
					const [first, second] = [imageBytes(1), imageBytes(2)];
					for (const data of [first, second]) renamer.blobTier.store(sha256(data), data, "image/png");
					await renamer.drain();
					const [src, dst] = ["a-src", "b-dst"].map(name => db.dir.join("sessions", `${name}.jsonl`)) as [
						string,
						string,
					];
					await renamer.writeText(src, transcript(ID, `blob:sha256:${sha256(first)}`));
					await renamer.drain();
					await appender.refresh();

					gate?.close();
					const renaming = renamer.rename(src, dst);
					try {
						await Promise.race([gate?.paused(), renaming]);
						const writer = appender.openWriter(src);
						await writer.append(transcript(ID, `blob:sha256:${sha256(second)}`));
						await writer.close();
					} finally {
						gate?.open();
					}
					await renaming;
					expect({
						paths: await db.paths(),
						refs: (await db.sql(`SELECT path, sha256 FROM ${db.table}_refs ORDER BY sha256`)).map(found => [
							String(found.path),
							String(found.sha256),
						]),
					}).toEqual({
						paths: [dst],
						refs: [sha256(first), sha256(second)].sort().map(hash => [dst, hash]),
					});
				},
			);

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
		// The bound is the packet less 1 MiB: the large image's own row and its two parts, in one pass in hash
		// order (a delete locks them in that order too), then the small one.
		expect(inserted).toEqual([
			...[sha256(large), sha256(large.subarray(0, MIB)), sha256(large.subarray(MIB))].sort(),
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
