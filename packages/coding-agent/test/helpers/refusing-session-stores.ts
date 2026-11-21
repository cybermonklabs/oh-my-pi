/**
 * Session stores that refuse writes as real ones do, for tests of what a session does while its store
 * refuses: a local disk that is full (or quota-exceeded, read-only, denied), and a PostgreSQL store whose
 * pooled backend is read-only or whose pooler refuses connections. The SQL error shapes are the ones
 * Bun 1.4.4's client gives against PostgreSQL 16.
 */
import { vi } from "bun:test";
import * as path from "node:path";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	type SessionStorageWriteOptions,
	type SessionStorageWriter,
	type WriteTextAtomicOptions,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
	type SqlSessionStorageTransaction,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import type { SQL } from "bun";

/** A file-system error with `code`, as `node:fs` throws it. */
export function fsError(code: string, message = `${code}: the store refused the write`): Error {
	return Object.assign(new Error(message), { code });
}

/** A local disk that refuses writes under the paths it watches while `full` is set. */
export interface FullDisk {
	full: boolean;
	/** Whether it refuses making directories too (the default); a test of a write error alone clears it. */
	dirs: boolean;
	/** The error a refused write throws: ENOSPC unless a test sets another. */
	error: () => Error;
	/** Every write asked for on a watched path, refused or not, in order. */
	readonly attempts: string[];
	/** Refused writes and directories. */
	refused: number;
}

/**
 * Make every `FileSessionStorage` (the one a test builds and the one the code under test builds) refuse,
 * while `disk.full` is set, the directories and writes under the paths `watches` accepts: directory
 * creation, synchronous and atomic rewrites, and appends. `vi.restoreAllMocks()` removes it.
 */
export function installFullDisk(watches: (fpath: string) => boolean, full = true): FullDisk {
	const disk: FullDisk = {
		full,
		dirs: true,
		error: () => fsError("ENOSPC", "ENOSPC: no space left on device, write"),
		attempts: [],
		refused: 0,
	};
	const refuseWrite = (fpath: string): void => {
		if (!watches(fpath)) return;
		disk.attempts.push(fpath);
		if (!disk.full) return;
		disk.refused++;
		throw disk.error();
	};
	const proto = FileSessionStorage.prototype;
	const { ensureDirSync, writeTextSync, writeLinesSync, writeTextAtomic, writeLinesAtomic, openWriter } = proto;
	vi.spyOn(proto, "ensureDirSync").mockImplementation(function (this: FileSessionStorage, dir: string) {
		if (disk.full && disk.dirs && watches(path.join(dir, "_"))) {
			disk.refused++;
			throw disk.error();
		}
		ensureDirSync.call(this, dir);
	});
	vi.spyOn(proto, "writeTextSync").mockImplementation(function (
		this: FileSessionStorage,
		fpath: string,
		content: string,
		options?: SessionStorageWriteOptions,
	) {
		refuseWrite(fpath);
		writeTextSync.call(this, fpath, content, options);
	});
	vi.spyOn(proto, "writeLinesSync").mockImplementation(function (
		this: FileSessionStorage,
		fpath: string,
		lines: readonly string[],
		options?: SessionStorageWriteOptions,
	) {
		refuseWrite(fpath);
		writeLinesSync.call(this, fpath, lines, options);
	});
	vi.spyOn(proto, "writeTextAtomic").mockImplementation(async function (
		this: FileSessionStorage,
		fpath: string,
		content: string,
		options?: WriteTextAtomicOptions,
	) {
		refuseWrite(fpath);
		await writeTextAtomic.call(this, fpath, content, options);
	});
	vi.spyOn(proto, "writeLinesAtomic").mockImplementation(async function (
		this: FileSessionStorage,
		fpath: string,
		lines: readonly string[],
		options?: WriteTextAtomicOptions,
	) {
		refuseWrite(fpath);
		await writeLinesAtomic.call(this, fpath, lines, options);
	});
	vi.spyOn(proto, "openWriter").mockImplementation(function (
		this: FileSessionStorage,
		fpath: string,
		options?: { flags?: "a" | "w"; onError?: (err: Error) => void },
	): SessionStorageWriter {
		const writer = openWriter.call(this, fpath, options);
		return {
			append: async line => {
				refuseWrite(fpath);
				await writer.append(line);
			},
			appendSync: line => {
				refuseWrite(fpath);
				writer.appendSync?.(line);
			},
			flush: () => writer.flush(),
			flushSync: () => writer.flushSync?.(),
			isOpen: () => writer.isOpen(),
			close: () => writer.close(),
			getError: () => writer.getError(),
		};
	});
	return disk;
}

