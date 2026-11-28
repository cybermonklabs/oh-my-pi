/**
 * `readSessionTextFrom` on {@link SqlSessionStorage}: the text from a byte
 * offset, at most `maxBytes` of it, and the size the read saw. Tails (the Agent
 * Hub viewer, the activity feed, collab transcript pages) call it on every
 * poll, so it must return exactly the bytes a file read returns while fetching
 * only the bytes it returns, not the whole session. Runs against SQLite always,
 * and against PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a throwaway database. Each case's clients,
 * writers and tables are released after it, each release tried whatever the
 * others did, and every case has a timeout of its own.
 */
import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import {
	FileSessionStorage,
	readSessionTextFrom,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

type SqlClient = InstanceType<typeof SQL>;

const MiB = 1024 * 1024;

const BACKENDS: ReadonlyArray<{ adapter: SqlSessionStorageAdapter; url: string | undefined }> = [
	{ adapter: "sqlite", url: "sqlite::memory:" },
	{ adapter: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ adapter: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
];

let tableSeq = 0;

/**
 * One test's database: a fresh table name, and the releases that end each client it makes and drop the table, each
 * tried whatever the others did, their errors thrown together.
 */
class Db implements AsyncDisposable {
	readonly table = `omp_read_from_${process.pid}_${Date.now().toString(36)}_${tableSeq++}`;
	readonly client: SqlClient;
	readonly #cleanup = new AsyncDisposableStack();

	constructor(
		readonly adapter: SqlSessionStorageAdapter,
		readonly url: string,
	) {
		const client = new SQL(url);
		this.client = client;
		this.#cleanup.defer(() => client.end());
		// Registered after the first client and before any other, so the tables go after every other client ends and
		// before the first does; SQLite's in-memory database goes with it.
		for (const name of [this.table, `${this.table}_refs`, `${this.table}_blobs`, `${this.table}_parts`]) {
			this.#cleanup.defer(async () => {
				await client.unsafe(`DROP TABLE IF EXISTS ${name}`);
			});
		}
	}

	/** A second client of the same database; SQLite's in-memory database lives only on the first. */
	connect(): SqlClient {
		if (this.adapter === "sqlite") return this.client;
		const client = new SQL(this.url);
		this.#cleanup.defer(() => client.end());
		return client;
	}

	open(client: SqlSessionStorageClient = this.client): Promise<SqlSessionStorage> {
		return SqlSessionStorage.create({ client, table: this.table });
	}

	/** Run `release` (a writer's close) among the database's releases, before the clients it uses end. */
	defer(release: () => Promise<void>): void {
		this.#cleanup.defer(release);
	}

	/** Run fixture SQL written with `?` placeholders on any dialect. */
	async sql(query: string, values: unknown[] = []): Promise<void> {
		let n = 0;
		const text = this.adapter === "postgres" ? query.replace(/\?/g, () => `$${++n}`) : query;
		await this.client.unsafe(text, values);
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.#cleanup.disposeAsync();
	}
}

/** Every `[offset, maxBytes]` read must equal what {@link FileSessionStorage} returns for the same bytes on disk. */
async function expectReadsMatchFile(
	storage: SessionStorage,
	path: string,
	content: string,
	reads: ReadonlyArray<readonly [number, number | undefined]>,
): Promise<void> {
	using dir = TempDir.createSync("@omp-sql-read-from-");
	const file = dir.join("session.jsonl");
	await Bun.write(file, content);
	const reference = new FileSessionStorage();
	for (const [offset, maxBytes] of reads) {
		expect({ offset, maxBytes, read: await readSessionTextFrom(storage, path, offset, maxBytes) }).toEqual({
			offset,
			maxBytes,
			read: await readSessionTextFrom(reference, file, offset, maxBytes),
		});
	}
}

