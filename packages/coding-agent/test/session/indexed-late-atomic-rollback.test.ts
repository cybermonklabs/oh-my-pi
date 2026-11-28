/**
 * F1 late-rollback repro (holds for HOLD finding 1 on 48642f8432).
 *
 * `writeTextAtomic` settles its backend failure OUTSIDE the path queue: the
 * catch awaits `backend.readFull` after the queued op already rejected. A
 * synchronous write that commits while that readback is parked drops its own
 * frame on success, so when the old readback settles only the old frame
 * remains and `#failFrame` restores the pre-A snapshot over the newer
 * durable index. `statSync` then describes a body the backend no longer
 * holds, and a guarded follow-up keyed on the durable size is rejected.
 *
 * Settler schedule: reject atomic A, gate A's readFull, publish
 * different-sized sync B and await B's confirmWrites, release A's readback
 * (which now observes B). The backend and `statSync` must still describe B
 * and a guarded follow-up replacement must succeed.
 */

import { describe, expect, it } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageChunk,
	type SessionStorageFullRead,
	type SessionStorageIndexEntry,
	type SessionStorageReadTitle,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/**
 * Minimal backend with a gateable `readFull`, one-shot write failures, and
 * one-shot publishes that store the body and then fail, as a lost answer
 * does, while another store's title update lands right after the body.
 */
class GatedBackend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly titles = new Map<string, SessionTitleUpdate>();
	failWrites = 0;
	/** Full writes to store, then answer with a failure, after setting the session's title to {@link titleAfterStore}. */
	storeThenFail = 0;
	titleAfterStore: SessionTitleUpdate | undefined;
	gateReadFull = false;
	readonly writeFullAttempted = deferred();
	readonly readFullGated = deferred();
	#readGate = deferred();
	#readGateOpen = false;

	async init(): Promise<void> {}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return [...this.files].map(([path, content]) => ({
			path,
			size: Buffer.byteLength(content, "utf8"),
			mtimeMs: 0,
		}));
	}

	async readFull(path: string): Promise<SessionStorageFullRead | null> {
		if (this.gateReadFull) {
			this.readFullGated.resolve();
			await this.#readGate.promise;
		}
		const text = this.files.get(path);
		return text === undefined ? null : { text, title: this.titles.get(path) };
	}

	releaseReadFull(): void {
		if (!this.#readGateOpen) {
			this.#readGateOpen = true;
			this.#readGate.resolve();
		}
	}

	async readSlices(
		path: string,
		prefixBytes: number,
		suffixBytes: number,
	): Promise<[string, string, SessionStorageReadTitle]> {
		const bytes = Buffer.from(this.files.get(path) ?? "", "utf8");
		return [
			bytes.subarray(0, prefixBytes).toString("utf8"),
			suffixBytes > 0 ? bytes.subarray(Math.max(0, bytes.length - suffixBytes)).toString("utf8") : "",
			this.titles.get(path),
		];
	}

	async append(path: string, line: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + line);
	}

	async writeFull(
		path: string,
		content: string,
		_mtimeMs: number,
		title?: SessionTitleUpdate,
		expectedSize?: number | null,
	): Promise<void> {
		this.writeFullAttempted.resolve();
		if (this.failWrites > 0) {
			this.failWrites -= 1;
			throw new Error("transient backend write failure");
		}
		const current = this.files.get(path) ?? null;
		const actualSize = current === null ? null : Buffer.byteLength(current, "utf8");
		if (expectedSize !== undefined && actualSize !== expectedSize) {
			throw new Error(`backend conflict for ${path}: expected ${expectedSize}, found ${actualSize}`);
		}
		this.files.set(path, content);
		if (title) this.titles.set(path, title);
		else this.titles.delete(path);
		if (this.storeThenFail > 0) {
			this.storeThenFail -= 1;
			if (this.titleAfterStore) this.titles.set(path, this.titleAfterStore);
			throw new Error("the stored write's answer was lost");
		}
	}

	async updateSessionTitle(path: string, title: SessionTitleUpdate, _mtimeMs: number): Promise<void> {
		this.titles.set(path, title);
	}

	async truncate(path: string, _mtimeMs: number): Promise<void> {
		this.files.set(path, "");
		this.titles.delete(path);
	}

	async remove(paths: string[]): Promise<void> {
		for (const path of paths) {
			this.files.delete(path);
			this.titles.delete(path);
		}
	}

	async move(src: string, dst: string, _mtimeMs: number): Promise<void> {
		const content = this.files.get(src);
		if (content === undefined) throw new Error(`ENOENT: ${src}`);
		const title = this.titles.get(src);
		this.files.delete(src);
		this.titles.delete(src);
		this.files.set(dst, content);
		if (title) this.titles.set(dst, title);
		else this.titles.delete(dst);
	}
}

