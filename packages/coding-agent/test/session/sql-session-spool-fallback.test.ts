/**
 * SQL session storage saves a full rewrite when the spool it streams the
 * lines through cannot be used: `os.tmpdir()` read-only, a spool write that
 * fails as a full disk does, or a spool directory that another account could
 * enter. The rewrite then streams the lines to the store's staged write
 * straight from the lines, never joined, and the store warns once, not on
 * every rewrite; it records the title a rewrite through the spool records,
 * also from a first line as long as the head the title is read from. When
 * that streamed write fails too, the rewrite fails where its caller sees it,
 * logs an error naming the session, the path and the cause, and leaves the
 * stored copy whole; the next rewrite tries again. A store whose backend has
 * no streamed write takes the joined lines through its whole write and never
 * uses the spool. A throw from the lines themselves is no spool
 * failure, and fails the rewrite as it is. Lines that a second read does not
 * give again as the spool read them fail the rewrite, which keeps the stored
 * copy.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { CURRENT_SESSION_VERSION, SESSION_TITLE_SLOT_BYTES } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { LINE_STREAM_CHUNK } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	parseTitleSlotFromContent,
	type SessionTitleUpdate,
	serializeTitleSlot,
	titleUpdateFromSlot,
} from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { MemoryBackend } from "../helpers/memory-session-backend";
import { descriptorsUnder, HAS_PROC_FD } from "../helpers/open-descriptors";
import { rejectionOf } from "../helpers/rejection";
import { fillDiskUnder, pathUnderRegularFile, spoolWarnings } from "../helpers/spool-unusable";

/** Root ignores directory permissions, so a read-only directory cannot be made for it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;
const ID = "01a1f000-0000-7000-8000-00000000f001";
const TIMESTAMP = "2026-11-19T00:00:00.000Z";
const SYNC_FILE = `/sessions/-project-/2026-11-19T00-00-00-000Z_${ID}.jsonl`;
const ATOMIC_FILE = `/sessions/-project-/2026-11-19T00-00-01-000Z_${ID}.jsonl`;

const originalTmpdir = process.env.TMPDIR;

/** A session's lines: its header, then `count` entries carrying `text`. */
function sessionLines(text: string, count = 3): string[] {
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id: ID, timestamp: TIMESTAMP, cwd: "/project" };
	return [
		`${JSON.stringify(header)}\n`,
		...Array.from(
			{ length: count },
			(_, n) =>
				`${JSON.stringify({ type: "custom", customType: "note", id: `n${n}`, parentId: n === 0 ? null : `n${n - 1}`, timestamp: TIMESTAMP, data: { text } })}\n`,
		),
	];
}

/** The title the title slot of each of {@link FIRST_LINES} records. */
const TITLE: SessionTitleUpdate = { title: "Rewritten session", source: "user", updatedAt: TIMESTAMP };

/**
 * First lines a rewrite can start with, each a title slot recording
 * {@link TITLE}: the fixed-width slot sessions write, and one of at least
 * {@link LINE_STREAM_CHUNK} UTF-16 units, the head a rewrite reads its title
 * from, which only a head of whole lines keeps the title of.
 */
const FIRST_LINES: ReadonlyArray<{ name: string; line: string }> = [
	{ name: "the fixed-width title slot", line: serializeTitleSlot(TITLE) },
	{
		name: `a title slot of ${LINE_STREAM_CHUNK} UTF-16 units or more`,
		line: `${JSON.stringify({ type: "title", v: 1, ...TITLE, pad: " ".repeat(LINE_STREAM_CHUNK) })}\n`,
	},
];

async function withSqliteStorage(run: (storage: SqlSessionStorage) => Promise<void>): Promise<void> {
	const client = new SQL("sqlite::memory:");
	try {
		await run(await SqlSessionStorage.create({ client }));
	} finally {
		await client.end();
	}
}

/**
 * Rewrite one stored session in full through `writeLinesSync` and another
 * through `writeLinesAtomic`: what `readText` gives for each, and the bodies written.
 */
async function rewriteBothWays(storage: SqlSessionStorage): Promise<{ stored: string[]; written: string[] }> {
	const before = sessionLines("before", 1).join("");
	await storage.writeText(SYNC_FILE, before);
	await storage.writeText(ATOMIC_FILE, before);
	const syncLines = sessionLines("written by writeLinesSync");
	const atomicLines = sessionLines("written by writeLinesAtomic");

	storage.writeLinesSync(SYNC_FILE, syncLines, { expectedSize: Buffer.byteLength(before) });
	await storage.drain();
	await storage.writeLinesAtomic(ATOMIC_FILE, atomicLines, { expectedSize: Buffer.byteLength(before) });

	return {
		stored: [await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)],
		written: [syncLines.join(""), atomicLines.join("")],
	};
}

