/**
 * The bodies of indexed storage's full writes (`session-body.ts`): a rewrite of
 * lines a generator yields goes through a private spool file, or, where the
 * account id cannot be read, a compressed copy in memory, and publishes the
 * bytes the lines held when it was queued.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import type {
	SessionStorageWriteOptions,
	WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { FullBodies } from "@oh-my-pi/pi-coding-agent/session/session-body";
import { withoutAccountId } from "../helpers/account-id";
import { MemoryBackend, StreamingMemoryBackend } from "../helpers/memory-session-backend";
import { spoolWarnings } from "../helpers/spool-unusable";

/** A {@link StreamingMemoryBackend} whose streamed full write waits, before it reads a chunk, until the test lets it go on. */
class HeldStreamBackend extends StreamingMemoryBackend {
	#entered = Promise.withResolvers<void>();
	#release = Promise.withResolvers<void>();

	/** Resolve once a streamed full write has started and waits. */
	entered(): Promise<void> {
		return this.#entered.promise;
	}

	/** Let the waiting streamed full write go on, and hold the next one. */
	release(): void {
		const release = this.#release;
		this.#entered = Promise.withResolvers();
		this.#release = Promise.withResolvers();
		release.resolve();
	}

	override async writeFullStream(path: string, chunks: AsyncIterable<Uint8Array>, byteLength: number): Promise<void> {
		const release = this.#release.promise;
		this.#entered.resolve();
		await release;
		await super.writeFullStream(path, chunks, byteLength);
	}
}

/** An indexed storage that records the whole text each full rewrite hands its own text writers. */
class InterceptingIndexedStorage extends IndexedSessionStorage {
	readonly intercepted: string[] = [];

	override writeTextSync(path: string, content: string, options?: SessionStorageWriteOptions): void {
		this.intercepted.push(content);
		super.writeTextSync(path, content, options);
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.intercepted.push(content);
		await super.writeTextAtomic(path, content, options);
	}
}

