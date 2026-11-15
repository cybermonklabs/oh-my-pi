import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";

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