describe("SQL session storage full rewrites when the spool cannot be used", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
	});

	// If this regresses, a session on SQL storage in a container whose TMPDIR is read-only is never
	// saved: every full rewrite throws EACCES and the session the user resumes later is missing.
	it.skipIf(RUNS_AS_ROOT)(
		"stores a rewrite through writeLinesSync and writeLinesAtomic when os.tmpdir() is read-only, warning once",
		async () => {
			using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
			fs.chmodSync(tmp.path(), 0o500);
			process.env.TMPDIR = tmp.path();
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			try {
				await withSqliteStorage(async storage => {
					const { stored, written } = await rewriteBothWays(storage);

					expect(stored).toEqual(written);
					expect(spoolWarnings(warn.mock.calls)).toHaveLength(1);
				});
			} finally {
				fs.chmodSync(tmp.path(), 0o700);
			}
		},
	);

	// If this regresses, a session on SQL storage whose TMPDIR fills up (the spool holds a whole copy of
	// the transcript) is never saved again, and each failed rewrite leaves a descriptor open.
	it.skipIf(!HAS_PROC_FD)(
		"stores a rewrite through writeLinesSync and writeLinesAtomic when a spool write fails with ENOSPC, and closes the spool",
		async () => {
			using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
			process.env.TMPDIR = tmp.path();
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const disk = fillDiskUnder(tmp.path());

			await withSqliteStorage(async storage => {
				const { stored, written } = await rewriteBothWays(storage);

				expect(stored).toEqual(written);
				// Both rewrites tried the spool, and the partly written files are closed and gone.
				expect(disk.refused()).toBe(2);
				expect(descriptorsUnder(tmp.path())).toEqual([]);
				expect(fs.readdirSync(path.join(tmp.path(), `omp-spool-${process.getuid?.()}`))).toEqual([]);
				expect(spoolWarnings(warn.mock.calls)).toHaveLength(1);
			});
		},
	);

	// If this regresses, a rewrite handed its lines by a generator, which yields them only once, stores
	// only the lines the failed spool left unread (here none) when the spool write fails.
	it("stores every line a generator yields when the spool write of its rewrite fails", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = tmp.path();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const disk = fillDiskUnder(tmp.path());
		const lines = sessionLines("yielded once");
		function* yieldOnce(): Generator<string> {
			yield* lines;
		}

		await withSqliteStorage(async storage => {
			storage.writeLinesSync(SYNC_FILE, yieldOnce());
			await storage.drain();
			await storage.writeLinesAtomic(ATOMIC_FILE, yieldOnce());

			expect(disk.refused()).toBe(2);
			expect([await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)]).toEqual([
				lines.join(""),
				lines.join(""),
			]);
		});
	});

	// If this regresses, a rewrite handed an iterable that returns the same generator on every call
	// replaces the stored transcript with an empty body when the spool write fails after reading a
	// line: the fallback reads the spent generator again, finds no lines, and its size and hash checks
	// pass on zero bytes.
	it("stores every line of an iterable that hands out one generator when the spool write fails after its first line", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = tmp.path();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const disk = fillDiskUnder(tmp.path());
		// A first line as long as the spool's write chunk: the spool writes it alone, and that write fails.
		const header = { type: "session", version: CURRENT_SESSION_VERSION, id: ID, timestamp: TIMESTAMP };
		const lines = [
			`${JSON.stringify({ ...header, cwd: `/${"p".repeat(LINE_STREAM_CHUNK)}` })}\n`,
			...sessionLines("handed out once").slice(1),
		];
		function handedOutOnce(): Iterable<string> {
			const generator = (function* () {
				yield* lines;
			})();
			return { [Symbol.iterator]: () => generator };
		}

		await withSqliteStorage(async storage => {
			const before = sessionLines("before", 1).join("");
			await storage.writeText(SYNC_FILE, before);
			await storage.writeText(ATOMIC_FILE, before);

			storage.writeLinesSync(SYNC_FILE, handedOutOnce());
			await storage.drain();
			await storage.writeLinesAtomic(ATOMIC_FILE, handedOutOnce());

			expect({
				refused: disk.refused(),
				stored: [await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)],
			}).toEqual({ refused: 2, stored: [lines.join(""), lines.join("")] });
		});
	});

	// If this regresses, a rewrite handed an iterable that hands out a new iterator over one shared
	// generator on every call, passing `return` through (as `generator.map(f)` gives), replaces the
	// stored transcript with an empty body when the spool write fails, and reports success: closing
	// the spool's iterator closed the generator, so the fallback's second read finds no lines, and its
	// size and hash checks pass on zero bytes.
	it("fails a rewrite of an iterable that hands out new iterators over one generator when the spool write fails, and keeps the stored copy", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = tmp.path();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const disk = fillDiskUnder(tmp.path());
		const lines = sessionLines("mapped once");
		function overOneGenerator(): Iterable<string> {
			const generator = (function* () {
				yield* lines;
			})();
			return {
				[Symbol.iterator]: (): Iterator<string> => ({
					next: () => generator.next(),
					return: () => generator.return(),
				}),
			};
		}
		const outcome = async (write: () => unknown) => {
			try {
				await write();
				return "stored";
			} catch (err) {
				return err instanceof Error && err.message.includes("could not be read again") ? "refused" : String(err);
			}
		};

		await withSqliteStorage(async storage => {
			const before = sessionLines("before", 1).join("");
			await storage.writeText(SYNC_FILE, before);
			await storage.writeText(ATOMIC_FILE, before);

			const sync = await outcome(() => {
				storage.writeLinesSync(SYNC_FILE, overOneGenerator());
				return storage.drain();
			});
			const atomic = await outcome(() => storage.writeLinesAtomic(ATOMIC_FILE, overOneGenerator()));
			expect({
				sync,
				atomic,
				refused: disk.refused(),
				errors: error.mock.calls.filter(([message]) => String(message).includes("cannot be read again")).length,
				storedBytes: [
					Buffer.byteLength(await storage.readText(SYNC_FILE)),
					Buffer.byteLength(await storage.readText(ATOMIC_FILE)),
				],
			}).toEqual({
				sync: "refused",
				atomic: "refused",
				refused: 2,
				errors: 2,
				storedBytes: [Buffer.byteLength(before), Buffer.byteLength(before)],
			});
		});
	});

	// If this regresses, full rewrites spool the transcript into a directory other accounts can enter,
	// or one another account made first and controls, instead of keeping it out of their reach.
	it.skipIf(process.getuid === undefined)(
		"does not spool into a directory others can enter that was made first, and still stores the rewrite",
		async () => {
			using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
			const spoolDir = path.join(tmp.path(), `omp-spool-${process.getuid?.()}`);
			fs.mkdirSync(spoolDir);
			fs.chmodSync(spoolDir, 0o755);
			process.env.TMPDIR = tmp.path();
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

			await withSqliteStorage(async storage => {
				const { stored, written } = await rewriteBothWays(storage);

				expect(stored).toEqual(written);
				expect(spoolWarnings(warn.mock.calls)).toHaveLength(1);
			});
		},
	);

	// If this regresses, a rewrite whose own lines fail (an entry that cannot be read back or
	// serialized) is reported as an unusable spool, reads the whole transcript a second time to stream
	// it, and uses up the store's one warning, so a real spool failure later goes unreported.
	it.skipIf(process.getuid === undefined)(
		"rethrows a throw from the lines of a rewrite without reading them again or using up the spool warning",
		async () => {
			using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
			process.env.TMPDIR = tmp.path();
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const unwritable = new Error("an entry cannot be serialized");
			let reads = 0;
			// Read anew on each iteration, as a session's serialized body is.
			const failing: Iterable<string> = {
				*[Symbol.iterator]() {
					reads++;
					yield* sessionLines("partial", 0);
					throw unwritable;
				},
			};

			await withSqliteStorage(async storage => {
				const before = sessionLines("before", 1).join("");
				await storage.writeText(SYNC_FILE, before);
				await storage.writeText(ATOMIC_FILE, before);

				expect(() => storage.writeLinesSync(SYNC_FILE, failing)).toThrow(unwritable);
				await expect(storage.writeLinesAtomic(ATOMIC_FILE, failing)).rejects.toBe(unwritable);
				expect({
					reads,
					warnings: spoolWarnings(warn.mock.calls).length,
					stored: [await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)],
				}).toEqual({ reads: 2, warnings: 0, stored: [before, before] });

				// A spool that fails after them still gets its warning.
				fs.chmodSync(path.join(tmp.path(), `omp-spool-${process.getuid?.()}`), 0o755);
				const { stored, written } = await rewriteBothWays(storage);
				expect(stored).toEqual(written);
				expect(spoolWarnings(warn.mock.calls)).toHaveLength(1);
			});
		},
	);

	// If this regresses, a rewrite whose spool cannot be used and whose streamed write then fails
	// either swaps in bytes other than those it measured, or fails with nothing in the log, and the
	// session the user resumes later silently lacks what that rewrite carried.
	it("fails a rewrite whose streamed write fails, logging the session, the path and the cause, and keeps the stored copy", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = pathUnderRegularFile(tmp);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		let reads = 0;
		// Each read after the first gives other bytes of the same length, as entries changed since the first would.
		const changing: Iterable<string> = {
			*[Symbol.iterator]() {
				reads++;
				yield* sessionLines(reads === 1 ? "first read" : "later read");
			},
		};

		await withSqliteStorage(async storage => {
			const before = sessionLines("before", 1).join("");
			await storage.writeText(SYNC_FILE, before);
			await storage.writeText(ATOMIC_FILE, before);
			const expectedSize = Buffer.byteLength(before);

			storage.writeLinesSync(SYNC_FILE, changing, { expectedSize });
			const syncFailure = await rejectionOf(storage.drain());
			reads = 0;
			const atomicFailure = await rejectionOf(storage.writeLinesAtomic(ATOMIC_FILE, changing, { expectedSize }));

			expect({
				syncFailed: syncFailure instanceof Error,
				atomicFailed: atomicFailure instanceof Error,
				stored: [await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)],
				sizes: [storage.statSync(SYNC_FILE).size, storage.statSync(ATOMIC_FILE).size],
			}).toEqual({
				syncFailed: true,
				atomicFailed: true,
				stored: [before, before],
				sizes: [expectedSize, expectedSize],
			});
			expect(error.mock.calls.map(([, context]) => context)).toEqual([
				expect.objectContaining({ session: ID, path: SYNC_FILE, error: expect.stringContaining("changed") }),
				expect.objectContaining({ session: ID, path: ATOMIC_FILE, error: expect.stringContaining("changed") }),
			]);

			// The next full rewrites try again, and store.
			const { stored, written } = await rewriteBothWays(storage);
			expect(stored).toEqual(written);
		});
	});

	// If this regresses, a store whose backend has no streamed write (an SDK backend) fails every full
	// rewrite while its spool cannot be used, or spools a body it then reads back whole anyway: such a
	// backend takes one string through `writeFull`, whatever the spool holds.
	it("stores a rewrite on a backend without a streamed write as its joined lines, without the spool", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = pathUnderRegularFile(tmp);
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const backend = new MemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const before = sessionLines("before", 1).join("");
		await storage.writeText(SYNC_FILE, before);
		await storage.writeText(ATOMIC_FILE, before);
		const expectedSize = Buffer.byteLength(before);
		backend.writeFullBytes.length = 0;
		const syncLines = sessionLines("written by writeLinesSync");
		const atomicLines = sessionLines("written by writeLinesAtomic");
		// A generator yields its lines once: the join reads them once.
		function* yieldOnce(): Generator<string> {
			yield* atomicLines;
		}

		storage.writeLinesSync(SYNC_FILE, syncLines, { expectedSize });
		await storage.drain();
		await storage.writeLinesAtomic(ATOMIC_FILE, yieldOnce(), { expectedSize });

		expect({
			writeFullBytes: backend.writeFullBytes,
			stored: [await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)],
			spoolWarnings: spoolWarnings(warn.mock.calls).length,
			errors: error.mock.calls.length,
		}).toEqual({
			writeFullBytes: [Buffer.byteLength(syncLines.join("")), Buffer.byteLength(atomicLines.join(""))],
			stored: [syncLines.join(""), atomicLines.join("")],
			spoolWarnings: 0,
			errors: 0,
		});
	});

	for (const { name, line } of FIRST_LINES) {
		// If this regresses, a session whose rewrite streams to the store because the spool cannot be
		// used is listed under another title than the same rewrite through the spool gives it, or none.
		it(`records the title a spooled rewrite records when the first line is ${name}`, async () => {
			using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const lines = [line, ...sessionLines("titled")];
			const spooled = `/sessions/-project-/2026-11-19T00-00-02-000Z_${ID}.jsonl`;
			const streamed = `/sessions/-project-/2026-11-19T00-00-03-000Z_${ID}.jsonl`;
			const client = new SQL("sqlite::memory:");
			try {
				const storage = await SqlSessionStorage.create({ client });
				process.env.TMPDIR = tmp.path();
				await storage.writeLinesAtomic(spooled, lines);
				const warningsAfterSpooled = spoolWarnings(warn.mock.calls).length;
				process.env.TMPDIR = pathUnderRegularFile(tmp);
				await storage.writeLinesAtomic(streamed, lines);
				await storage.drain();

				// The title the next process lists each session under: the saved title, laid over its head.
				const reopened = await SqlSessionStorage.create({ client });
				const titleOf = async (file: string): Promise<SessionTitleUpdate | undefined> => {
					const [head] = await reopened.readTextSlices(file, SESSION_TITLE_SLOT_BYTES, 0);
					return titleUpdateFromSlot(parseTitleSlotFromContent(head));
				};
				expect({
					spoolWarnings: [warningsAfterSpooled, spoolWarnings(warn.mock.calls).length],
					titles: { spooled: await titleOf(spooled), streamed: await titleOf(streamed) },
				}).toEqual({ spoolWarnings: [0, 1], titles: { spooled: TITLE, streamed: TITLE } });
			} finally {
				await client.end();
			}
		});
	}
});