describe("IndexedSessionStorage full writes of lines a generator yields", () => {
	// `SessionManager` hands a full rewrite its serialized lines as a lazy iterable, which can be read only once.
	const lines = [
		`${JSON.stringify({ type: "session", version: 3, id: "lazy", timestamp: "t0", cwd: "/cwd" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "a", parentId: null, timestamp: "t1" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "n", id: "b", parentId: "a", timestamp: "t2" })}\n`,
	];
	const body = lines.join("");
	function* serialized(): Generator<string> {
		yield* lines;
	}

	it("spools the lines and stores their bytes through writeLinesAtomic and writeLinesSync", async () => {
		const backend = new MemoryBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();

		await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });
		storage.writeLinesSync("/sessions/sync.jsonl", serialized(), { expectedSize: null });
		await storage.drain();

		expect(Object.fromEntries(backend.sessions)).toEqual({
			"/sessions/atomic.jsonl": body,
			"/sessions/sync.jsonl": body,
		});
	});

	it.skipIf(process.getuid === undefined)(
		"spools into a directory of this account's own under the OS temp directory, private to it",
		async () => {
			// Another account on the machine that ran omp first owns any shared name there.
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-dir-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			try {
				const storage = new IndexedSessionStorage(new MemoryBackend());
				await storage.initialize();
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });

				const spools = fs.readdirSync(tmp);
				expect(spools).toEqual([`omp-spool-${process.getuid?.()}`]);
				expect(fs.statSync(path.join(tmp, spools[0] ?? "")).mode & 0o777).toBe(0o700);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	// If this regresses, a full rewrite where the platform gives no account id (Windows) writes the
	// session's unmasked body to a file under the temporary directory, which takes that directory's
	// access list, and no directory owner can be checked against an account id there.
	it("makes no spool file without an account id: streams the body to a backend that takes a stream, and hands it whole to one that does not", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-windows-"));
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
		withoutAccountId();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const streaming = new StreamingMemoryBackend();
			const joined = new MemoryBackend();
			for (const backend of [streaming, joined]) {
				const storage = new IndexedSessionStorage(backend);
				await storage.initialize();
				await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });
				storage.writeLinesSync("/sessions/sync.jsonl", serialized(), { expectedSize: null });
				await storage.drain();
			}

			expect({
				underTmp: fs.readdirSync(tmp),
				streamed: streaming.streamedBytes,
				streamingWriteFull: streaming.writeFullBytes,
				stored: [streaming, joined].map(backend => Object.fromEntries(backend.sessions)),
				spoolWarnings: spoolWarnings(warn.mock.calls),
			}).toEqual({
				underTmp: [],
				streamed: [Buffer.byteLength(body), Buffer.byteLength(body)],
				streamingWriteFull: [],
				stored: [
					{ "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
					{ "/sessions/atomic.jsonl": body, "/sessions/sync.jsonl": body },
				],
				spoolWarnings: [],
			});
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	// If this regresses, a full rewrite where the platform gives no account id (Windows) reads the
	// session's entries again as it publishes, so an entry patched after the rewrite was queued fails
	// the publish ("Session rewrite not stored"): the synchronous rewrite reports a disk failure and the
	// atomic one throws to its caller.
	it("publishes the bytes the lines held when the rewrite was queued without an account id, whatever they hold after", async () => {
		withoutAccountId();
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		vi.spyOn(logger, "error").mockImplementation(() => {});
		try {
			const backend = new HeldStreamBackend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			// A session's rewrite reads its lines from its live entries on each pass over them.
			const live = { data: "as queued" };
			const liveLines: Iterable<string> = {
				*[Symbol.iterator]() {
					yield lines[0]!;
					const entry = {
						type: "custom",
						customType: "n",
						id: "a",
						parentId: null,
						timestamp: "t1",
						data: live.data,
					};
					yield `${JSON.stringify(entry)}\n`;
				},
			};
			const queued = Array.from(liveLines).join("");
			const outcome = (write: Promise<void>): Promise<string> =>
				write.then(
					() => "stored",
					(error: unknown) => String(error),
				);

			storage.writeLinesSync("/sessions/sync.jsonl", liveLines, { expectedSize: null });
			await backend.entered();
			// Same length, other bytes: only the content changed.
			live.data = "patched!!";
			backend.release();
			const sync = await outcome(storage.drain());
			live.data = "as queued";
			const atomicWrite = storage.writeLinesAtomic("/sessions/atomic.jsonl", liveLines, { expectedSize: null });
			await backend.entered();
			live.data = "patched!!";
			backend.release();
			const atomic = await outcome(atomicWrite);

			expect({ sync, atomic, stored: Object.fromEntries(backend.sessions) }).toEqual({
				sync: "stored",
				atomic: "stored",
				stored: { "/sessions/sync.jsonl": queued, "/sessions/atomic.jsonl": queued },
			});
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("hands a subclass that intercepts writeTextAtomic and writeTextSync the joined lines, and stores them", async () => {
		const backend = new MemoryBackend();
		const storage = new InterceptingIndexedStorage(backend);
		await storage.initialize();

		await storage.writeLinesAtomic("/sessions/atomic.jsonl", serialized(), { expectedSize: null });
		storage.writeLinesSync("/sessions/sync.jsonl", serialized(), { expectedSize: null });
		await storage.drain();

		expect(storage.intercepted).toEqual([body, body]);
		expect(Object.fromEntries(backend.sessions)).toEqual({
			"/sessions/atomic.jsonl": body,
			"/sessions/sync.jsonl": body,
		});
	});

	// If this regresses, a spooled body read after its release reads a closed descriptor, or one the
	// process has since given to another file, and publishes that file's bytes as the session.
	it.skipIf(process.getuid === undefined)(
		"refuses a read of a spooled body after its release, through a streamed write and a whole one",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-released-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			const other = path.join(tmp, "other");
			fs.writeFileSync(other, "o".repeat(Buffer.byteLength(body)));
			try {
				const outcomes: Array<{ failure: string | undefined; stored: string | undefined }> = [];
				for (const backend of [new StreamingMemoryBackend(), new MemoryBackend()]) {
					// What the backend holds, read back after a failed publish.
					async function* stored(target: string): AsyncGenerator<Uint8Array> {
						const text = backend.sessions.get(target);
						if (text !== undefined) yield Buffer.from(text);
					}
					const bodies = new FullBodies(backend, stored);
					const released = bodies.lines("/sessions/released.jsonl", serialized());
					released.release?.();
					// The next file opened takes the descriptor number the spool held.
					const fd = fs.openSync(other, "r");
					try {
						// Called inside a task, as the store's path queue calls a publish.
						const failure = await Promise.resolve()
							.then(() => released.publish(1, null))
							.then(
								() => undefined,
								(error: unknown) => String(error),
							);
						outcomes.push({ failure, stored: backend.sessions.get("/sessions/released.jsonl") });
					} finally {
						fs.closeSync(fd);
					}
				}
				const refused = { failure: expect.stringContaining("used after it was closed"), stored: undefined };
				expect(outcomes).toEqual([refused, refused]);
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);

	// If this regresses, an empty spooled body read after its release publishes an empty session
	// through a streamed write, where a longer one refuses the read as the body's contract says.
	it.skipIf(process.getuid === undefined)(
		"refuses a streamed read of an empty spooled body after its release",
		async () => {
			const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-spool-released-empty-"));
			vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
			try {
				const backend = new StreamingMemoryBackend();
				const bodies = new FullBodies(backend, async function* () {});
				const released = bodies.lines("/sessions/empty.jsonl", []);
				released.release?.();
				const failure = await released.publish(1, null).then(
					() => undefined,
					(error: unknown) => String(error),
				);

				expect({
					byteLength: released.byteLength,
					failure,
					stored: backend.sessions.get("/sessions/empty.jsonl"),
				}).toEqual({
					byteLength: 0,
					failure: expect.stringContaining("used after it was closed"),
					stored: undefined,
				});
			} finally {
				vi.restoreAllMocks();
				await fsp.rm(tmp, { recursive: true, force: true });
			}
		},
	);
});
