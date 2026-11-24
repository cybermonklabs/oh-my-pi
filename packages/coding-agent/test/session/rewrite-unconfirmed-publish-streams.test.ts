/**
 * INFRA-3530 (R3, check c-no-join): a full rewrite of a long session whose publish cannot be confirmed (the
 * backend applied the streamed write, then its answer was lost, as a dropped connection loses it) checks
 * whether the store holds the rewrite before it reports the write (FullBody.isStored in session-body.ts). No
 * step of a running session builds the whole transcript in memory as one value, so that check reads the
 * stored copy in parts too: no string or buffer the storage takes back from its backend may hold more than
 * 16 MiB of a 24 MiB transcript, on SQL storage and on Redis alike, with the spool usable and without it.
 *
 * Runs on SQLite always, and on Redis when OMP_TEST_REDIS_URL names a throwaway server; each case uses a key
 * prefix or a database file of its own and removes it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	IndexedSessionStorage,
	SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { RedisClient, SQL } from "bun";
import { Longest, recordMethod } from "../helpers/longest-value";
import { pathUnderRegularFile } from "../helpers/spool-unusable";

const MiB = 1024 * 1024;
const BOUND = 16 * MiB;
const TIMEOUT = 300_000;
const TIMESTAMP = "2026-11-24T00:00:00.000Z";
const ID = "01a20f00-0000-7000-8000-00000000c011";
const SESSION = `/sessions/-project-/2026-11-24T00-00-00-000Z_${ID}.jsonl`;

function transcriptLines(title: string, words: string, bytes: number): string[] {
	const lines = [
		serializeTitleSlot({ title, source: "user", updatedAt: TIMESTAMP }),
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: ID, timestamp: TIMESTAMP, cwd: "/project" })}\n`,
	];
	let total = Buffer.byteLength(lines.join(""));
	let parentId: string | null = null;
	for (let n = 0; total < bytes; n++) {
		const text = `${n} ${words.repeat(400)}`;
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

const REWRITE = transcriptLines("Long session", "the session keeps working through the module tree; ", 24 * MiB);
const OLDER = transcriptLines("Older title", "an older copy of the session; ", 2 * MiB).join("");

const METHODS = ["readFull", "readSlices", "readFrom", "readChunks", "writeFull", "writeFullStream", "append"] as const;

/**
 * Open `Storage` (a direct subclass of IndexedSessionStorage) with its backend's methods recorded into
 * `longest`, and its streamed write applied and then answered with a lost connection while `lose.on` is set.
 */
function openWatched<S>(
	Storage: object,
	create: () => Promise<S>,
	longest: Longest,
	lose: { on: boolean; lost: number },
): Promise<S> {
	const Base: new (backend: SessionStorageBackend) => object = Object.getPrototypeOf(Storage);
	class Watched extends Base {
		constructor(backend: SessionStorageBackend) {
			const members = backend as unknown as Record<string, unknown>;
			for (const name of METHODS) {
				const method = members[name];
				if (typeof method !== "function") continue;
				members[name] = recordMethod(backend, name, method, longest);
			}
			const streamed = members.writeFullStream;
			if (typeof streamed === "function") {
				members.writeFullStream = async (...args: unknown[]): Promise<unknown> => {
					const result = await (streamed as (...a: unknown[]) => Promise<unknown>)(...args);
					if (!lose.on) return result;
					lose.lost++;
					throw Object.assign(new Error("Connection closed before the write's answer arrived"), {
						code: "ERR_REDIS_CONNECTION_CLOSED",
					});
				};
			}
			super(backend);
		}
	}
	Object.setPrototypeOf(Storage, Watched);
	try {
		return create();
	} finally {
		Object.setPrototypeOf(Storage, Base);
	}
}

const BACKENDS: ReadonlyArray<{ kind: "sqlite" | "redis"; url: string | undefined }> = [
	{ kind: "sqlite", url: "sqlite" },
	{ kind: "redis", url: process.env.OMP_TEST_REDIS_URL },
];

const originalTmpdir = process.env.TMPDIR;

for (const { kind, url } of BACKENDS) {
	describe.skipIf(!url)(`a full rewrite whose publish cannot be confirmed (${kind})`, () => {
		const cleanups: Array<() => Promise<void> | void> = [];
		afterEach(async () => {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
			vi.restoreAllMocks();
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		});

		async function open(longest: Longest, lose: { on: boolean; lost: number }): Promise<IndexedSessionStorage> {
			const name = `omp_unconfirmed_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
			if (kind === "redis") {
				const client = new RedisClient(url ?? "");
				const prefix = `${name}:`;
				const storage = await openWatched(
					RedisSessionStorage,
					() => RedisSessionStorage.create({ client, prefix }),
					longest,
					lose,
				);
				cleanups.push(async () => {
					await storage.drain().catch(() => {});
					for (const key of (await client.send("KEYS", [`${prefix}*`])) as string[])
						await client.send("DEL", [key]);
					client.close();
				});
				return storage;
			}
			const dir = TempDir.createSync("@omp-unconfirmed-db-");
			const client = new SQL(`sqlite:${dir.join("sessions.sqlite")}`);
			const storage = await openWatched(
				SqlSessionStorage,
				() => SqlSessionStorage.create({ client, adapter: "sqlite", table: name, leaseTable: `${name}_leases` }),
				longest,
				lose,
			);
			cleanups.push(async () => {
				await storage.drain().catch(() => {});
				await client.end();
				dir.removeSync();
			});
			return storage;
		}

		for (const spool of ["usable", "under a regular file"] as const) {
			it(
				`checks the stored copy in parts, never as one value, with the spool ${spool}`,
				async () => {
					const longest = new Longest();
					const lose = { on: false, lost: 0 };
					const storage = await open(longest, lose);
					await storage.writeText(SESSION, OLDER);
					await storage.drain();
					vi.spyOn(logger, "warn").mockImplementation(() => {});
					vi.spyOn(logger, "error").mockImplementation(() => {});
					if (spool !== "usable") {
						const scratch = TempDir.createSync("@omp-unconfirmed-tmp-");
						cleanups.push(() => scratch.removeSync());
						process.env.TMPDIR = pathUnderRegularFile(scratch);
					}

					longest.reset();
					lose.on = true;
					const outcome = await storage
						.writeLinesAtomic(SESSION, REWRITE, { expectedSize: Buffer.byteLength(OLDER) })
						.then(
							() => "stored",
							(err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					lose.on = false;
					const seen = { bytes: longest.bytes, what: longest.what };

					// The write landed and its answer was lost; the check found it stored.
					expect({ outcome, lost: lose.lost }).toEqual({ outcome: "stored", lost: 1 });
					// ... without taking the whole stored transcript back as one value.
					expect({ ...seen, bounded: seen.bytes <= BOUND }).toMatchObject({ bounded: true });
				},
				TIMEOUT,
			);
		}
	});
}
