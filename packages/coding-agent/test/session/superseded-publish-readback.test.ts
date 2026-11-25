import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const MiB = 1024 * 1024;

/**
 * An in-memory store that serves a transcript in small chunks and can park one
 * atomic publish, which then lands even though the manager moved on (a store
 * that committed before it noticed).
 */
class ChunkedLandingStorage extends MemorySessionStorage {
	parkNextAtomic = false;
	readonly atomicParked = Promise.withResolvers<void>();
	readonly releaseAtomic = Promise.withResolvers<void>();
	readonly atomicExpectedSizes: Array<number | null | undefined> = [];
	textReads = 0;
	chunkReads = 0;

	override readText(path: string): Promise<string> {
		this.textReads++;
		return super.readText(path);
	}

	async *readChunks(path: string): AsyncGenerator<Uint8Array> {
		this.chunkReads++;
		const bytes = new TextEncoder().encode(await super.readText(path));
		for (let offset = 0; offset < bytes.length; offset += 7) yield bytes.subarray(offset, offset + 7);
	}

	override async writeTextAtomic(path: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		this.atomicExpectedSizes.push(options?.expectedSize);
		if (!this.parkNextAtomic) return super.writeTextAtomic(path, content, options);
		this.parkNextAtomic = false;
		this.atomicParked.resolve();
		await this.releaseAtomic.promise;
		this.writeTextSync(path, content);
	}
}

describe("a superseded atomic publish", () => {
	it("is read back from the store's chunks and recorded at the size that landed", async () => {
		const storage = new ChunkedLandingStorage();
		const sessionManager = SessionManager.create("/cwd", "/sessions", storage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model");
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response — naïve café" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await sessionManager.flush();
		sessionManager.appendMessage({ role: "user", content: "before the rewrite — ünïcode", timestamp: Date.now() });
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");

		storage.parkNextAtomic = true;
		const rewrite = sessionManager.rewriteEntries();
		await storage.atomicParked.promise;
		// A synchronous rewrite supersedes the parked publish with a body that holds one more entry.
		sessionManager.appendCustomEntry("during_rewrite", { data: "x" });
		sessionManager.flushSync();
		const textReads = storage.textReads;
		const chunkReads = storage.chunkReads;
		storage.releaseAtomic.resolve();
		await rewrite;

		expect(storage.textReads).toBe(textReads);
		expect(storage.chunkReads).toBeGreaterThan(chunkReads);
		const landed = await storage.readText(sessionFile);
		expect(landed).not.toContain("during_rewrite");

		// The next publish expects the size that landed, not the superseding body's.
		const publishes = storage.atomicExpectedSizes.length;
		await sessionManager.rewriteEntries();
		expect(storage.atomicExpectedSizes[publishes]).toBe(Buffer.byteLength(landed, "utf8"));
		await sessionManager.close();
	});
});

describe("an atomic publish an entry races on SQL storage (SQLite)", () => {
	// Regressed: an entry recorded while a rewrite's publish is in flight took a synchronous rewrite that the store
	// refused against the body the publish had already put in its index, reported as a failure; that refused
	// rewrite superseded the publish, which landed and then had to be read back whole, a read-back another store's
	// full write of the same bytes could cut off.
	it("lands the rewrite without reading it back and appends the entry after it, once", async () => {
		using dir = TempDir.createSync("@omp-superseded-sql-");
		const dsn = `sqlite://${dir.join("sessions.db")}`;
		const clients = [new SQL(dsn), new SQL(dsn)];
		try {
			const storage = await SqlSessionStorage.create({ client: clients[0]! });
			const other = await SqlSessionStorage.create({ client: clients[1]! });
			const manager = SessionManager.create("/cwd", path.resolve("/sessions/superseded"), storage);
			for (const fill of ["a", "b", "c", "d"]) manager.appendCustomEntry("pad", { data: fill.repeat(MiB) });
			await manager.ensureOnDisk();
			await manager.flush();
			await storage.drain();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file");

			const publish = storage.writeLinesAtomic.bind(storage);
			const readChunks = storage.readChunks.bind(storage);
			const store: SessionStorage = storage;
			// The store commits the next atomic publish, and the manager hears back only once the test lets it.
			const parked = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let parkNext = true;
			store.writeLinesAtomic = async (filePath, lines, options) => {
				await publish(filePath, lines, options);
				if (!parkNext) return;
				parkNext = false;
				parked.resolve();
				await release.promise;
			};
			// Another store writes the same bytes again right after the first chunk of any read-back.
			let readingBack = false;
			let raced = false;
			store.readChunks = (filePath, fromByte) =>
				(async function* () {
					for await (const chunk of readChunks(filePath, fromByte)) {
						yield chunk;
						if (!readingBack || raced) continue;
						raced = true;
						await other.refresh();
						const landed = await other.readText(filePath);
						await other.writeTextAtomic(filePath, landed, { expectedSize: other.statSync(filePath).size });
						await other.drain();
					}
				})();

			// A rewrite that prunes an entry, and an entry recorded and flushed while its publish is in flight.
			const pruned = manager.getEntries().find(entry => entry.type === "custom");
			if (pruned?.type !== "custom") throw new Error("Expected a custom entry");
			pruned.data = "pruned";
			const rewrite = manager.rewriteEntries();
			await parked.promise;
			manager.appendCustomEntry("during_rewrite", { data: "x" });
			let flushSyncError: string | undefined;
			try {
				manager.flushSync();
			} catch (err) {
				flushSyncError = String(err);
			}
			readingBack = true;
			release.resolve();
			await rewrite;
			await manager.flush();

			await other.refresh();
			const stored = await other.readText(sessionFile);
			expect({
				flushSyncError,
				readBack: raced,
				failure: manager.getPersistenceFailure()?.message,
				pruned: stored.includes('"data":"pruned"'),
				// One copy: the type splits the transcript in two.
				entryCopies: stored.split('"customType":"during_rewrite"').length,
				expectsWhatIsStored: manager.captureState().expectedDiskSize === Buffer.byteLength(stored, "utf8"),
			}).toEqual({
				flushSyncError: undefined,
				readBack: false,
				failure: undefined,
				pruned: true,
				entryCopies: 2,
				expectsWhatIsStored: true,
			});
			await manager.close();
		} finally {
			for (const client of clients) await client.end();
		}
	});
});
