/**
 * The store of cold entries' records (see `cold-entries.ts`): a temporary
 * file the account owns alone, or zstd-compressed blocks in memory, with the
 * records read back parsed and frozen through a small cache, and the pacing of
 * full collections that record reads and a load's writes share.
 */
import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { openPrivateTempFileSync, type PrivateTempFile } from "../utils/owner-private-dir";
import { BLOCK_ZSTD_LEVEL } from "./block-zstd-level";
import type { BlobStore } from "./blob-store";
import type { SessionEntry } from "./session-entries";
import { resolveBlobRefsInEntriesSync } from "./session-loader";

/** Materialized records kept for the next field read of the same entries. */
const CACHE_ENTRIES = 8;
/**
 * Bytes the materialized records kept may hold together, each counted with
 * its images resolved ({@link freezeAndMeasure}): a record holds an image as
 * a blob reference, its materialized form as the whole base64 data. A
 * snapcompact frame stays a blob reference in both, read through
 * `lazyImageDataSync` when a context build selects it.
 */
const CACHE_BYTES = 16 * 1024 * 1024;
/**
 * Records are written to the store's file, or compressed into one block when
 * the store keeps them in memory, in batches of at most this size: a batch
 * closes before the record that would take it past this size, so a larger
 * record goes alone and a read of a record near it decompresses no more than
 * this. A file store's read of a record still gathered writes the batch at
 * once, so a write can be smaller and so can the block a failed write leaves.
 */
const WRITE_BATCH_BYTES = 1024 * 1024;
/**
 * Record bytes read back, or written by a load, between two full collections.
 * One synchronous loop over many cold entries (an extension reading every
 * message's content at a session start) would otherwise pile up the parse
 * garbage of every record it reads before the engine collects any of it, and
 * a load the values of every entry it converts. Loading a 344 MiB transcript
 * and then running such a loop peaked at 1,227 MiB resident unpaced and at
 * about 620 MiB with this value, the loop about a second slower and the load
 * about two; 32 and 64 MiB peaked higher.
 */
const COLLECT_AFTER_RECORD_BYTES = 16 * 1024 * 1024;
/** Record bytes counted since the last collection the pacing ran, across stores. */
let recordBytesSinceCollection = 0;

/** Count `bytes` of records; past {@link COLLECT_AFTER_RECORD_BYTES}, run a full collection and count again. */
export function paceCollection(bytes: number): void {
	recordBytesSinceCollection += bytes;
	if (recordBytesSinceCollection < COLLECT_AFTER_RECORD_BYTES) return;
	recordBytesSinceCollection = 0;
	Bun.gc(true);
}

/** Where one entry's record lives, read from the entry's hidden slots. */
export interface ColdRecord {
	readonly store: ColdEntryStore;
	readonly offset: number;
	readonly length: number;
}

/**
 * Deep-freeze `value` and return a lower bound of its JSON text's length,
 * counting each UTF-16 unit as one byte as `jsonFits` in `cold-entries.ts`
 * does. For a materialized record that is its size with each image resolved
 * to the base64 data its blob reference stands for; a snapcompact frame
 * counts as the blob reference it stays.
 */
function freezeAndMeasure(value: unknown): number {
	let units = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const item = pending.pop();
		if (typeof item === "string") units += item.length + 2;
		else if (typeof item !== "object" || item === null) units += 1;
		else if (!Object.isFrozen(item)) {
			Object.freeze(item);
			if (Array.isArray(item)) {
				units += item.length + 1;
				for (const element of item) pending.push(element);
			} else {
				units += 1;
				for (const key of Object.keys(item)) {
					units += key.length + 3;
					pending.push(Reflect.get(item, key));
				}
			}
		}
	}
	return units;
}

/** Records from store offset `start` to `end`, whole, kept compressed in memory. */
interface CompressedBlock {
	readonly start: number;
	readonly end: number;
	readonly data: Uint8Array;
}

/** A {@link CompressedBlock} decompressed: its records' bytes, from store offset `block.start`. */
interface DecompressedBlock {
	readonly block: CompressedBlock;
	readonly data: Buffer;
}

/**
 * Whether a store whose file could not be made was reported; the cause is the
 * host's, so once per process is enough.
 */
let openFailureLogged = false;

/**
 * Closes a store's file once no manager and no cold entry refers to the
 * store. The file registered refers to no store, so it does not keep the
 * store it closes alive.
 */