/** A {@link GatedBackend} with its own chunked read: its start record, then the stored bytes 7 at a time. */
class ChunkedGatedBackend extends GatedBackend {
	async *readChunks(path: string, fromByte: number): AsyncGenerator<SessionStorageChunk> {
		const text = this.files.get(path);
		if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		yield { title: this.titles.get(path) };
		const bytes = Buffer.from(text, "utf8").subarray(fromByte);
		for (let at = 0; at < bytes.byteLength; at += 7) yield bytes.subarray(at, at + 7);
	}
}

describe("late atomic rollback preserves a newer durable write", () => {
	it("keeps B durable when A's gated readback settles after B commits", async () => {
		const backend = new GatedBackend();
		const storage = new IndexedSessionStorage(backend);
		await storage.initialize();
		const path = "session.jsonl";
		const base = "base-line\n";
		storage.writeTextSync(path, base);
		await storage.drain();
		const baseSize = Buffer.byteLength(base, "utf8");

		backend.failWrites = 1;
		backend.gateReadFull = true;
		// Never rejects, so the case waits for the write however it ends, after its read-back is let through.
		const outcome = storage.writeTextAtomic(path, "atomic-A-body\n", { expectedSize: baseSize }).then(
			() => "landed",
			(err: unknown) => (err instanceof Error ? err.message : String(err)),
		);
		const bBody = "B-replacement-with-a-different-size\n";
		try {
			await backend.writeFullAttempted.promise;
			await backend.readFullGated.promise;
			storage.writeTextSync(path, bBody);
			await storage.confirmWrites(path);
		} finally {
			backend.releaseReadFull();
		}
		expect(await outcome).toBe("transient backend write failure");

		const bSize = Buffer.byteLength(bBody, "utf8");
		expect(backend.files.get(path)).toBe(bBody);
		expect(storage.statSync(path).size).toBe(bSize);
		storage.writeTextSync(path, "C\n", { expectedSize: bSize });
	}, 10_000);
});

describe("a failed atomic publish's read-back compares the stored bytes, not the title over them", () => {
	// If this regresses, an atomic rewrite whose answer is lost after it stored its body (a dropped connection)
	// counts as failed whenever the session's title metadata differs from the title slot the body carries (another
	// store renamed the session meanwhile): the index rolls back to the old size, and the next guarded write of the
	// session is refused as a conflict with what is stored.
	const BODY_LINES = [
		serializeTitleSlot({ title: "Title in the body", source: "auto", updatedAt: "2026-11-01T00:00:00.000Z" }),
		`${JSON.stringify({ type: "session", version: 3, id: "rollback", timestamp: "t0", cwd: "/cwd" })}\n`,
		`${JSON.stringify({ type: "custom", customType: "pad", id: "p", parentId: null, data: "x".repeat(300) })}\n`,
	];
	const RENAMED: SessionTitleUpdate = {
		title: "Renamed by a peer",
		source: "user",
		updatedAt: "2026-11-02T00:00:00.000Z",
	};

	for (const { how, Backend, lines } of [
		{ how: "writeTextAtomic, compared whole", Backend: GatedBackend, lines: false },
		{ how: "writeLinesAtomic, compared by its streamed digest", Backend: ChunkedGatedBackend, lines: true },
	]) {
		it(`keeps the stored body of ${how}`, async () => {
			const backend = new Backend();
			const storage = new IndexedSessionStorage(backend);
			await storage.initialize();
			const path = "titled.jsonl";
			const base = "base-line\n";
			await storage.writeText(path, base);
			const body = BODY_LINES.join("");

			backend.storeThenFail = 1;
			backend.titleAfterStore = RENAMED;
			const expectedSize = Buffer.byteLength(base);
			const published = lines
				? storage.writeLinesAtomic(path, BODY_LINES, { expectedSize })
				: storage.writeTextAtomic(path, body, { expectedSize });
			const outcome = await published.then(
				() => "landed",
				(err: unknown) => `failed: ${err instanceof Error ? err.message : String(err)}`,
			);

			const size = Buffer.byteLength(body);
			expect({
				outcome,
				stored: backend.files.get(path) === body,
				size: storage.statSync(path).size,
				// Every reader lays the peer's title over the stored body.
				title: (await storage.readText(path)).slice(0, serializeTitleSlot(RENAMED).length),
			}).toEqual({ outcome: "landed", stored: true, size, title: serializeTitleSlot(RENAMED) });
			storage.writeTextSync(path, "next\n", { expectedSize: size });
			await storage.drain();
			expect(backend.files.get(path)).toBe("next\n");
		}, 10_000);
	}
});
