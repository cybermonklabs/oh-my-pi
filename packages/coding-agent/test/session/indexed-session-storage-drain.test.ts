/**
 * Which failed queued writes a drain of an indexed session store (the base of the Redis and SQL stores)
 * reports. A failure on one path is reported to the drain of every path while no write has landed on the
 * store since it: the store may be refusing every write (session-manager-close-drain-latch.test.ts holds a
 * session to that). Once a later write lands the store accepts writes, and the failure is reported only to
 * its own path's drain: a subagent's failed append on a store its parent shares does not fail the parent's
 * flush or close. A drain with no path reports the first failure of any path.
 */
import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { nextTurn, until } from "../helpers/refusing-session-stores";

/** An in-memory backend whose writes to `failing` fail while it is set. */
class PathFailingBackend implements SessionStorageBackend {
	failing: string | undefined;
	/** Writes it failed. */
	refused = 0;
	readonly files = new Map<string, string>();

	#write(path: string): void {
		if (path !== this.failing) return;
		this.refused++;
		throw new Error(`the store refused a write to ${path}`);
	}

	init(): Promise<void> {
		return Promise.resolve();
	}

	loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return Promise.resolve([]);
	}

	readFull(path: string): Promise<string | null> {
		return Promise.resolve(this.files.get(path) ?? null);
	}

	readSlices(): Promise<[string, string]> {
		return Promise.resolve(["", ""]);
	}

	async writeFull(path: string, content: string): Promise<void> {
		this.#write(path);
		this.files.set(path, content);
	}

	async append(path: string, line: string): Promise<void> {
		this.#write(path);
		this.files.set(path, (this.files.get(path) ?? "") + line);
	}

	updateSessionTitle(): Promise<void> {
		return Promise.resolve();
	}

	truncate(): Promise<void> {
		return Promise.resolve();
	}

	remove(): Promise<void> {
		return Promise.resolve();
	}

	move(): Promise<void> {
		return Promise.resolve();
	}
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function indexedStore(): Promise<{ backend: PathFailingBackend; storage: IndexedSessionStorage }> {
	const backend = new PathFailingBackend();
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	return { backend, storage };
}

/** A store holding `a` and `b`, after an append to `a` the store refused. */
async function storeWithRefusedAppend(): Promise<{
	backend: PathFailingBackend;
	storage: IndexedSessionStorage;
	a: string;
	b: string;
}> {
	const { backend, storage } = await indexedStore();
	const a = "/sessions/a.jsonl";
	const b = "/sessions/b.jsonl";
	await storage.writeTextAtomic(a, "a\n");
	await storage.writeTextAtomic(b, "b\n");
	backend.failing = a;
	const writer = storage.openWriter(a);
	writer.appendSync?.("refused\n");
	await writer.flush().catch(() => undefined);
	backend.failing = undefined;
	expect(backend.refused).toBe(1);
	return { backend, storage, a, b };
}

describe("IndexedSessionStorage.drain", () => {
	it("while no write has landed since a failure, reports it to the drain of every path, once each", async () => {
		const { storage, a, b } = await storeWithRefusedAppend();

		await expect(storage.drain(b)).rejects.toThrow(`the store refused a write to ${a}`);
		await expect(storage.drain(b)).resolves.toBeUndefined();
		await expect(storage.drain(a)).rejects.toThrow(`the store refused a write to ${a}`);
		await expect(storage.drain(a)).resolves.toBeUndefined();
	});

	it("once a later write lands, reports a failure only to its own path's drain", async () => {
		const { storage, a, b } = await storeWithRefusedAppend();
		await storage.writeTextAtomic(b, "b, later\n");

		await expect(storage.drain(b)).resolves.toBeUndefined();
		await expect(storage.drain(a)).rejects.toThrow(`the store refused a write to ${a}`);
		await expect(storage.drain(a)).resolves.toBeUndefined();
	});

	it("kept as before: a drain with no path reports the first failure of any path, once", async () => {
		const { storage, a, b } = await storeWithRefusedAppend();
		await storage.writeTextAtomic(b, "b, later\n");

		await expect(storage.drain()).rejects.toThrow(`the store refused a write to ${a}`);
		await expect(storage.drain()).resolves.toBeUndefined();
		await expect(storage.drain(a)).resolves.toBeUndefined();
	});

	it("a parent's close lands when its own write landed after a subagent's refused append, and the subagent's own close still reports it", async () => {
		const { backend, storage } = await indexedStore();
		const child = await SessionManager.open("/sessions/parent/Child.jsonl", undefined, storage, {
			initialCwd: "/cwd",
		});
		child.appendMessage(assistant("the child's first answer"));
		await child.flush();
		backend.failing = child.getSessionFile();
		child.appendMessage(assistant("the child's refused answer"));
		// Let the refusal settle without any drain, which could take the child's failure: one event-loop
		// turn after the backend refused runs the store's handler for it.
		for (let turn = 0; turn < 1000 && backend.refused === 0; turn++)
			await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		expect(backend.refused).toBeGreaterThan(0);

		const parent = SessionManager.create("/cwd", "/sessions/main", storage);
		parent.appendMessage({ role: "user", content: "the parent's question", timestamp: Date.now() });
		parent.appendMessage(assistant("the parent's answer"));
		await expect(parent.close()).resolves.toBeUndefined();
		expect(backend.files.has(parent.getSessionFile() as string)).toBe(true);

		await expect(child.close()).rejects.toThrow("the store refused a write");
		backend.failing = undefined;
	});

	it("a parent's exit wait after a size conflict leaves a subagent's refused append to the subagent's own drain", async () => {
		// If this regresses, the exit wait of a parent whose rewrite met another writer (flushSyncThenConfirm,
		// as a signalled exit records it) takes the failure of a subagent sharing the store: the subagent's
		// own drain no longer reports that its append failed.
		const { backend, storage } = await indexedStore();
		const child = await SessionManager.open("/sessions/parent/Child.jsonl", undefined, storage, {
			initialCwd: "/cwd",
		});
		child.appendMessage(assistant("the child's first answer"));
		await child.flush();
		const childFile = child.getSessionFile() as string;
		backend.failing = childFile;
		child.appendMessage(assistant("the child's refused answer"));
		// Let the refusal settle without any drain, which could take the child's failure: one event-loop
		// turn after the backend refused runs the store's handler for it.
		await until(() => backend.refused > 0, "the child's refused append");
		await nextTurn();

		// Another writer's body lands at the parent's path first, so the parent's own rewrite fails the
		// store's size check, and the child's failure counts only against the child's path from here on.
		const parent = SessionManager.create("/cwd", "/sessions/main", storage);
		await storage.writeTextAtomic(parent.getSessionFile() as string, "another writer's line\n");
		parent.appendMessage({ role: "user", content: "the parent's question", timestamp: Date.now() });
		parent.appendMessage(assistant("the parent's answer"));
		await parent.flushSyncThenConfirm()?.catch(() => undefined);

		await expect(storage.drain(childFile)).rejects.toThrow(`the store refused a write to ${childFile}`);
		backend.failing = undefined;
	});
});