const storeRegistry = new FinalizationRegistry<PrivateTempFile>(file => file.close());

interface CachedRecord {
	readonly entry: Readonly<Record<string, unknown>>;
	/** The record's size with its images resolved ({@link freezeAndMeasure}), at least its bytes in the store. */
	readonly bytes: number;
}

/**
 * One loaded manager's records of cold entries, with one of two backings.
 * Normally a file under `os.tmpdir()/omp-cold-<uid>/`, a directory the account
 * owns alone, unlinked as soon as it is open (its disk is freed when the
 * descriptor closes, and a killed process leaves nothing). Otherwise the
 * records are kept in memory: where the platform has no account ids (Windows,
 * see {@link open}), where that file cannot be made, and from a failed write
 * to it on (a full disk), they are zstd-compressed in blocks of whole records
 * of at most {@link WRITE_BATCH_BYTES} (a larger record alone); the records
 * gathered for the next block stay as bytes, and the records the file already
 * holds are read from it. A read of a record in a block decompresses that
 * block, and the reads after it in the same synchronous pass share it while
 * they stay in that block, so a pass over the records in store order
 * decompresses each block once; the block is dropped as soon as the pass ends
 * (in a microtask), leaving only the parsed records in the record cache. No
 * other directory is used. A record is the entry exactly as the manager held
 * it, with image data replaced by blob references. Every cold entry refers to
 * its store, so a clone sharing the entries keeps it open as long as it needs
 * it; the last manager holding it closes it when that manager closes
 * ({@link release}).
 */
