/**
 * A full rewrite of a long session on SQL and Redis session storage, when the
 * local spool it streams through cannot be used (`os.tmpdir()` read-only,
 * under a regular file, or full), never builds the transcript as one value
 * and never loses the stored copy: while it rewrites a 24 MiB transcript over
 * an older stored copy, through `writeLinesSync` and `drain` or through
 * `writeLinesAtomic`, the storage hands its backend, and takes back from it,
 * no string or buffer longer than 16 MiB, and the stored copy is then exactly
 * the new lines. On MySQL a session whose path leaves no room for a plain
 * staging path stages under its hash, never through a whole `writeFull`.
 *
 * Runs on SQLite always, and on PostgreSQL, MySQL and Redis when
 * `OMP_TEST_SQL_POSTGRES_URL`, `OMP_TEST_SQL_MYSQL_URL` and
 * `OMP_TEST_REDIS_URL` name a throwaway database or server. Each case uses a
 * table or key prefix of its own and removes it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { digestStream } from "@oh-my-pi/pi-coding-agent/utils/file-hash";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { fillDiskUnder, pathUnderRegularFile, spoolWarnings } from "../helpers/spool-unusable";
import { BackendWatch, openStore, type Seen, type StoreKind } from "../helpers/watched-session-store";

const MiB = 1024 * 1024;
/** No string or buffer handed to or returned by the backend during a rewrite may reach past this. */
const BOUND = 16 * MiB;
const TIMEOUT = 300_000;
const TIMESTAMP = "2026-11-21T00:00:00.000Z";
const ID = "01a1f000-0000-7000-8000-00000000c001";
const SESSION = `/sessions/-project-/2026-11-21T00-00-00-000Z_${ID}.jsonl`;
/**
 * {@link SESSION} under a project directory whose name brings the path to
 * 490 characters: past the 473 whose `<path>#staging-<epoch>-<id>` fits
 * MySQL's `VARCHAR(512)` path column.
 */
const LONG_SESSION = SESSION.replace("project", "p".repeat(490 - SESSION.length + "project".length));
/** Root ignores directory permissions, so a read-only directory cannot be made for it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

const BACKENDS: ReadonlyArray<{ kind: StoreKind; url: string | undefined }> = [
	{ kind: "sqlite", url: "sqlite" },
	{ kind: "postgres", url: process.env.OMP_TEST_SQL_POSTGRES_URL },
	{ kind: "mysql", url: process.env.OMP_TEST_SQL_MYSQL_URL },
	{ kind: "redis", url: process.env.OMP_TEST_REDIS_URL },
];

/**
 * A current-version transcript of at least `bytes` UTF-8 bytes, as the lines
 * a full rewrite hands over: a title slot, a header, then alternating user and
 * assistant messages of about 20 KiB each, made of `words`.
 */
