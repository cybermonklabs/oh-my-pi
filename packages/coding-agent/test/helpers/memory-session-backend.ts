/**
 * Indexed session storage backends that keep each session's text in a map,
 * for tests of what a full write hands its backend and what a read takes from
 * it: one with only a whole write, and one that also takes a streamed write.
 * Both record the bytes of each whole full write and each path a whole read
 * reads. A test that needs a backend which differs in a few methods extends
 * {@link MemoryBackend} and overrides only those.
 */
import type {
	SessionStorageBackend,
	SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";

/**
 * A backend that keeps each session's text in memory and stores a full write
 * as it is given; it records the bytes of each whole full write and each path
 * `readFull` reads.
 */
export class MemoryBackend implements SessionStorageBackend {
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
	/** Move `src`'s text to `dst`, replacing what `dst` held, as the built-in backends do. */
	move(src: string, dst: string): Promise<void> {
		const text = this.sessions.get(src);
		if (text !== undefined) {
			this.sessions.delete(src);
			this.sessions.set(dst, text);
		}
		return Promise.resolve();
	}
}

/** A {@link MemoryBackend} with a streamed full write; it records the bytes of each streamed full write too. */
export class StreamingMemoryBackend extends MemoryBackend {
	readonly streamedBytes: number[] = [];

	async writeFullStream(path: string, chunks: AsyncIterable<Uint8Array>, byteLength: number): Promise<void> {
		const parts: Uint8Array[] = [];
		for await (const chunk of chunks) parts.push(chunk);
		this.streamedBytes.push(byteLength);
		this.sessions.set(path, Buffer.concat(parts).toString("utf8"));
	}
}