export class ColdEntryStore {
	readonly #blobs: BlobStore;
	/** The store's file; undefined for a store kept in memory from its start. */
	readonly #file: PrivateTempFile | undefined;
	#closed = false;
	/** Bytes handed out to records. */
	#bytes = 0;
	/** Bytes in the file; every later record is in a block or in `#pending`. */
	#written = 0;
	/** Whether new records go to compressed blocks: there is no file, or a write to it failed. */
	#inMemory: boolean;
	/** The records past the file kept compressed, in offset order. */
	readonly #blocks: CompressedBlock[] = [];
	/**
	 * The block the latest read decompressed, for the reads of the same
	 * synchronous pass (a full rewrite, a walk of every entry); dropped in a
	 * microtask, so nothing of it outlives the pass ({@link #readBlock}).
	 */
	#decompressed: DecompressedBlock | undefined;
	/** The records after the file and the blocks, gathered for the next write or block, in offset order. */
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	/** Managers holding the store ({@link retain}). */
	#holders = 0;
	/** Whether an entry that stayed whole because its record could not be made was reported. */
	#recordFailureLogged = false;
	/**
	 * Materialized records by offset, each counted with its images resolved; a
	 * record larger than {@link CACHE_BYTES} so counted is not kept.
	 */
	readonly #cache = new LRUCache<number, CachedRecord>({
		max: CACHE_ENTRIES,
		maxSize: CACHE_BYTES,
		sizeCalculation: cached => cached.bytes,
	});
	#materializations = 0;
	#hydrations = 0;

	/**
	 * A new store: over a file under `os.tmpdir()/omp-cold-<uid>/`, a directory
	 * that account `uid` owns alone (`openPrivateTempFileSync`), or in memory where
	 * the account id cannot be read (Windows) and where its file cannot be made
	 * (`os.tmpdir()` read-only, under a regular file, full, out of descriptors,
	 * or its directory not one the account owns alone), which last is logged
	 * once per process with the reason.
	 */
	static open(blobs: BlobStore): ColdEntryStore {
		// Without an account id there is no owner to check the store directory
		// against, and a file takes its directory's access list (Windows): the
		// records, which hold the entries unmasked, stay in memory instead.
		const uid = process.getuid?.();
		if (uid === undefined) return new ColdEntryStore(blobs, undefined);
		try {
			return new ColdEntryStore(
				blobs,
				openPrivateTempFileSync("omp-cold", uid, "Older session entry store directory"),
			);
		} catch (error) {
			if (!openFailureLogged) {
				openFailureLogged = true;
				logger.warn(
					"Older session entries are kept compressed in memory: their store cannot be made under the temporary directory",
					{ error: error instanceof Error ? error.message : String(error) },
				);
			}
			return new ColdEntryStore(blobs, undefined);
		}
	}

	/** A store over `file`, or in memory without one; see {@link open}. */
	private constructor(blobs: BlobStore, file: PrivateTempFile | undefined) {
		this.#blobs = blobs;
		this.#file = file;
		this.#inMemory = file === undefined;
		if (file) storeRegistry.register(this, file, this);
	}

	/** Whether the store takes new records: it is open. */
	get writable(): boolean {
		return !this.#closed;
	}

	/** Bytes of records written to the store. */
	get bytes(): number {
		return this.#bytes;
	}

	/** Whether new records are kept compressed in memory: the store has no file, or a write to it failed. */
	get inMemory(): boolean {
		return this.#inMemory;
	}

	/** Bytes of the compressed blocks the store keeps in memory. */
	get compressedBytes(): number {
		let bytes = 0;
		for (const block of this.#blocks) bytes += block.data.byteLength;
		return bytes;
	}

	/** Records read and parsed to serve an accessor read (cache misses). */
	get materializations(): number {
		return this.#materializations;
	}

	/** Cold entries made whole again. */
	get hydrations(): number {
		return this.#hydrations;
	}

	/** The blob store image data of this store's records live in. */
	get blobs(): BlobStore {
		return this.#blobs;
	}

	/**
	 * The record parsed fresh and unfrozen, its blob references resolved when
	 * `resolveBlobs`. Its bytes count toward the next full collection
	 * ({@link COLLECT_AFTER_RECORD_BYTES}). With `onRestored`, a blob the
	 * store's tier restores later is not resolved into the parsed record:
	 * `onRestored` runs instead ({@link resolveBlobRefsInEntriesSync}).
	 */
	parse(record: ColdRecord, resolveBlobs: boolean, onRestored?: () => void): Record<string, unknown> {
		const entry = JSON.parse(this.#read(record).toString("utf8")) as Record<string, unknown>;
		if (resolveBlobs) resolveBlobRefsInEntriesSync([entry as unknown as SessionEntry], this.#blobs, onRestored);
		paceCollection(record.length);
		return entry;
	}

	/**
	 * The record parsed, its blob references resolved and deep-frozen; the 8
	 * most recent are cached while together they hold at most
	 * {@link CACHE_BYTES}. A blob the store's tier restores after the parse is
	 * not written into the frozen record: the record leaves the cache, and the
	 * next read parses it again with the blob in the local store.
	 */
	materialize(record: ColdRecord): Readonly<Record<string, unknown>> {
		const cached = this.#cache.get(record.offset);
		if (cached) return cached.entry;
		const entry = this.parse(record, true, () => this.#cache.delete(record.offset));
		const bytes = Math.max(record.length, freezeAndMeasure(entry));
		this.#materializations++;
		this.#cache.set(record.offset, { entry, bytes });
		return entry;
	}

	/** Count a hydration of one of this store's entries. */
	noteHydration(): void {
		this.#hydrations++;
	}

	/** Report an entry that stays whole because its record could not be made; once per store. */
	noteRecordFailure(error: unknown): void {
		if (this.#recordFailureLogged) return;
		this.#recordFailureLogged = true;
		logger.warn("An older session entry stays in memory: its record could not be made", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	/** Count one more manager holding the store. */
	retain(): void {
		this.#holders++;
	}

	/**
	 * Drop one manager's hold. With `close` (the manager closes) the store
	 * closes at once when no other manager holds it; a store a manager let go
	 * of otherwise (a switch to another session) closes once it is collected,
	 * since a snapshot taken to roll that switch back can still read it.
	 */
	release(close: boolean): void {
		this.#holders = Math.max(0, this.#holders - 1);
		if (close && this.#holders === 0) this.close();
	}

	/** Close the store now; a later read of one of its records throws. */
	close(): void {
		this.#closed = true;
		this.#cache.clear();
		this.#pending = [];
		this.#pendingBytes = 0;
		this.#blocks.length = 0;
		this.#decompressed = undefined;
		if (!this.#file) return;
		storeRegistry.unregister(this);
		this.#file.close();
	}

	/** Write one record; its entry becomes cold through `convertToColdEntry` (cold-entries.ts). Only while {@link writable}. */
	append(data: Buffer): ColdRecord {
		if (!this.writable) throw new Error("A cold entry store that closed cannot take a record.");
		// A record that would take the batch past its size starts the next one,
		// so a block holds one record larger than that alone.
		if (this.#pendingBytes > 0 && this.#pendingBytes + data.length > WRITE_BATCH_BYTES) this.#flush();
		const record: ColdRecord = { store: this, offset: this.#bytes, length: data.length };
		this.#pending.push(data);
		this.#pendingBytes += data.length;
		this.#bytes += data.length;
		if (this.#pendingBytes >= WRITE_BATCH_BYTES) this.#flush();
		return record;
	}

	/** Whether `record` of this store holds exactly `data`, so an entry that goes cold unchanged can take it back. */
	holds(record: ColdRecord, data: Buffer): boolean {
		return record.store === this && record.length === data.length && this.#read(record).equals(data);
	}

	/**
	 * Write the gathered records to the file, or compress them into one block
	 * when the store keeps its records in memory. A failed write (a full disk)
	 * moves the store to blocks, the records that write held first, and tries
	 * no write again, so a full disk costs one attempt; the file keeps serving
	 * the records it holds.
	 */
	#flush(): void {
		if (this.#pendingBytes === 0) return;
		const data = this.#pending.length === 1 ? this.#pending[0]! : Buffer.concat(this.#pending, this.#pendingBytes);
		this.#pending = [];
		this.#pendingBytes = 0;
		if (this.#file && !this.#inMemory) {
			const fd = this.#file.fd;
			try {
				let done = 0;
				while (done < data.length) {
					done += fs.writeSync(fd, data, done, data.length - done, this.#written + done);
				}
				this.#written += data.length;
				return;
			} catch (error) {
				this.#inMemory = true;
				logger.warn("Older session entries are kept compressed in memory: writing their store failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const start = this.#bytes - data.length;
		const block: CompressedBlock = {
			start,
			end: this.#bytes,
			data: Bun.zstdCompressSync(data, { level: BLOCK_ZSTD_LEVEL }),
		};
		this.#blocks.push(block);
	}

	#read(record: ColdRecord): Buffer {
		if (this.#closed) throw new Error("An older session entry was read after its session closed.");
		const pendingStart = this.#bytes - this.#pendingBytes;
		if (record.offset >= pendingStart) {
			// A file store writes the batch the record is in, and reads it back
			// from where that left it; a store in memory reads the gathered bytes.
			if (!this.#inMemory) this.#flush();
			else return this.#readPending(record, pendingStart);
		}
		if (record.offset < this.#written) return this.#readFile(record);
		return this.#readBlock(record);
	}

	/** `record` among the gathered records, which start at store offset `start`. */
	#readPending(record: ColdRecord, start: number): Buffer {
		let offset = start;
		for (const data of this.#pending) {
			if (offset === record.offset && data.length === record.length) return data;
			offset += data.length;
		}
		throw new Error("A cold session entry's record is missing from its store.");
	}

	#readFile(record: ColdRecord): Buffer {
		const file = this.#file;
		if (!file) throw new Error("A cold session entry's record is missing from its store.");
		const fd = file.fd;
		const data = Buffer.allocUnsafe(record.length);
		let done = 0;
		while (done < record.length) {
			const read = fs.readSync(fd, data, done, record.length - done, record.offset + done);
			if (read === 0) throw new Error("A cold session entry's record is truncated.");
			done += read;
		}
		return data;
	}

	/**
	 * `record` from the block that holds it: the block the latest read
	 * decompressed when the record is in it, else its block decompressed and
	 * kept for the reads of the same synchronous pass, which drops it once the
	 * pass ends.
	 */
	#readBlock(record: ColdRecord): Buffer {
		let decompressed = this.#decompressed;
		if (!decompressed || record.offset < decompressed.block.start || record.offset >= decompressed.block.end) {
			const block = this.#blockOf(record);
			decompressed = { block, data: Bun.zstdDecompressSync(block.data) };
			this.#decompressed = decompressed;
			queueMicrotask(() => {
				this.#decompressed = undefined;
			});
		}
		const at = record.offset - decompressed.block.start;
		return decompressed.data.subarray(at, at + record.length);
	}

	/** The block that holds `record`. */
	#blockOf(record: ColdRecord): CompressedBlock {
		const blocks = this.#blocks;
		let low = 0;
		let high = blocks.length - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const block = blocks[middle]!;
			if (record.offset < block.start) high = middle - 1;
			else if (record.offset >= block.end) low = middle + 1;
			else return block;
		}
		throw new Error("A cold session entry's record is missing from its store.");
	}
}