function transcriptLines(title: string, words: string, bytes: number): string[] {
	const lines = [
		serializeTitleSlot({ title, source: "user", updatedAt: TIMESTAMP }),
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: ID, timestamp: TIMESTAMP, cwd: "/project" })}\n`,
	];
	let total = Buffer.byteLength(lines.join(""));
	let parentId: string | null = null;
	for (let n = 0; total < bytes; n++) {
		const text = `${n} ${words.repeat(400)}€`;
		const message =
			n % 2 === 0
				? { role: "user", content: text, timestamp: n }
				: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: n };
		const line = `${JSON.stringify({ type: "message", id: `m${n}`, parentId, timestamp: TIMESTAMP, message })}\n`;
		lines.push(line);
		total += Buffer.byteLength(line);
		parentId = `m${n}`;
	}
	return lines;
}

/** The transcript every case rewrites: 24 MiB as lines, and the size and SHA-256 of their UTF-8 bytes. */
const REWRITE = (() => {
	const lines = transcriptLines("Long session", "the session keeps working through the module tree; ", 24 * MiB);
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const line of lines) {
		hasher.update(line);
		bytes += Buffer.byteLength(line);
	}
	return { lines, digest: { hash: hasher.digest("hex"), bytes } };
})();

/** The older stored copy each rewrite replaces. */
const OLDER = transcriptLines("Older title", "an older copy of the session; ", 2 * MiB).join("");

/**
 * Ways the spool cannot be used. Each makes `os.tmpdir()` (the directory
 * returned) one the spool cannot write under, starting from the empty
 * directory `scratch`; `cause` is the error code the spool's failure names.
 */
const UNUSABLE_SPOOLS: ReadonlyArray<{
	name: string;
	skip: boolean;
	cause: string;
	make: (scratch: TempDir) => string;
}> = [
	{
		name: "os.tmpdir() is read-only",
		skip: RUNS_AS_ROOT,
		cause: "EACCES",
		make: scratch => {
			fs.chmodSync(scratch.path(), 0o500);
			return scratch.path();
		},
	},
	{
		name: "os.tmpdir() is under a regular file",
		skip: false,
		cause: "ENOTDIR",
		make: pathUnderRegularFile,
	},
	{
		name: "os.tmpdir() is full",
		skip: false,
		cause: "ENOSPC",
		make: scratch => {
			fillDiskUnder(scratch.path());
			return scratch.path();
		},
	},
];

/** The ways a full rewrite reaches the storage. */
const REWRITES: ReadonlyArray<{
	name: string;
	write: (storage: IndexedSessionStorage, file: string, lines: string[], expectedSize: number) => Promise<void>;
}> = [
	{
		name: "writeLinesSync and drain",
		write: async (storage, file, lines, expectedSize) => {
			storage.writeLinesSync(file, lines, { expectedSize });
			await storage.drain();
		},
	},
	{
		name: "writeLinesAtomic",
		write: (storage, file, lines, expectedSize) => storage.writeLinesAtomic(file, lines, { expectedSize }),
	},
];

const originalTmpdir = process.env.TMPDIR;

function restoreTmpdir(): void {
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
}

for (const { kind, url } of BACKENDS) {
	describe.skipIf(!url)(`a full rewrite of a long session whose spool cannot be used (${kind})`, () => {
		const cleanups: Array<() => Promise<void> | void> = [];

		afterEach(async () => {
			restoreTmpdir();
			vi.restoreAllMocks();
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});

		/**
		 * Store {@link OLDER} at `file`, then rewrite it in full with
		 * {@link REWRITE} through `rewrite` while `spool` keeps the spool from
		 * being used: how the rewrite ended, what the backend saw meanwhile, the
		 * spool warnings' context, and the stored copy after.
		 */
		async function rewriteWithout(
			spool: (typeof UNUSABLE_SPOOLS)[number],
			rewrite: (typeof REWRITES)[number],
			file: string,
		): Promise<{ outcome: string; seen: Seen; spoolWarnings: unknown[]; stored: { hash: string; bytes: number } }> {
			const watch = new BackendWatch();
			const store = await openStore(kind, url ?? "", watch);
			cleanups.push(() => store.close());
			const scratch = TempDir.createSync("@omp-spool-unusable-tmp-");
			cleanups.push(() => {
				fs.chmodSync(scratch.path(), 0o700);
				scratch.removeSync();
			});
			await store.storage.writeText(file, OLDER);
			await store.storage.drain();
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			process.env.TMPDIR = spool.make(scratch);

			watch.start();
			const outcome = await rewrite.write(store.storage, file, REWRITE.lines, Buffer.byteLength(OLDER)).then(
				() => "stored",
				(err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			const seen = watch.stop();
			restoreTmpdir();

			return {
				outcome,
				seen,
				spoolWarnings: spoolWarnings(warn.mock.calls).map(([, context]) => context),
				// Size and SHA-256 through the storage's chunked read, never joined.
				stored: await digestStream(store.storage.readChunks(file)),
			};
		}

		for (const spool of UNUSABLE_SPOOLS) {
			for (const rewrite of REWRITES) {
				// If this regresses, a long session on SQL or Redis storage, in a container whose temporary
				// directory is read-only, missing or full, has its whole transcript built as one string at
				// every full rewrite (a recovery, a branch), and the process's memory grows with the
				// session's age until it is killed; or the rewrite stores other bytes than its lines, and
				// the session the user resumes later lacks what the rewrite carried.
				it.skipIf(spool.skip)(
					`stores a rewrite through ${rewrite.name} with no value past 16 MiB when ${spool.name}`,
					async () => {
						const { outcome, seen, spoolWarnings, stored } = await rewriteWithout(spool, rewrite, SESSION);

						expect({
							outcome,
							largest: seen.what,
							bytes: seen.bytes,
							bounded: seen.bytes <= BOUND,
							staged: seen.calls.includes("writeFullStream"),
						}).toMatchObject({ outcome: "stored", bounded: true, staged: true });
						// The spool was tried, failed as this case makes it fail, and the store said so once.
						expect(spoolWarnings).toEqual([
							expect.objectContaining({ error: expect.stringContaining(spool.cause) }),
						]);
						expect(stored).toEqual(REWRITE.digest);
					},
					TIMEOUT,
				);
			}
		}

		if (kind === "mysql") {
			// If this regresses, a long session on MySQL storage whose path is longer than 473 characters
			// (a subagent's transcript deep under its session's artifacts directory) has its whole
			// transcript decoded into one string and written through `writeFull` at every full rewrite,
			// and the process's memory grows with the session's age until it is killed.
			it(
				"stages a rewrite of a session whose path is 490 characters long, never through writeFull, when os.tmpdir() is under a regular file",
				async () => {
					const spool = UNUSABLE_SPOOLS.find(way => way.cause === "ENOTDIR");
					const rewrite = REWRITES[0];
					if (!spool || !rewrite) throw new Error("Expected the spool under a regular file and writeLinesSync");
					const { outcome, seen, stored } = await rewriteWithout(spool, rewrite, LONG_SESSION);

					expect({
						outcome,
						largest: seen.what,
						bytes: seen.bytes,
						bounded: seen.bytes <= BOUND,
						staged: seen.calls.includes("writeFullStream"),
						writeFullCalls: seen.calls.filter(call => call === "writeFull").length,
					}).toMatchObject({ outcome: "stored", bounded: true, staged: true, writeFullCalls: 0 });
					expect(stored).toEqual(REWRITE.digest);
				},
				TIMEOUT,
			);
		}
	});
}
