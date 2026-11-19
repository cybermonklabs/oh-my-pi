/**
 * A second writer that acts at a known moment of a chunked read, for the
 * tests of the readers built on it: right after the first chunk (or the first
 * bytes) the reads of one transcript yield, through a spy on the reader's
 * `readChunks`, or right after the first statement that hands a SQL store a
 * stored part, through a wrapped client, for the reads a store makes through
 * its own backend (`scanLines`, the read-back after a failed publish), which
 * no spy on the store reaches. The race runs once; the reads after it go on
 * unraced. Also the writer of an omp release older than the SQL store's
 * SQLite rowid rule, which re-creates a session with the rowids of the parts
 * it replaces, and two bodies that such a re-create can swap under a chunked
 * read without any of the read's page checks seeing it.
 */
import { spyOn } from "bun:test";
import type { FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type {
	SqlSessionStorage,
	SqlSessionStorageClient,
	SqlSessionStorageResult,
	SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { type LeaseDb, transcript } from "./sql-session-lease-fixture";

export const MiB = 1024 * 1024;
export const TIMESTAMP = "2026-11-18T00:00:00.000Z";
/** Lease timings under which no heartbeat runs during a case. */
export const STILL = { expiryMs: 600_000, heartbeatMs: 300_000 };

/** `entry` as one JSONL line, its newline included. */
export function line(entry: Record<string, unknown>): string {
	return `${JSON.stringify(entry)}\n`;
}

/** Whether a race ran. */
export interface Race {
	readonly ran: boolean;
}

/** A store that reads in chunks, as `SqlSessionStorage` and `FileSessionStorage` do. */
interface ChunkedReader {
	readChunks(path: string, fromByte?: number): AsyncIterable<Uint8Array>;
}

/**
 * Make `race` run once, as soon as the reads of `file` through
 * `reader.readChunks` have yielded `afterBytes` bytes (by default the first
 * chunk), right before the reader takes more of it: the next chunk of the read
 * in progress, or the first of a read it starts after that, as a reader that
 * reads a transcript window by window does.
 */
export function raceAfterFirstChunk(
	reader: ChunkedReader,
	file: string,
	race: () => Promise<void>,
	afterBytes = 1,
): Race {
	const readChunks = reader.readChunks.bind(reader);
	const state = { ran: false };
	let yielded = 0;
	const raceDue = async (): Promise<void> => {
		if (state.ran || yielded < afterBytes) return;
		state.ran = true;
		await race();
	};
	spyOn(reader, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
		(async function* () {
			if (chunkPath !== file) {
				yield* readChunks(chunkPath, fromByte);
				return;
			}
			await raceDue();
			for await (const chunk of readChunks(chunkPath, fromByte)) {
				yielded += chunk.byteLength;
				yield chunk;
				await raceDue();
			}
		})(),
	);
	return state;
}

/** Bytes of a value a statement returns from which it counts as a stored part (a full write's parts are 1 MiB). */
const PART_BYTES = MiB / 2;

function valueBytes(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof Uint8Array) return value.byteLength;
	return 0;
}

/** Whether a statement's result (rows, or on PostgreSQL one result per statement of a query) holds a stored part. */
function holdsPart(result: unknown): boolean {
	if (!Array.isArray(result)) return false;
	return result.some(row =>
		Array.isArray(row)
			? holdsPart(row)
			: typeof row === "object" && row !== null && Object.values(row).some(value => valueBytes(value) >= PART_BYTES),
	);
}

/** A client wrapper that races a store's reads at their first stored part, once armed. */
export interface PartRace extends Race {
	/**
	 * Wrap a store's client, as `LeaseDb.open({ wrap })` takes it. The wrapper
	 * hides the SQLite database's file name, so the store queues its calls on
	 * its own, as a store of another process does, and does not hold the call
	 * queue the other stores of this process share while the race writes.
	 */
	readonly wrap: (client: SqlSessionStorageClient) => SqlSessionStorageClient;
	/** Run `race` once, right after the next statement that returns a stored part, before its rows go back. */
	arm(race: () => Promise<void>): void;
}

export function partRace(): PartRace {
	let armed: (() => Promise<void>) | undefined;
	let ran = false;
	const exec = async (
		executor: SqlSessionStorageTransaction,
		query: string,
		values: unknown[] | undefined,
	): Promise<SqlSessionStorageResult> => {
		const result = await executor.unsafe(query, values);
		const race = armed;
		if (race && holdsPart(result)) {
			armed = undefined;
			ran = true;
			await race();
		}
		return result;
	};
	return {
		get ran() {
			return ran;
		},
		wrap: client => ({
			options: { ...client.options, filename: "" },
			unsafe: (query, values) => exec(client, query, values),
			transaction: callback =>
				client.transaction(transaction =>
					callback({ unsafe: (query, values) => exec(transaction, query, values) }),
				),
			end: () => client.end?.() ?? Promise.resolve(),
		}),
		arm(race) {
			armed = race;
		},
	};
}

/**
 * Session `id`'s header and first user turn (`prompt`), then `count` lines of
 * `bytes` bytes of `fill`, each a custom entry of its own: a transcript that
 * spans as many stored parts of 1 MiB as it has MiB.
 */
export function paddedTranscript(id: string, prompt: string, fill: string, count: number, bytes = MiB): string[] {
	const header = JSON.stringify({ type: "session", version: 3, id, timestamp: TIMESTAMP, cwd: "/project" });
	const turn = JSON.stringify({
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: TIMESTAMP,
		message: { role: "user", content: prompt, timestamp: 1 },
	});
	return [
		`${header}\n`,
		`${turn}\n`,
		...Array.from(
			{ length: count },
			(_, n) =>
				`${JSON.stringify({ type: "custom", customType: "pad", id: `p${n}`, parentId: null, timestamp: TIMESTAMP, data: fill.repeat(bytes) })}\n`,
		),
	];
}

/** The fills of `entries`' pads, in order (`"aaa"` for three pads of `a`): one letter for one body, two for a mix. */
export function padFills(entries: readonly FileEntry[]): string {
	let fills = "";
	for (const entry of entries) {
		if (entry.type === "custom" && typeof entry.data === "string") fills += entry.data.charAt(0);
	}
	return fills;
}

/** The session whose bodies {@link sharedPadBody} builds, which {@link startedByOlderWriter} claims. */
export const RACED_SESSION_ID = "01a1f000-0000-7000-8000-000000000071";

/** Append `lines` to `file` one by one, as a session's writer does, and wait until they are stored. */
export async function appendLines(storage: SqlSessionStorage, file: string, lines: string[]): Promise<void> {
	const writer = storage.openWriter(file, { flags: "a" });
	for (const line of lines) await writer.append(line);
	await writer.close();
	await storage.drain();
}

/**
 * Session {@link RACED_SESSION_ID}'s header and a first turn that says
 * `prompt`, then a 1 MiB pad of "a" and seven of `fill`: over 8 MiB, past
 * several pages. Two such bodies whose prompts have one length have lines of
 * the same lengths, and the same pad at the end of a read's first page (the
 * turn and the first pad), while the turn before it and the pads after it
 * differ.
 */
export function sharedPadBody(prompt: string, fill: string): string[] {
	return [
		transcript(RACED_SESSION_ID, prompt),
		...paddedTranscript(RACED_SESSION_ID, prompt, "a", 1).slice(2),
		...paddedTranscript(RACED_SESSION_ID, prompt, fill, 8).slice(3),
	];
}

/** The text of the first user turn among `entries`. */
export function firstPrompt(entries: readonly unknown[]): string {
	for (const entry of entries as Array<{ type?: string; message?: { role?: string; content?: unknown } }>) {
		if (entry.type === "message" && entry.message?.role === "user") return String(entry.message.content);
	}
	return "";
}

/**
 * Write `lines` as session `file` the way an omp release older than the store's SQLite rowid rule does, by raw
 * SQL on the fixture's connection: delete the session's parts and row (a no-op when it has none), insert its
 * row, then insert each line as a part whose rowid is the parts table's largest rowid plus one. That release's
 * writer leaves the rowid to SQLite, which picks exactly that, so a session it deletes and writes again gives
 * its new parts the rowids of the old ones.
 */
export async function olderWriterWrites(db: LeaseDb, file: string, lines: string[]): Promise<void> {
	await db.sql(`DELETE FROM ${db.table}_parts WHERE path = @1`, [file]);
	await db.sql(`DELETE FROM ${db.table} WHERE path = @1`, [file]);
	const size = lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
	await db.sql(`INSERT INTO ${db.table} (path, content, mtime_ms, byte_len) VALUES (@1, '', @2, @3)`, [
		file,
		Date.now(),
		size,
	]);
	let offset = 0;
	for (const line of lines) {
		await db.sql(
			`INSERT INTO ${db.table}_parts (rowid, path, start_offset, content) ` +
				`VALUES ((SELECT coalesce(max(rowid), 0) + 1 FROM ${db.table}_parts), @1, @2, @3)`,
			[file, offset, line],
		);
		offset += Buffer.byteLength(line);
	}
}

/**
 * Session `file` of `db`, of session {@link RACED_SESSION_ID}: its first two lines from the older writer, the
 * rest appended by a store of this release that claims it, as when omp is upgraded while a session is open.
 * Returns the release of that claim.
 */
export async function startedByOlderWriter(db: LeaseDb, file: string, lines: string[]): Promise<() => void> {
	// The store makes the tables; the older writer then starts the session, and the store finds it on refresh.
	const writer = await db.open({ lease: STILL });
	await olderWriterWrites(db, file, lines.slice(0, 2));
	await writer.refresh();
	const release = await writer.acquireSessionClaim?.(RACED_SESSION_ID, file);
	await appendLines(writer, file, lines.slice(2));
	return () => release?.();
}
