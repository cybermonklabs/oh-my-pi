/**
 * A SQL or Redis session store whose backend a test watches: what the store
 * hands its backend and takes back from it ({@link BackendWatch}), reached by
 * slotting a class in for one `create()` ({@link openWatched}), over a table
 * or key prefix of its own that `close()` removes ({@link openStore}).
 */
import type { SessionStorageBackend } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import {
	SqlSessionStorage,
	type SqlSessionStorageAdapter,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RedisClient, SQL } from "bun";
import { Longest, recordMethod } from "./longest-value";
import { dropSessionStoreTables } from "./sql-session-storage";

/** The interface methods of a backend that {@link BackendWatch} wraps, where the backend has them. */
const BACKEND_METHODS = [
	"init",
	"loadIndex",
	"readFull",
	"readSlices",
	"readFrom",
	"readChunks",
	"writeFull",
	"writeFullStream",
	"append",
	"updateSessionTitle",
	"truncate",
	"remove",
	"move",
] as const;

/** What a {@link BackendWatch} saw while it recorded. */
export interface Seen {
	/** The longest string or buffer, in UTF-8 bytes. */
	bytes: number;
	/** Which call handed or returned it. */
	what: string;
	/** The backend methods called, in order, the backend's calls to its own included. */
	calls: string[];
}

/**
 * Records, from `start()` to `stop()`, the longest string or buffer handed to
 * or returned by a backend's methods, as {@link recordMethod} notes them, and
 * which methods ran. It wraps the methods on the backend object itself, so a
 * call the backend makes to its own methods (a streamed write that falls back
 * to `writeFull`) is recorded too, and the backend's private state stays
 * reachable.
 */
export class BackendWatch {
	/**
	 * While `on` is set, each streamed full write (`writeFullStream`) the
	 * backend applies is answered with a lost connection, as a connection that
	 * drops before the answer arrives loses it, and counted in `lost`.
	 */
	readonly loseAnswers = { on: false, lost: 0 };
	readonly #longest = new Longest();
	#calls: string[] = [];

	start(): void {
		this.#longest.reset();
		this.#calls = [];
	}

	stop(): Seen {
		const seen = { bytes: this.#longest.bytes, what: this.#longest.what, calls: this.#calls };
		this.#calls = [];
		return seen;
	}

	instrument(backend: SessionStorageBackend): SessionStorageBackend {
		const members = backend as unknown as Record<string, unknown>;
		for (const name of BACKEND_METHODS) {
			const method = members[name];
			if (typeof method !== "function") continue;
			const recorded = recordMethod(backend, name, method, this.#longest);
			const answered = name === "writeFullStream" ? this.#losingAnswers(recorded) : recorded;
			members[name] = (...args: unknown[]): unknown => {
				this.#calls.push(name);
				return answered(...args);
			};
		}
		return backend;
	}

	/** `write`, a streamed full write, whose answer is lost after it lands while `loseAnswers.on` is set. */
	#losingAnswers(write: (...args: unknown[]) => unknown): (...args: unknown[]) => Promise<unknown> {
		return async (...args) => {
			const result = await write(...args);
			if (!this.loseAnswers.on) return result;
			this.loseAnswers.lost++;
			throw Object.assign(new Error("Connection closed before the write's answer arrived"), {
				code: "ERR_REDIS_CONNECTION_CLOSED",
			});
		};
	}
}

/**
 * `create()` of `Storage`, a direct subclass of `IndexedSessionStorage`, with
 * its backend watched by `watch`. The storage builds its backend privately
 * and hands it to the base class's constructor, so a class slotted in between
 * for this one call instruments it there; `create` builds the storage before
 * its first await.
 */
export function openWatched<S>(Storage: object, create: () => Promise<S>, watch: BackendWatch): Promise<S> {
	const Base: new (backend: SessionStorageBackend) => object = Object.getPrototypeOf(Storage);
	class Watched extends Base {
		constructor(backend: SessionStorageBackend) {
			super(watch.instrument(backend));
		}
	}
	Object.setPrototypeOf(Storage, Watched);
	try {
		return create();
	} finally {
		Object.setPrototypeOf(Storage, Base);
	}
}

/** The store {@link openStore} opens: SQL storage on one of its adapters, or Redis storage. */
export type StoreKind = SqlSessionStorageAdapter | "redis";

/** One case's store: a storage over a table or key prefix of its own, and the cleanup that removes them. */
export interface WatchedStore {
	/** Either reads in chunks, so the stored copy is checked without being joined. */
	readonly storage: RedisSessionStorage | SqlSessionStorage;
	close(): Promise<void>;
}

let storeSeq = 0;

/** A store on `kind` at `url` (any value for SQLite, whose database file is a fresh one), its backend watched by `watch`. */
export async function openStore(kind: StoreKind, url: string, watch: BackendWatch): Promise<WatchedStore> {
	const name = `omp_watched_store_${process.pid}_${Date.now().toString(36)}_${storeSeq++}`;
	if (kind === "redis") {
		const client = new RedisClient(url);
		const prefix = `${name}:`;
		const storage = await openWatched(
			RedisSessionStorage,
			() => RedisSessionStorage.create({ client, prefix }),
			watch,
		);
		return {
			storage,
			close: async () => {
				await storage.drain().catch(() => {});
				for (const key of (await client.send("KEYS", [`${prefix}*`])) as string[]) await client.send("DEL", [key]);
				client.close();
			},
		};
	}
	const dir = kind === "sqlite" ? TempDir.createSync("@omp-watched-store-db-") : undefined;
	const client = new SQL(dir ? `sqlite:${dir.join("sessions.sqlite")}` : url);
	const leaseTable = `${name}_leases`;
	const storage = await openWatched(
		SqlSessionStorage,
		() => SqlSessionStorage.create({ client, adapter: kind, table: name, leaseTable }),
		watch,
	);
	return {
		storage,
		close: async () => {
			await storage.drain().catch(() => {});
			await dropSessionStoreTables(client, name, leaseTable);
			await client.end();
			dir?.removeSync();
		},
	};
}
