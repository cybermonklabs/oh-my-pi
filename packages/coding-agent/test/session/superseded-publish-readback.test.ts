import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	MemorySessionStorage,
	type SessionStorage,
	SessionWriteConflictError,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const MiB = 1024 * 1024;

// The SQL case needs a SQL store that reads a transcript in chunks: a store that reads it whole in one
// statement cannot be cut off mid-read by another writer, so where it has no `readChunks` the case skips.
const probeClient = new SQL("sqlite::memory:");
const probe: SessionStorage = await SqlSessionStorage.create({ client: probeClient });
const sqlReadsChunks = typeof probe.readChunks === "function";
await probeClient.end();

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

describe.skipIf(!sqlReadsChunks)("a superseded atomic publish on SQL storage (SQLite)", () => {
	// Regressed: another store's full write of the same bytes cuts off the read-back of a publish that landed
	// while a synchronous rewrite (which the store refused) superseded it, and the manager records nothing:
	// its next full write expects the size from before the publish, conflicts with its own body, and reads
	// the session back once more before it can save.
	it("records the size that landed when another store's rewrite of the same bytes races its read-back", async () => {
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

			const store: SessionStorage = storage;
			const publish = store.writeLinesAtomic?.bind(store);
			const readChunks = store.readChunks?.bind(store);
			if (!publish || !readChunks) throw new Error("Expected a SQL store that publishes lines and reads chunks");
			// The store commits the next atomic publish, and the manager moves on before it hears back.
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
			// Another store writes the same bytes again right after the first chunk of the read-back.
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

			// A rewrite that prunes an entry, and a synchronous rewrite while its publish is in flight, which
			// the store refuses: the file changed size under the size the manager last recorded.
			const pruned = manager.getEntries().find(entry => entry.type === "custom");
			if (pruned?.type !== "custom") throw new Error("Expected a custom entry");
			pruned.data = "pruned";
			const rewrite = manager.rewriteEntries();
			await parked.promise;
			manager.appendCustomEntry("during_rewrite", { data: "x" });
			expect(() => manager.flushSync()).toThrow(SessionWriteConflictError);
			readingBack = true;
			release.resolve();
			await rewrite;

			expect(raced).toBe(true);
			await other.refresh();
			const stored = await other.readText(sessionFile);
			expect(stored).not.toContain("during_rewrite");
			expect(manager.captureState().expectedDiskSize).toBe(Buffer.byteLength(stored, "utf8"));
			await manager.close();
		} finally {
			for (const client of clients) await client.end();
		}
	});
});