/** How the SQL seam fails: two refusals, and one write error that is not a refusal (42501). */
export type SqlRefusal = "read-only" | "connection" | "permission";

/**
 * SQLite behind the client interface the SQL store drives, failing as a PostgreSQL store behind a
 * pooler does while `refusal` is set: "read-only" refuses every write with 25006 (a pooled backend left
 * in a read-only transaction), "connection" refuses every statement (the pooler is down), and
 * "permission" fails every write with 42501 (a role without the grant), which is not a refusal.
 */
export class RefusingSqlClient implements SqlSessionStorageClient {
	readonly options: SqlSessionStorageClient["options"];
	refusal: SqlRefusal | undefined;
	/** When set, only statements on a session path it accepts fail; the rest of the store accepts them. */
	refusesPath: ((sessionPath: string) => boolean) | undefined;
	refused = 0;
	/** The session paths of every write statement asked for, refused or not, in order. */
	readonly writes: string[] = [];
	readonly #client: InstanceType<typeof SQL>;

	constructor(client: InstanceType<typeof SQL>) {
		this.#client = client;
		this.options = client.options;
	}

	#refuses(query: string | undefined, sessionPath: string | undefined): boolean {
		if (this.refusal === undefined) return false;
		if (this.refusesPath && (sessionPath === undefined || !this.refusesPath(sessionPath))) return false;
		if (this.refusal === "connection") return true;
		return query === undefined || /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query);
	}

	#error(): Error {
		this.refused++;
		if (this.refusal === "connection")
			return Object.assign(new Error("Failed to connect"), {
				name: "PostgresError",
				code: "ERR_POSTGRES_CONNECTION_REFUSED",
			});
		if (this.refusal === "permission")
			return Object.assign(new Error("permission denied for table omp_session_files"), {
				name: "PostgresError",
				code: "ERR_POSTGRES_SERVER_ERROR",
				errno: "42501",
			});
		return Object.assign(new Error("cannot execute INSERT in a read-only transaction"), {
			name: "PostgresError",
			code: "ERR_POSTGRES_SERVER_ERROR",
			errno: "25006",
		});
	}

	async unsafe(query: string, values?: unknown[]): Promise<SqlSessionStorageResult> {
		const sessionPath = values?.find(value => typeof value === "string" && value.endsWith(".jsonl")) as
			| string
			| undefined;
		if (sessionPath !== undefined && /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)) this.writes.push(sessionPath);
		if (this.#refuses(query, sessionPath)) throw this.#error();
		return (await this.#client.unsafe(query, values)) as SqlSessionStorageResult;
	}

	async transaction(callback: (transaction: SqlSessionStorageTransaction) => Promise<void>): Promise<void> {
		if (this.#refuses(undefined, undefined)) throw this.#error();
		await this.#client.transaction(transaction => callback(transaction));
	}

	async end(): Promise<void> {
		await this.#client.end();
	}
}

/**
 * What the SQL store's tables hold for `sessionFile`, read by a second store on the same database (so
 * through no cache of the store under test, and whatever its row layout), with the refusal lifted.
 */
export async function storedSqlContent(client: RefusingSqlClient, sessionFile: string): Promise<string> {
	const refusal = client.refusal;
	client.refusal = undefined;
	try {
		const reader = await SqlSessionStorage.create({ client });
		return reader.existsSync(sessionFile) ? await reader.readText(sessionFile) : "";
	} finally {
		client.refusal = refusal;
	}
}

export function assistant(text: string): AssistantMessage {
	const usage: Usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return {
		role: "assistant",
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text", text }],
		usage,
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** The ids a session file holds, header first, in file order (the title slot line carries none). */
export function storedIds(content: string): string[] {
	return content
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as { type: string; id?: string })
		.filter(record => record.type !== "title")
		.map(record => record.id as string);
}

/** The ids the manager holds, header first. */
export function heldIds(manager: SessionManager): string[] {
	return [manager.getHeader()?.id as string, ...manager.getEntries().map(entry => entry.id)];
}

/** One turn of the event loop: every microtask queued before it has run. No duration. */
export function nextTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/**
 * Yield to the event loop until `done()` holds, at most `turns` times; a counted wait, never a timed
 * one. Throws naming `what` when it never holds.
 */
export async function until(done: () => boolean, what: string, turns = 2000): Promise<void> {
	for (let turn = 0; turn < turns; turn++) {
		if (done()) return;
		await nextTurn();
	}
	if (!done()) throw new Error(`never happened within ${turns} event-loop turns: ${what}`);
}
