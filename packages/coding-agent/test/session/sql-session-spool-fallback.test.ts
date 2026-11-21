/**
 * SQL session storage saves a full rewrite when the spool it streams the
 * lines through cannot be used: `os.tmpdir()` read-only, a spool write that
 * fails as a full disk does, or a spool directory that another account could
 * enter. The rewrite then streams the lines to the store's staged write
 * straight from the lines, never joined, and the store warns once, not on
 * every rewrite. When that streamed write fails too, the rewrite fails where
 * its caller sees it, logs an error naming the session, the path and the
 * cause, and leaves the stored copy whole; the next rewrite tries again. A
 * store whose backend has no streamed write fails such a rewrite rather than
 * join it, and reads nothing back to check it. A throw from the lines
 * themselves is no spool failure, and fails the rewrite as it is.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { rejectionOf } from "../helpers/rejection";
import { fillDiskUnder, pathUnderRegularFile, spoolWarnings } from "../helpers/spool-unusable";

/** Root ignores directory permissions, so a read-only directory cannot be made for it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;
const HAS_PROC_FD = fs.existsSync("/proc/self/fd");
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

/** Whether descriptor `fd` of this process is open on a file under `dir`. */
function isUnder(fd: number, dir: string): boolean {
	try {
		return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}${path.sep}`);
	} catch {
		return false;
	}
}

/**
 * A backend that keeps each session's text in memory and has no streamed full
 * write; it records each `writeFull` body's length and each path `readFull` reads.
 */
class NoStreamBackend implements SessionStorageBackend {
	readonly sessions = new Map<string, string>();
	readonly writeFullBytes: number[] = [];
	readonly readFullPaths: string[] = [];

	init(): Promise<void> {
		return Promise.resolve();
	}
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([]);
	}
	readFull(path: string): Promise<string | null> {
		this.readFullPaths.push(path);
		return Promise.resolve(this.sessions.get(path) ?? null);
	}
	readSlices(): Promise<[string, string]> {
		return Promise.resolve(["", ""]);
	}
	writeFull(path: string, content: string): Promise<void> {
		this.writeFullBytes.push(Buffer.byteLength(content));
		this.sessions.set(path, content);
		return Promise.resolve();
	}
	append(path: string, line: string): Promise<void> {
		this.sessions.set(path, (this.sessions.get(path) ?? "") + line);
		return Promise.resolve();
	}
	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}
	truncate(path: string): Promise<void> {
		this.sessions.set(path, "");
		return Promise.resolve();
	}
	remove(paths: string[]): Promise<void> {
		for (const path of paths) this.sessions.delete(path);
		return Promise.resolve();
	}
	move(): Promise<void> {
		return Promise.resolve();
	}
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
				expect(
					fs
						.readdirSync("/proc/self/fd")
						.map(Number)
						.filter(fd => isUnder(fd, tmp.path())),
				).toEqual([]);
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

	// If this regresses, a store whose backend has no streamed write joins the whole transcript into
	// one string at every full rewrite while its spool cannot be used, and a long session's memory
	// grows with its age until the process is killed.
	it("fails a rewrite on a backend without a streamed write instead of joining it, and keeps the stored copy", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = pathUnderRegularFile(tmp);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const error = vi.spyOn(logger, "error").mockImplementation(() => {});
		const backend = new NoStreamBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const before = sessionLines("before", 1).join("");
		await storage.writeText(SYNC_FILE, before);
		await storage.writeText(ATOMIC_FILE, before);
		const expectedSize = Buffer.byteLength(before);
		backend.writeFullBytes.length = 0;

		storage.writeLinesSync(SYNC_FILE, sessionLines("written by writeLinesSync"), { expectedSize });
		const syncFailure = await rejectionOf(storage.drain());
		const atomicFailure = await rejectionOf(
			storage.writeLinesAtomic(ATOMIC_FILE, sessionLines("written by writeLinesAtomic"), { expectedSize }),
		);

		expect({
			failures: [String(syncFailure), String(atomicFailure)],
			writeFullBytes: backend.writeFullBytes,
			stored: [await storage.readText(SYNC_FILE), await storage.readText(ATOMIC_FILE)],
		}).toEqual({
			failures: [
				expect.stringContaining("no streamed full write"),
				expect.stringContaining("no streamed full write"),
			],
			writeFullBytes: [],
			stored: [before, before],
		});
		expect(error.mock.calls.map(([, context]) => context)).toEqual([
			expect.objectContaining({ session: ID, path: SYNC_FILE }),
			expect.objectContaining({ session: ID, path: ATOMIC_FILE }),
		]);
	});

	// If this regresses, every atomic rewrite on a backend without a streamed write reads the whole
	// stored transcript back into memory while the spool cannot be used, to check a write that never
	// ran, and one over a stored copy with the same bytes reports itself stored without being written.
	it("fails an atomic rewrite on a backend without a streamed write without reading the stored copy back", async () => {
		using tmp = TempDir.createSync("@omp-spool-fallback-tmp-");
		process.env.TMPDIR = pathUnderRegularFile(tmp);
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(logger, "error").mockImplementation(() => {});
		const backend = new NoStreamBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const lines = sessionLines("already stored");
		const stored = lines.join("");
		await storage.writeText(ATOMIC_FILE, stored);
		backend.readFullPaths.length = 0;

		const failure = await rejectionOf(
			storage.writeLinesAtomic(ATOMIC_FILE, lines, { expectedSize: Buffer.byteLength(stored) }),
		);

		expect({
			failure: String(failure),
			readFullPaths: backend.readFullPaths,
			stored: backend.sessions.get(ATOMIC_FILE),
		}).toEqual({
			failure: expect.stringContaining("no streamed full write"),
			readFullPaths: [],
			stored,
		});
	});
});