/** Reads starting within two bytes either side of each boundary, uncapped and with caps ending around the next one. */
function readsAround(boundaries: readonly number[]): Array<[number, number | undefined]> {
	const reads: Array<[number, number | undefined]> = [];
	for (const at of boundaries) {
		for (const delta of [-2, -1, 0, 1, 2]) {
			for (const maxBytes of [undefined, 0, 1, 3, 4, 7]) reads.push([Math.max(0, at + delta), maxBytes]);
		}
	}
	return reads;
}

for (const { adapter, url } of BACKENDS) {
	describe.skipIf(!url)(`SqlSessionStorage reads from an offset (${adapter})`, () => {
		const connect = (): Db => new Db(adapter, url ?? "");

		it("returns the bytes a file read returns inside parts, across part edges, and past the end", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/tail.jsonl";
			// Three-byte characters put the 1 MiB split point mid-character, so the
			// full write's first part ends one byte early; each append is a part.
			const body = "€".repeat(400_000);
			const appends = ["😀a\n", "€b\n", "😀😀\n"];
			await storage.writeText(path, body);
			const writer = storage.openWriter(path);
			db.defer(() => writer.close());
			for (const line of appends) await writer.append(line);
			await writer.close();

			const content = body + appends.join("");
			const size = Buffer.byteLength(content);
			await expectReadsMatchFile(storage, path, content, [
				[0, undefined],
				[0, 5],
				[0, MiB + 10],
				[size, undefined],
				[size, 4],
				[size + 7, undefined],
				[size - 1, undefined],
				// From inside the first part into the appended parts.
				[MiB - 4, 4_000_000],
				...readsAround([MiB - 1, 1_200_000, 1_200_006, 1_200_011]),
			]);
		}, 60_000);

		// If this regresses, a window from a negative offset of an untitled legacy row reads other bytes than this
		// store always has: it reads the row's own content from where the database's `substr` puts position
		// `offset + 1` (SQLite and MySQL count a negative position from the end; PostgreSQL keeps the positions from
		// 1 the window reaches), then every part appended after it that starts before the window's end.
		it("reads a legacy row's own content and the parts appended after it", async () => {
			await using db = connect();
			const legacyTable =
				adapter === "mysql"
					? `CREATE TABLE ${db.table} (path VARCHAR(512) NOT NULL PRIMARY KEY, content LONGTEXT NOT NULL, ` +
						`mtime_ms BIGINT NOT NULL, title TEXT NULL, title_source VARCHAR(16) NULL, title_updated_at VARCHAR(64) NULL` +
						`) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
					: `CREATE TABLE ${db.table} (path TEXT PRIMARY KEY, content TEXT NOT NULL, ` +
						`mtime_ms ${adapter === "postgres" ? "BIGINT" : "INTEGER"} NOT NULL, ` +
						`title TEXT, title_source TEXT, title_updated_at TEXT)`;
			await db.sql(legacyTable);
			const path = "/sessions/p/legacy.jsonl";
			const legacyBody = '{"type":"session","id":"g"}\n€€';
			await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms) VALUES (?, ?, ?)`, [path, legacyBody, 1]);
			const storage = await db.open();
			const negativeWindows = [
				[-4, undefined],
				[-7, undefined],
				[-4, 3],
				[-4, 10],
			] as const;
			const readNegative = async (): Promise<unknown[]> => {
				const reads: unknown[] = [];
				for (const [offset, maxBytes] of negativeWindows) {
					reads.push({ offset, maxBytes, read: await storage.readTextFrom(path, offset, maxBytes) });
				}
				return reads;
			};
			const withoutParts = await readNegative();
			const writer = storage.openWriter(path);
			db.defer(() => writer.close());
			await writer.append("😀 one\n");
			await writer.append("€ two\n");
			await writer.close();
			const withParts = await readNegative();

			const content = `${legacyBody}😀 one\n€ two\n`;
			const legacyEnd = Buffer.byteLength(legacyBody);
			const fromEnd = adapter !== "postgres";
			const parts = "😀 one\n€ two\n";
			const expectedNegative = (texts: readonly string[], size: number): unknown[] =>
				negativeWindows.map(([offset, maxBytes], index) => ({
					offset,
					maxBytes,
					read: { text: texts[index], size },
				}));
			expect({ withoutParts, withParts }).toEqual({
				withoutParts: expectedNegative(
					fromEnd ? ["€", "€€", "€", "€"] : [legacyBody, legacyBody, "", '{"type'],
					legacyEnd,
				),
				withParts: expectedNegative(
					fromEnd ? [`€${parts}`, `€€${parts}`, "€", "€"] : [content, content, "", '{"type'],
					Buffer.byteLength(content),
				),
			});
			await expectReadsMatchFile(storage, path, content, [
				[0, undefined],
				[5, 10],
				[5, 100],
				...readsAround([legacyEnd, legacyEnd + 3, legacyEnd + 11, Buffer.byteLength(content)]),
			]);
		}, 60_000);

		// If this regresses, a session whose title time is a space (which MySQL and MariaDB compare equal to `''` under
		// the table's collation) is read by the statement as untitled while the read lays its title over the bytes as a
		// titled one's: a window from a negative offset leaves out the first byte of the part appended at the title
		// slot's end. The statement takes a title time by its byte length, as the read does.
		it("reads a session whose title time is a space as titled, in the statement and in the title it lays over", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/space-time.jsonl";
			// As long as the title slot: the part appended next starts where the slot ends.
			const body = `${"a".repeat(255)}\n`;
			await storage.writeText(path, body);
			const writer = storage.openWriter(path);
			db.defer(() => writer.close());
			await writer.append("X\n");
			await writer.close();
			await db.sql(`UPDATE ${db.table} SET title = ?, title_source = ?, title_updated_at = ? WHERE path = ?`, [
				"Spaced",
				"user",
				" ",
				path,
			]);
			const title = { title: "Spaced", source: "user" as const, updatedAt: " " };
			const text = Buffer.concat([Buffer.from(serializeTitleSlot(title)), Buffer.from(`${body}X\n`).subarray(256)]);

			const reader = await db.open(db.connect());
			expect(await reader.readTextFrom(path, -2, 257)).toEqual({
				text: text.subarray(0, 257).toString("utf8"),
				size: text.byteLength,
			});
		}, 60_000);

		// If this regresses, a tail or a page of a renamed session that starts at, inside or past its title slot
		// shows bytes or a size other than the session's own text, the old title, or a chunked read or line scan of
		// it gives other bytes than the whole read.
		it("shows the title the store holds in a read that starts inside the title slot, and every window, chunked read and line scan agrees with readText", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/titled.jsonl";
			const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
			await storage.writeText(
				path,
				`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
			);
			const writer = storage.openWriter(path);
			db.defer(() => writer.close());
			await writer.append(`${JSON.stringify({ type: "message", id: "m", text: "€😀 tail" })}\n`);
			await writer.close();
			await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });

			for (const view of [storage, await db.open()]) {
				const whole = Buffer.from(await view.readText(path));
				const windows: unknown[] = [];
				const expected: unknown[] = [];
				for (const [offset, maxBytes] of [
					[0, undefined],
					[0, 0],
					[0, 40],
					[20, 30],
					[100, 0],
					[200, 100],
					[255, 1],
					[255, 10],
					[256, undefined],
					[256, 0],
					[256, 8],
					[300, 5],
					[whole.byteLength, 4],
					[whole.byteLength + 9, undefined],
				] as const) {
					const end = maxBytes === undefined ? undefined : offset + maxBytes;
					windows.push({ offset, maxBytes, read: await readSessionTextFrom(view, path, offset, maxBytes) });
					expected.push({
						offset,
						maxBytes,
						read: { text: whole.subarray(offset, end).toString("utf8"), size: whole.byteLength },
					});
				}
				const chunks: Array<{ from: number; text: string }> = [];
				for (const from of [0, 10, 255, 256, 300]) {
					chunks.push({
						from,
						text: Buffer.concat(await Array.fromAsync(view.readChunks(path, from))).toString("utf8"),
					});
				}
				const lines: string[] = [];
				await view.scanLines(path, line => {
					lines.push(line);
					return false;
				});
				expect({
					windows,
					headSlice: (await view.readTextSlices(path, 300, 0))[0],
					suffix: (await view.readTextSlices(path, 0, 20))[1],
					chunks,
					lines,
				}).toEqual({
					windows: expected,
					headSlice: whole.subarray(0, 300).toString("utf8"),
					suffix: whole.subarray(whole.byteLength - 20).toString("utf8"),
					chunks: [0, 10, 255, 256, 300].map(from => ({ from, text: whole.subarray(from).toString("utf8") })),
					lines: whole.toString("utf8").split("\n"),
				});
				expect((await readSessionTextFrom(view, path, 0, 256)).text).toContain('"title":"New"');
			}
		}, 60_000);

		// If this regresses, a titled session whose stored body is empty (its writer emptied it after a rename)
		// reads with a size under its title slot's, or a window, chunk or slice of it shows other bytes than the slot.
		it("reads a titled session with an empty stored body as its title slot alone", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/empty-titled.jsonl";
			await storage.writeText(path, "");
			const title = { title: "Titled but empty", source: "user" as const, updatedAt: "t2" };
			await storage.updateSessionTitle(path, title);
			const slot = Buffer.from(serializeTitleSlot(title));

			const windows: unknown[] = [];
			for (const [offset, maxBytes] of [
				[0, undefined],
				[0, 10],
				[100, undefined],
				[255, 1],
				[256, undefined],
				[300, 4],
			] as const) {
				windows.push({ offset, maxBytes, read: await readSessionTextFrom(storage, path, offset, maxBytes) });
			}
			expect({
				text: await storage.readText(path),
				windows,
				slices: await storage.readTextSlices(path, 300, 10),
				chunks: [
					Buffer.concat(await Array.fromAsync(storage.readChunks(path))).toString("utf8"),
					Buffer.concat(await Array.fromAsync(storage.readChunks(path, 200))).toString("utf8"),
				],
			}).toEqual({
				text: slot.toString("utf8"),
				windows: [
					{ offset: 0, maxBytes: undefined, read: { text: slot.toString("utf8"), size: 256 } },
					{ offset: 0, maxBytes: 10, read: { text: slot.subarray(0, 10).toString("utf8"), size: 256 } },
					{ offset: 100, maxBytes: undefined, read: { text: slot.subarray(100).toString("utf8"), size: 256 } },
					{ offset: 255, maxBytes: 1, read: { text: "\n", size: 256 } },
					{ offset: 256, maxBytes: undefined, read: { text: "", size: 256 } },
					{ offset: 300, maxBytes: 4, read: { text: "", size: 256 } },
				],
				// The suffix is the stored one.
				slices: [slot.toString("utf8"), ""],
				chunks: [slot.toString("utf8"), slot.subarray(200).toString("utf8")],
			});
		}, 60_000);

		it("reads a titled session's window as its stored bytes with the title's slot laid over them, cut there, where the cut splits a character", async () => {
			await using db = connect();
			const storage = await db.open();
			const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
			// The stored slot's title puts "é" at bytes 34-35, so a window ending at byte 35 splits it.
			const storedSlot = serializeTitleSlot({ title: "Café", source: "auto", updatedAt: "t1" });
			const sessions = [
				{ path: "/sessions/p/ascii.jsonl", body: `${storedSlot}${header}`, title: "New" },
				// "Ü" at bytes 31-32 of the slot this title gives.
				{ path: "/sessions/p/unicode.jsonl", body: `${storedSlot}${header}`, title: "Ünïcödé ☕" },
				// No slot: the overlay ends inside the "é" at bytes 255-256.
				{ path: "/sessions/p/split.jsonl", body: `${"a".repeat(255)}é${"b".repeat(40)}\n`, title: "New" },
			];
			// The bytes a window is cut from: the slot of the session's title over the stored head, and the stored
			// bytes past it as they are, a character the slot's end splits included.
			const texts = new Map<string, Buffer>();
			for (const { path, body, title } of sessions) {
				const update = { title, source: "user" as const, updatedAt: "t2" };
				await storage.writeText(path, body);
				await storage.updateSessionTitle(path, update);
				const slot = Buffer.from(serializeTitleSlot(update));
				texts.set(path, Buffer.concat([slot, Buffer.from(body).subarray(slot.length)]));
			}

			// Every window compared at once, so a failure shows each one.
			const read: Array<{ path: string; offset: number; maxBytes: number; text: string }> = [];
			const cut: typeof read = [];
			for (const [path, offset, maxBytes] of [
				["/sessions/p/ascii.jsonl", 0, 35],
				["/sessions/p/unicode.jsonl", 0, 35],
				["/sessions/p/unicode.jsonl", 32, 0],
				["/sessions/p/split.jsonl", 0, 256],
				["/sessions/p/split.jsonl", 0, 260],
			] as const) {
				const { text } = await readSessionTextFrom(storage, path, offset, maxBytes);
				read.push({ path, offset, maxBytes, text });
				const titled = texts.get(path) ?? Buffer.alloc(0);
				cut.push({ path, offset, maxBytes, text: titled.subarray(offset, offset + maxBytes).toString("utf8") });
			}
			expect(read).toEqual(cut);
		}, 60_000);

		it("reads what another client appended after this store loaded its index, with the size it read", async () => {
			await using db = connect();
			const storage = await db.open();
			const path = "/sessions/p/shared.jsonl";
			await storage.writeText(path, "first line\n");
			const peer = await db.open(db.connect());
			const peerWriter = peer.openWriter(path);
			db.defer(() => peerWriter.close());
			await peerWriter.append("peer line\n");
			await peerWriter.close();

			// This store's index still says 11 bytes; the read reports what it read.
			expect(storage.statSync(path).size).toBe(11);
			expect(await readSessionTextFrom(storage, path, 11)).toEqual({ text: "peer line\n", size: 21 });
			expect(await readSessionTextFrom(storage, path, 6, 9)).toEqual({ text: "line\npeer", size: 21 });
		}, 60_000);

		// If this regresses, an untitled row starting with a UTF-8 BOM loses its leading three bytes in the backend's
		// decode, so `readTextFrom(path, 3, 2)` slices past the decoded text and returns "" instead of "ab". A window
		// that starts at a BOM, at byte 0 or past the slot, decodes as a file read's does, without it.
		it("keeps byte offsets aligned after a leading UTF-8 BOM on untitled rows", async () => {
			await using db = connect();
			const storage = await db.open();
			const shortPath = "/sessions/p/bom.jsonl";
			await storage.writeText(shortPath, "\uFEFFabc");
			const longPath = "/sessions/p/bom-past-slot.jsonl";
			await storage.writeText(longPath, `${"x".repeat(300)}\uFEFFyz`);

			expect({
				afterBom: await storage.readTextFrom(shortPath, 3, 2),
				fromBom: await storage.readTextFrom(shortPath, 0, 5),
				pastSlot: await storage.readTextFrom(longPath, 300, 4),
			}).toEqual({
				afterBom: { text: "ab", size: 6 },
				fromBom: { text: "ab", size: 6 },
				pastSlot: { text: "y", size: 305 },
			});
		}, 60_000);

		it("rejects a session the store does not hold as missing", async () => {
			await using db = connect();
			const storage = await db.open();
			await expect(readSessionTextFrom(storage, "/sessions/p/none.jsonl", 0)).rejects.toMatchObject({
				code: "ENOENT",
			});
		}, 60_000);
	});
}

/** Wrap a SQLite client so the column bytes every statement returns are counted. */
function countReturnedBytes(client: SqlClient): { client: SqlSessionStorageClient; bytes: () => number } {
	let total = 0;
	const count = (rows: SqlSessionStorageResult): SqlSessionStorageResult => {
		for (const row of rows as Array<Record<string, unknown>>) {
			for (const value of Object.values(row)) {
				if (value instanceof Uint8Array) total += value.byteLength;
				else if (typeof value === "string") total += Buffer.byteLength(value);
			}
		}
		return rows;
	};
	const wrapped: SqlSessionStorageClient = {
		options: client.options,
		unsafe: async (query, values) => count(await client.unsafe(query, values)),
		transaction: callback =>
			client.transaction(async transaction =>
				callback({ unsafe: async (query, values) => count(await transaction.unsafe(query, values)) }),
			),
	};
	return { client: wrapped, bytes: () => total };
}

describe("SqlSessionStorage offset reads fetch only what they return (sqlite)", () => {
	it("fetches a tail's bytes, not the whole session, however long the session is", async () => {
		await using cleanup = new AsyncDisposableStack();
		const sqlite = new SQL("sqlite::memory:");
		cleanup.defer(() => sqlite.end());
		const path = "/sessions/p/long.jsonl";
		const seeded = await SqlSessionStorage.create({ client: sqlite });
		const lines = Array.from({ length: 2_000 }, (_, line) => `{"n":${line},"s":"${"😀".repeat(20)}"}\n`);
		const writer = seeded.openWriter(path);
		cleanup.defer(() => writer.close());
		for (const line of lines) await writer.append(line);
		await writer.close();
		const lastLine = lines.at(-1)!;
		const content = lines.join("");
		const size = Buffer.byteLength(content);

		const { client, bytes } = countReturnedBytes(sqlite);
		const storage = await SqlSessionStorage.create({ client });
		const before = bytes();
		const tail = await readSessionTextFrom(storage, path, size - Buffer.byteLength(lastLine));
		expect(tail).toEqual({ text: lastLine, size });
		// One appended line and the row's numbers, not the session's ~200 KB.
		expect(bytes() - before).toBeLessThan(2 * Buffer.byteLength(lastLine));

		const afterTail = bytes();
		const page = await readSessionTextFrom(storage, path, 0, 1_000);
		expect(page).toEqual({ text: Buffer.from(content).subarray(0, 1_000).toString("utf8"), size });
		// The capped page plus at most the rest of the part it ends in.
		expect(bytes() - afterTail).toBeLessThan(1_000 + 2 * Buffer.byteLength(lastLine));
	}, 60_000);

	// If this regresses, a window of a renamed long session that starts inside its title slot (a header probe, the
	// first page of a viewer) fetches the whole session to lay the title over its head.
	it("fetches a titled session's window inside the title slot from the start of the session, not the whole session", async () => {
		await using cleanup = new AsyncDisposableStack();
		const sqlite = new SQL("sqlite::memory:");
		cleanup.defer(() => sqlite.end());
		const path = "/sessions/p/long-titled.jsonl";
		const seeded = await SqlSessionStorage.create({ client: sqlite });
		// ASCII lines: the slot laid over the stored head then ends between characters, so readText's bytes are
		// the stored size (the case above covers a cut inside one).
		const lines = Array.from({ length: 2_000 }, (_, line) => `{"n":${line},"s":"${"x".repeat(80)}"}\n`);
		const writer = seeded.openWriter(path);
		cleanup.defer(() => writer.close());
		for (const line of lines) await writer.append(line);
		await writer.close();
		const title = { title: "Renamed long session", source: "user" as const, updatedAt: "t2" };
		await seeded.updateSessionTitle(path, title);
		const whole = Buffer.from(await seeded.readText(path));

		const { client, bytes } = countReturnedBytes(sqlite);
		const storage = await SqlSessionStorage.create({ client });
		const before = bytes();
		const window = await readSessionTextFrom(storage, path, 100, 300);
		expect(window).toEqual({ text: whole.subarray(100, 400).toString("utf8"), size: whole.byteLength });
		// The bytes up to the window's end and the row's numbers and title, plus at most the rest of the part the
		// window ends in: not the session's ~200 KB.
		expect(bytes() - before).toBeLessThan(400 + 2 * Buffer.byteLength(lines[0] ?? "") + 200);
	}, 60_000);
});
