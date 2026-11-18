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
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
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
/** The statement that writes a blob row, whatever the dialect quotes its table name with. */
const BLOB_INSERT = /^INSERT INTO \S*_blobs\b/;
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

/** `client`, whose first statement `pattern` matches fails as a reset connection does. */
function failingOnce(client: SqlSessionStorageClient, pattern: RegExp): SqlSessionStorageClient {
	let failed = false;
	const check = (query: string): void => {
		if (failed || !pattern.test(query)) return;
		failed = true;
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

			it("lands a blob whose first write fails, so a resume elsewhere still gets the image", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const sessionDir = db.dir.join("sessions");
				const storage = await db.open({ wrap: client => failingOnce(client, BLOB_INSERT) });
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
				expect(queries.filter(query => query.includes("SELECT sha256, content FROM"))).toHaveLength(2);
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
					const others = `${db.table}, ${db.table}_parts, ${db.leaseTable}`;
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

	it("leaves out, with a warning, a blob larger than a MySQL server's max_allowed_packet takes, and stores one that fits", async () => {
		const MIB = 1024 * 1024;
		const inserted: unknown[] = [];
		const columns = ["path", "content", "mtime_ms", "title", "title_source", "title_updated_at", "byte_len"];
		const answer = (sql: string, values: unknown[] | undefined): SqlSessionStorageResult => {
			if (sql.includes(" AS column_name FROM ")) return columns.map(column_name => ({ column_name }));
			if (sql === "SELECT VERSION() AS version") return [{ version: "8.4.13" }];
			if (sql.startsWith("SELECT @@max_allowed_packet")) return [{ max_packet: 2 * MIB }];
			if (BLOB_INSERT.test(sql)) {
				inserted.push(values?.[0]);
				return Object.assign([], { affectedRows: 1 });
			}
			return [];
		};
		const executor: SqlSessionStorageTransaction = { unsafe: async (sql, values) => answer(sql, values) };
		const client: SqlSessionStorageClient = {
			options: { adapter: "mysql" },
			unsafe: executor.unsafe,
			transaction: callback => callback(executor),
		};
		const storage = await SqlSessionStorage.create({ client, claims: false });
		const warn = vi.spyOn(logger, "warn");
		const large = Buffer.alloc(1.5 * MIB, 1);
		const small = Buffer.alloc(MIB / 4, 2);

		storage.blobTier.store(sha256(large), large, "image/png");
		storage.blobTier.store(sha256(small), small, "image/png");
		await storage.drain();
		expect(inserted).toEqual([sha256(small)]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("larger than the session database takes"),
			expect.objectContaining({ hash: sha256(large), bytes: large.byteLength, limit: MIB }),
		);
	});
});

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
