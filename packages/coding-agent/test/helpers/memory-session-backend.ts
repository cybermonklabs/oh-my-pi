/**
 * Indexed session storage backends that keep each session's text in a map,
 * for tests of what a full write hands its backend: one with only a whole
 * write, and one that also takes a streamed write.
 */
import type {
	SessionStorageBackend,
	SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";

/** A backend that keeps each session's text in memory and stores a full write as it is given. */
export class MemoryBackend implements SessionStorageBackend {
	readonly sessions = new Map<string, string>();

	init(): Promise<void> {
		return Promise.resolve();
	}
	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([]);
	}
	readFull(path: string): Promise<string | null> {
		return Promise.resolve(this.sessions.get(path) ?? null);
	}
	readSlices(): Promise<[string, string]> {
		return Promise.resolve(["", ""]);
	}
	writeFull(path: string, content: string): Promise<void> {
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

/** A {@link MemoryBackend} with a streamed full write; it records the bytes of each full write by kind. */
export class StreamingMemoryBackend extends MemoryBackend {
	readonly streamedBytes: number[] = [];
	readonly writeFullBytes: number[] = [];

	override writeFull(path: string, content: string): Promise<void> {
		this.writeFullBytes.push(Buffer.byteLength(content));
		return super.writeFull(path, content);
	}
	async writeFullStream(path: string, chunks: AsyncIterable<Uint8Array>, byteLength: number): Promise<void> {
		const parts: Uint8Array[] = [];
		for await (const chunk of chunks) parts.push(chunk);
		this.streamedBytes.push(byteLength);
		this.sessions.set(path, Buffer.concat(parts).toString("utf8"));
	}
}
