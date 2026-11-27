import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { blobExtensionForImageMimeType } from "@oh-my-pi/pi-tui/prompt/image-format";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ConcatSink,
	getBlobsDir,
	isEisdir,
	isEnoent,
	isEnotdir,
	jsonContainerEnd,
	logger,
	type NestedWalk,
	parseJsonlLenient,
	peekFile,
	runNested,
	tryParseJson,
} from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { Semaphore } from "../task/parallel";
import { isArchivedSessionPath } from "./session-archive";
import {
	BlobStore,
	externalizeImageData,
	isBlobRef,
	lazyImageDataSync,
	parseBlobRef,
	resolveImageData,
	resolveImageDataSync,
	resolveImageDataUrl,
	resolveImageDataUrlSync,
} from "./blob-store";
import { buildSessionContext } from "./session-context";
import {
	activeBranch,
	type CompactionEntry,
	type FileEntry,
	type RawFileEntry,
	type SessionEntry,
	type SessionHeader,
} from "./session-entries";
import { migrateToCurrentVersion } from "./session-migrations";
import { imageAt, isPersistenceTruncatedString, resolvedImageSiteOf } from "./session-persistence";
import {
	defaultSessionStorage,
	FileSessionStorage,
	retryRacedRead,
	SessionReadConflictError,
	type SessionStorage,
} from "./session-storage";
import { enotdir } from "./session-storage-errors";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";
import { applyEntryPatches } from "./entry-patches";
import { applyToolResultPrunes } from "./tool-result-prunes";

const LF = new Uint8Array([0x0a]);

const STREAM_LOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;
const STREAM_YIELD_BYTES = 1 * 1024 * 1024;
const STREAM_YIELD_ENTRIES = 8_192;
/** Initial parse window after a malformed record; see the recovery note in visitEntriesFromFileStream. */
const RECOVERY_PARSE_WINDOW = 64 * 1024;
const BLOB_READ_CONCURRENCY = 8;
/** Hash for snapshot freshness digests; collisions must not be producible by ordinary edits. */
const SNAPSHOT_DIGEST_ALGORITHM = "sha256";

/**
 * Complete optional accounting fields from persisted/imported assistant turns.
 * Complete provider usage is left untouched; missing prices never discard reported tokens.
 */
export function normalizeAssistantUsage(message: Extract<AgentMessage, { role: "assistant" }>): boolean {
	const usage = message.usage;
	if (
		usage &&
		usage.input !== undefined &&
		usage.output !== undefined &&
		usage.cacheRead !== undefined &&
		usage.cacheWrite !== undefined &&
		usage.totalTokens !== undefined &&
		usage.cost?.input !== undefined &&
		usage.cost.output !== undefined &&
		usage.cost.cacheRead !== undefined &&
		usage.cost.cacheWrite !== undefined &&
		usage.cost.total !== undefined
	) {
		return false;
	}
	const input = usage?.input ?? 0;
	const output = usage?.output ?? 0;
	const cacheRead = usage?.cacheRead ?? 0;
	const cacheWrite = usage?.cacheWrite ?? 0;
	const cost = usage?.cost;
	message.usage = {
		...usage,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens:
			usage?.totalTokens ??
			input +
				output +
				cacheRead +
				cacheWrite +
				(usage?.orchestration?.input ?? 0) +
				(usage?.orchestration?.cacheRead ?? 0) +
				(usage?.orchestration?.output ?? 0),
		cost: {
			...cost,
			input: cost?.input ?? 0,
			output: cost?.output ?? 0,
			cacheRead: cost?.cacheRead ?? 0,
			cacheWrite: cost?.cacheWrite ?? 0,
			total:
				cost?.total ?? (cost?.input ?? 0) + (cost?.output ?? 0) + (cost?.cacheRead ?? 0) + (cost?.cacheWrite ?? 0),
		},
	};
	return true;
}

export interface VisitEntriesFromFileStreamOptions {
	/** Stop after the visitor returns `false`. */
	shouldContinue?: () => boolean;
	/** Stop after this many valid or malformed JSONL records have been consumed. */
	maxRecords?: number;
	/** Read at most this many bytes from the file's current prefix. */
	maxBytes?: number;
	/** Yield to the macrotask queue after this many bytes have been consumed. */
	yieldEveryBytes?: number;
	/** Yield to the macrotask queue after this many entries have been visited. */
	yieldEveryEntries?: number;
	/** Called once for every malformed JSONL record skipped by the stream. */
	onMalformedRecord?: () => void;
	/** Rethrow missing source instead of visiting nothing (fork backstop). */
	throwIfMissing?: boolean;
	/**
	 * Called with each stream chunk as it is consumed. Lets callers derive the
	 * exact snapshot size and digest without reading the file again.
	 */
	onChunk?: (chunk: Uint8Array) => void;
	/**
	 * Storage holding the transcript. A storage with `readChunks` (file and
	 * key-indexed ones such as `session.storage: sql`) streams it; any other is
	 * read whole and fed through the same parser. Defaults to the configured
	 * storage, which is what a resumed session's own transcripts live in.
	 */
	storage?: SessionStorage;
	/** The transcript's bytes, e.g. a decompressed archive, read instead of `filePath`. */
	chunks?: AsyncIterable<Uint8Array>;
}

/** Controls how a missing session file is handled. */
export interface LoadSessionOptions {
	/** Propagate ENOENT instead of treating the path as a new empty session. */
	throwIfMissing?: boolean;
	/** Record {@link SessionLoadResult.sourceDigest} for a later {@link sessionContentDigest} comparison. */
	digest?: boolean;
	/** Storage holding the transcript; defaults to the configured storage. */
	storage?: SessionStorage;
}

/** Parsed session entries plus corruption metadata needed by writable loaders. */
export interface SessionLoadResult {
	entries: FileEntry[];
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Byte length of the snapshot actually parsed, or `null` when the path did not exist. */
	sourceSize?: number | null;
	/** {@link sessionContentDigest} of the parsed snapshot, when the load was asked for one. */
	sourceDigest?: string;
	/** Whether non-empty session data was found without a valid leading session header. */
	invalidHeader: boolean;
}

function splitTitleSlot(content: string): { body: string; slot: SessionTitleUpdate | undefined } {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot) return { body: content, slot: undefined };
	const newlineIndex = content.indexOf("\n");
	return { body: content.slice(newlineIndex + 1), slot };
}

export function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/** Parse session JSONL while stripping and folding the optional fixed title slot. */
export function parseSessionContent(content: string): SessionLoadResult {
	const { body, slot } = splitTitleSlot(content);
	let malformedRecords = 0;
	const entries = parseJsonlLenient<RawFileEntry>(body, {
		onMalformedRecord: () => {
			malformedRecords++;
		},
	}) as FileEntry[];
	applyTitleSlot(entries[0], slot);
	return {
		entries,
		titleSlot: slot,
		malformedRecords,
		sourceSize: Buffer.byteLength(content, "utf8"),
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}

/** Upper bound on the bytes read to find a header: real headers (and the title slot before them) are far smaller. */
const SESSION_HEADER_READ_LIMIT = 1024 * 1024;
/** First read; holds the title slot and any real header, so the full limit is read only for outliers. */
const SESSION_HEADER_FIRST_READ = 16 * 1024;

/** {@link sessionHeaderIdFromPrefix} result when the window ends inside the first record. */
const HEADER_INCOMPLETE = Symbol("header-incomplete");

/**
 * The session id in `filePath`'s header, or `undefined` when the storage holds
 * nothing there or it does not start with a valid session header. A file
 * backend reads {@link SESSION_HEADER_FIRST_READ} bytes, and up to
 * {@link SESSION_HEADER_READ_LIMIT} only when the first record runs past them;
 * a key-indexed backend reads the same prefix window through the storage.
 */
export async function readSessionHeaderId(
	filePath: string,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<string | undefined> {
	try {
		if (!(storage instanceof FileSessionStorage)) {
			const [prefix] = await storage.readTextSlices(filePath, SESSION_HEADER_READ_LIMIT, 0);
			const id = sessionHeaderIdFromPrefix(new TextEncoder().encode(prefix), true);
			return id === HEADER_INCOMPLETE ? undefined : id;
		}
		const id = await peekFile(filePath, SESSION_HEADER_FIRST_READ, prefix =>
			sessionHeaderIdFromPrefix(prefix, prefix.length < SESSION_HEADER_FIRST_READ),
		);
		if (id !== HEADER_INCOMPLETE) return id;
		const full = await peekFile(filePath, SESSION_HEADER_READ_LIMIT, prefix =>
			sessionHeaderIdFromPrefix(prefix, true),
		);
		return full === HEADER_INCOMPLETE ? undefined : full;
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
}

/**
 * The header id from a file's leading bytes, past the optional title slot
 * line. Parses only the first record, which may span lines (a pretty-printed
 * header). {@link HEADER_INCOMPLETE} when that record runs past `prefix` and
 * `final` is false (more of the file can be read).
 */
function sessionHeaderIdFromPrefix(prefix: Uint8Array, final: boolean): string | undefined | typeof HEADER_INCOMPLETE {
	let records = prefix;
	const newline = prefix.indexOf(0x0a);
	if (newline !== -1) {
		const firstLine = new TextDecoder().decode(prefix.subarray(0, newline)).trim();
		if (firstLine && parseTitleSlotLine(firstLine)) records = prefix.subarray(newline + 1);
	}
	// Like the full parser, skip blank lines (and other JSON whitespace) before the first record.
	let start = 0;
	while (start < records.length) {
		const byte = records[start];
		if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) break;
		start++;
	}
	records = records.subarray(start);
	if (records.length === 0) return final ? undefined : HEADER_INCOMPLETE;
	// A header is an object; anything else is not a session file.
	if (records[0] !== 0x7b) return undefined;
	const text = new TextDecoder().decode(records);
	const end = jsonContainerEnd(text, 0);
	if (end === -1) return final ? undefined : HEADER_INCOMPLETE;
	const entry = tryParseJson<FileEntry>(text.slice(0, end)) ?? undefined;
	return isValidSessionHeader(entry) ? entry.id : undefined;
}

/**
 * The transcript's bytes, as chunks: the storage's own chunks where it has
 * `readChunks`, a file stream for file storage, and otherwise its whole text
 * as one chunk. A missing transcript raises ENOENT from any source, which the
 * caller tolerates.
 */
export async function* transcriptByteChunks(filePath: string, storage: SessionStorage): AsyncGenerator<Uint8Array> {
	if (storage.readChunks) {
		yield* storage.readChunks(filePath);
		return;
	}
	yield new TextEncoder().encode(await storage.readText(filePath));
}

function hasPayload(bytes: Uint8Array, start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		const byte = bytes[index];
		if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return true;
	}
	return false;
}

/**
 * The lenient JSONL parse of a transcript's bytes behind
 * {@link visitEntriesFromFileStream} and {@link visitEntriesFromChunksSync}.
 * Bytes, not text: a multibyte UTF-8 sequence straddling a chunk boundary
 * stays intact, and Bun.JSONL.parseChunk takes typed arrays directly. Only the
 * unconsumed remainder is held (≤ one record + a chunk), so the ≥8MiB memory
 * guard holds — the file is never fully loaded.
 */
class TranscriptRecordParser {
	titleSlot: SessionTitleUpdate | undefined;
	/** Valid and malformed records consumed; the visitor counts the valid ones it accepts. */
	recordsSeen = 0;
	/** Set to stop the parse: the visitor declined an entry, or the record cap was reached. */
	stopped = false;
	readonly #maxRecords: number;
	readonly #onMalformedRecord: (() => void) | undefined;
	readonly #sink = new ConcatSink();
	readonly #decoder = new TextDecoder();
	#sawFirstLine = false;
	#sawFirstEntry = false;

	constructor(maxRecords: number, onMalformedRecord: (() => void) | undefined) {
		this.#maxRecords = maxRecords;
		this.#onMalformedRecord = onMalformedRecord;
	}

	append(chunk: Uint8Array): void {
		this.#sink.append(chunk);
	}

	/**
	 * Peel the optional fixed-width title slot, a physical first line that is
	 * NOT JSON, before the parser would (correctly) reject it. Call once a held
	 * chunk ends a line: the first line ends at a '\n' byte, so it is a complete
	 * UTF-8 sequence and safe to decode. A non-slot first line is a real entry
	 * and is left for the parser; a blank first line is left for the parser to skip.
	 */
	peelTitleSlot(): void {
		if (this.#sawFirstLine) return;
		const buffered = this.#sink.flush()!;
		const newline = buffered.indexOf(0x0a);
		if (newline === -1) return;
		this.#sawFirstLine = true;
		const firstLine = this.#decoder.decode(buffered.subarray(0, newline)).trim();
		if (!firstLine) return;
		const slot = parseTitleSlotLine(firstLine);
		if (!slot) return;
		this.titleSlot = titleUpdateFromSlot(slot);
		this.#sink.consume(newline + 1);
	}

	/**
	 * Yield each entry the held newline-terminated bytes complete, the parse
	 * waiting at each until the visitor took it (or set {@link stopped}).
	 * parseChunk can leave a value unfinished even after a newline; the
	 * remainder stays held for the next chunk, unless `endOfInput`, when it is
	 * a truncated record.
	 */
	*drain(endOfInput = false): Generator<FileEntry> {
		const view = this.#sink.flush();
		if (!view) return;
		// Only newline-terminated bytes may reach the parser: a trailing fragment
		// in the same call turns an end-of-input `done` into a syntax error at the
		// preceding newline, which would then be miscounted as a malformed record.
		const lastNewline = view.lastIndexOf(0x0a);
		if (lastNewline === -1) return;
		let buffer: Uint8Array = view.subarray(0, lastNewline + 1);
		let consumed = 0;
		const advance = (count: number): void => {
			consumed += count;
			buffer = buffer.subarray(count);
		};
		// parseChunk costs time proportional to its whole input even when it stops at
		// the first bad line, so recovering line by line over the full buffer is
		// quadratic. After a malformed record, parse a newline-cut window that grows
		// while the input keeps parsing and resets on the next error.
		let window = Number.POSITIVE_INFINITY;
		try {
			while (buffer.length > 0 && !this.stopped) {
				if (this.recordsSeen >= this.#maxRecords) {
					this.stopped = true;
					break;
				}
				let input = buffer;
				if (window < buffer.length) {
					const cut = buffer.indexOf(0x0a, window - 1);
					if (cut !== -1) input = buffer.subarray(0, cut + 1);
				}
				const partial = input.length < buffer.length;
				const { values, error, read, done } = Bun.JSONL.parseChunk(input);
				for (const value of values) {
					if (this.recordsSeen >= this.#maxRecords) {
						this.stopped = true;
						break;
					}
					const entry = value as FileEntry;
					if (!this.#sawFirstEntry) {
						this.#sawFirstEntry = true;
						applyTitleSlot(entry, this.titleSlot);
					}
					yield entry;
					if (this.stopped) break;
				}
				if (this.stopped) break;
				if (error) {
					// Malformed record: skip past the next newline and continue.
					const nextNewline = buffer.indexOf(0x0a, read);
					if (nextNewline === -1) break; // rest of the bad line not yet received
					if (hasPayload(buffer, read, nextNewline)) this.#onMalformedRecord?.();
					this.recordsSeen++;
					advance(nextNewline + 1);
					window = RECOVERY_PARSE_WINDOW;
					if (this.recordsSeen >= this.#maxRecords) {
						this.stopped = true;
						break;
					}
					continue;
				}
				if (read === 0) {
					if (partial) {
						// The record runs past the window, not past the buffered input.
						window *= 2;
						continue;
					}
					// Incomplete value awaiting more bytes. Once the input has ended nothing more
					// is coming, so it is a truncated record (parseJsonlLenient counts it too).
					if (endOfInput) {
						if (hasPayload(buffer, 0, buffer.length)) this.#onMalformedRecord?.();
						this.recordsSeen++;
						advance(buffer.length);
					}
					break;
				}
				advance(read);
				if (done) {
					// The parser reached the end of its input; whatever trails the last value is whitespace.
					advance(input.length - read);
					if (!partial) break;
				}
				if (partial) window *= 2;
			}
		} finally {
			this.#sink.consume(consumed);
		}
	}

	/**
	 * A trailing record without a final newline: terminate it so the parser
	 * can complete it (readline yielded it; parseChunk needs the delimiter).
	 */
	*finish(): Generator<FileEntry> {
		if (this.stopped || this.#sink.isEmpty) return;
		this.#sink.append(LF);
		yield* this.drain(true);
	}
}

/**
 * Parse session JSONL and visit each entry without retaining prior entries.
 * Entries are visited as written: a `tool_result_prune` or `entry_patch`
 * record is visited as an entry, and the fields it sets on an earlier entry
 * are not set on it.
 */
export async function visitEntriesFromFileStream(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	options: VisitEntriesFromFileStreamOptions = {},
): Promise<SessionTitleUpdate | undefined> {
	let bytesSinceYield = 0;
	let entriesSinceYield = 0;
	const maxRecords = Math.max(0, options.maxRecords ?? Number.POSITIVE_INFINITY);
	let visitorThrew = false;
	const yieldEveryBytes = Math.max(0, options.yieldEveryBytes ?? STREAM_YIELD_BYTES);
	const yieldEveryEntries = Math.max(0, options.yieldEveryEntries ?? STREAM_YIELD_ENTRIES);
	const maxBytes = Math.max(0, options.maxBytes ?? Number.POSITIVE_INFINITY);
	const parser = new TranscriptRecordParser(maxRecords, options.onMalformedRecord);

	const yieldToMacrotask = async (): Promise<void> => {
		if (yieldEveryBytes === 0 && yieldEveryEntries === 0) return;
		const bytesReady = yieldEveryBytes === 0 || bytesSinceYield < yieldEveryBytes;
		const entriesReady = yieldEveryEntries === 0 || entriesSinceYield < yieldEveryEntries;
		if (bytesReady && entriesReady) {
			return;
		}
		bytesSinceYield = 0;
		entriesSinceYield = 0;
		await Bun.sleep(0);
	};

	const visitParsed = async (entries: Iterable<FileEntry>): Promise<void> => {
		for (const entry of entries) {
			if (options.shouldContinue && !options.shouldContinue()) {
				parser.stopped = true;
				break;
			}
			try {
				if (visit(entry) === false) {
					parser.stopped = true;
					break;
				}
				parser.recordsSeen++;
				entriesSinceYield++;
				if (parser.recordsSeen >= maxRecords) {
					parser.stopped = true;
					break;
				}
			} catch (err) {
				visitorThrew = true;
				throw err;
			}
			await yieldToMacrotask();
		}
	};

	try {
		// Capped by hand, not with `file.slice(0, maxBytes)`: on Bun 1.3.14 a slice's
		// stream over a file that continues past the slice either stays pending after
		// delivering its bytes (macOS) or ignores the bound and streams the whole
		// file (Windows).
		let unread = maxBytes;
		const chunks = options.chunks ?? transcriptByteChunks(filePath, options.storage ?? defaultSessionStorage());
		for await (const streamed of chunks) {
			const chunk = streamed.byteLength > unread ? streamed.subarray(0, unread) : streamed;
			unread -= chunk.byteLength;
			bytesSinceYield += chunk.byteLength;
			options.onChunk?.(chunk);
			// Parsing before the chunk closes a line re-scans the unfinished record
			// on every chunk, which is quadratic for large records.
			if (chunk.lastIndexOf(0x0a) === -1) {
				// Skipping the parse also skips the only enforcement of the record cap,
				// so re-check it here: a delimiter-free file would otherwise be read
				// and buffered in full despite an exhausted budget.
				if (parser.recordsSeen >= maxRecords) {
					parser.stopped = true;
					break;
				}
				parser.append(chunk);
				await yieldToMacrotask();
				if (unread === 0) break;
				continue;
			}
			parser.append(chunk);
			parser.peelTitleSlot();
			await visitParsed(parser.drain());
			// Stop before the loop pulls another chunk: a stopped visitor reads no further.
			if (parser.stopped) break;
			await yieldToMacrotask();
			if (unread === 0) break;
		}
		await visitParsed(parser.finish());
	} catch (err) {
		if (visitorThrew) throw err;
		if (options.throwIfMissing && (isEnoent(err) || isEnotdir(err))) {
			throw err;
		}
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}

	return parser.titleSlot;
}

/**
 * {@link visitEntriesFromFileStream} for a caller that cannot wait: visit the
 * entries of the transcript bytes `chunks` yields, holding one chunk and the
 * unfinished record at a time. Returns the title slot, if the first line is one.
 */
export function visitEntriesFromChunksSync(
	chunks: Iterable<Uint8Array>,
	visit: (entry: FileEntry) => void | boolean,
	options: Pick<VisitEntriesFromFileStreamOptions, "onMalformedRecord" | "onChunk"> = {},
): SessionTitleUpdate | undefined {
	const parser = new TranscriptRecordParser(Number.POSITIVE_INFINITY, options.onMalformedRecord);
	const visitParsed = (entries: Iterable<FileEntry>): void => {
		for (const entry of entries) {
			if (visit(entry) === false) {
				parser.stopped = true;
				return;
			}
			parser.recordsSeen++;
		}
	};
	for (const chunk of chunks) {
		options.onChunk?.(chunk);
		parser.append(chunk);
		// Parsing before the chunk closes a line re-scans the unfinished record.
		if (chunk.lastIndexOf(0x0a) === -1) continue;
		parser.peelTitleSlot();
		visitParsed(parser.drain());
		if (parser.stopped) break;
	}
	visitParsed(parser.finish());
	return parser.titleSlot;
}

/**
 * The ≥8MiB streaming load (works on any size), of `filePath` or of `options.chunks`.
 * ENOENT after bytes were read means a delete or replacement cut the read
 * short: it raises `SessionReadConflictError`, which {@link loadSessionFile}
 * answers by reading again from the start, never returning the prefix read.
 */
export async function loadEntriesFromFileStream(
	filePath: string,
	options?: Pick<LoadSessionOptions, "throwIfMissing" | "digest" | "storage"> &
		Pick<VisitEntriesFromFileStreamOptions, "chunks">,
): Promise<SessionLoadResult> {
	const entries: FileEntry[] = [];
	let malformedRecords = 0;
	let bytesConsumed = 0;
	const hasher = options?.digest ? new Bun.CryptoHasher(SNAPSHOT_DIGEST_ALGORITHM) : undefined;
	let titleSlot: SessionTitleUpdate | undefined;
	try {
		titleSlot = await visitEntriesFromFileStream(
			filePath,
			entry => {
				entries.push(entry);
			},
			{
				onMalformedRecord: () => {
					malformedRecords++;
				},
				throwIfMissing: true,
				chunks: options?.chunks,
				onChunk: chunk => {
					bytesConsumed += chunk.byteLength;
					hasher?.update(chunk);
				},
				storage: options?.storage,
			},
		);
	} catch (err) {
		if (bytesConsumed > 0 && isEnoent(err)) throw new SessionReadConflictError(filePath);
		if (options?.throwIfMissing || !isEnoent(err)) throw err;
	}
	return {
		entries,
		titleSlot,
		malformedRecords,
		sourceSize: bytesConsumed,
		sourceDigest: hasher?.digest("hex"),
		invalidHeader: entries.length > 0 ? !isValidSessionHeader(entries[0]) : malformedRecords > 0,
	};
}
/** Exported for compaction.test.ts */
export function parseSessionEntries(content: string): FileEntry[] {
	return parseSessionContent(content).entries;
}
/**
 * A transcript of {@link STREAM_LOAD_THRESHOLD_BYTES} or more is streamed from any storage that can stream it.
 * The streaming path reads raw bytes straight off the file, so an archived
 * (gzipped) transcript always takes the whole-text path, which inflates it.
 */
function shouldStreamEntries(storage: SessionStorage, filePath: string, size: number): boolean {
	return storage.readChunks !== undefined && size >= STREAM_LOAD_THRESHOLD_BYTES && !isArchivedSessionPath(filePath);
}

/**
 * Digest of `filePath`'s current bytes, hashed chunk by chunk as
 * {@link transcriptByteChunks} yields them, so a transcript the storage
 * streams is never held whole. Equal to a load's
 * {@link SessionLoadResult.sourceDigest} only when the content is unchanged, so
 * it is a freshness check that trusts no size, mtime, or inode. Throws ENOENT
 * when the session is gone, including a row an indexed backend no longer holds.
 *
 * A file transcript under the 8 MiB streaming threshold is digested at load
 * from the text `readText` decodes, which differs from the file's bytes only
 * when the file has a byte-order mark or invalid UTF-8. Such a file reads as
 * changed here and costs one extra parse, never a wrong answer.
 *
 * A full rewrite or delete that races the read (`SessionReadConflictError`)
 * is hashed again from its start through {@link retryRacedRead}, never as one
 * whole-text read.
 */
export async function sessionContentDigest(filePath: string, storage: SessionStorage): Promise<string> {
	return retryRacedRead(() => hashTranscriptPass(filePath, storage));
}

/** One read of {@link sessionContentDigest}, from the transcript's start. */
async function hashTranscriptPass(filePath: string, storage: SessionStorage): Promise<string> {
	const hasher = new Bun.CryptoHasher(SNAPSHOT_DIGEST_ALGORITHM);
	if (isArchivedSessionPath(filePath)) {
		// An archived (gzipped) transcript loads through `readText`, which inflates it.
		hasher.update(await storage.readText(filePath));
	} else {
		for await (const chunk of transcriptByteChunks(filePath, storage)) hasher.update(chunk);
	}
	return hasher.digest("hex");
}

async function loadWithKnownSize(
	filePath: string,
	storage: SessionStorage,
	size: number,
	options?: LoadSessionOptions,
): Promise<{ loaded: SessionLoadResult; sourceSize: number }> {
	if (shouldStreamEntries(storage, filePath, size)) {
		// A full rewrite or delete raced the stream (another process, or this one's queued writes, which
		// reads do not wait for): stream it again from its start, never as one whole-text read.
		const loaded = await retryRacedRead(() => loadEntriesFromFileStream(filePath, { ...options, storage }));
		const sourceSize = loaded.sourceSize ?? 0;
		return { loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded, sourceSize };
	}
	const content = await storage.readText(filePath);
	const loaded = parseSessionContent(content);
	if (options?.digest)
		loaded.sourceDigest = new Bun.CryptoHasher(SNAPSHOT_DIGEST_ALGORITHM).update(content).digest("hex");
	return {
		loaded: loaded.invalidHeader ? { ...loaded, entries: [] } : loaded,
		sourceSize: Buffer.byteLength(content, "utf8"),
	};
}

/**
 * Windows reports ENOENT when a path component is a regular file, where POSIX
 * yields ENOTDIR. Inspecting the leaf itself and then climbing to the first
 * existing ancestor distinguishes that path error from a genuinely missing
 * file.
 */
export async function hasFileAsPathComponent(filePath: string): Promise<boolean> {
	let current = path.resolve(filePath);
	for (;;) {
		try {
			return !(await fs.stat(current)).isDirectory();
		} catch {
			// Missing component: climb to the first existing ancestor.
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Load and validate a session while retaining malformed-record diagnostics.
 * The entries are the file's lines, raw: its `tool_result_prune` and
 * `entry_patch` records are among them, unapplied. A caller that shows or
 * derives from the entries migrates them, then calls `applyToolResultPrunes`
 * and `applyEntryPatches`, as `loadSessionMessagesReadOnly` does.
 */
export async function loadSessionFile(
	filePath: string,
	storage: SessionStorage = defaultSessionStorage(),
	options: LoadSessionOptions = {},
): Promise<SessionLoadResult> {
	try {
		const statSize = storage.statSync(filePath).size;
		const { loaded, sourceSize } = await loadWithKnownSize(filePath, storage, statSize, options);
		return { ...loaded, sourceSize };
	} catch (caught) {
		const err = await restorePathComponentError(caught, filePath, storage);
		if (options?.throwIfMissing && (isEnoent(err) || isEnotdir(err))) {
			throw err;
		}
		if (isEnoent(err)) {
			return {
				entries: [],
				titleSlot: undefined,
				malformedRecords: 0,
				sourceSize: null,
				invalidHeader: false,
			};
		}
		throw err;
	}
}

/**
 * Windows reports ENOENT where POSIX reports ENOTDIR for a path running
 * through a regular file; restore ENOTDIR so that path error is never masked
 * as a missing session.
 */
async function restorePathComponentError(caught: unknown, filePath: string, storage: SessionStorage): Promise<unknown> {
	return isEnoent(caught) &&
		process.platform === "win32" &&
		storage instanceof FileSessionStorage &&
		(await hasFileAsPathComponent(filePath))
		? enotdir(filePath)
		: caught;
}

/** What {@link visitSessionFile} read besides the entries it visited. */
export interface SessionFileVisit {
	titleSlot: SessionTitleUpdate | undefined;
	malformedRecords: number;
	/** Bytes read, or `null` when the path did not exist. */
	sourceSize: number | null;
	/** Non-empty session data without a valid leading session header: nothing was visited. */
	invalidHeader: boolean;
}

/**
 * The visit of a session whose path could not be read, following
 * {@link loadSessionFile}: none for a missing path, unless `throwIfMissing`
 * asks for its error; any other error is thrown.
 */
async function missingSessionVisit(
	caught: unknown,
	filePath: string,
	storage: SessionStorage,
	options: LoadSessionOptions,
): Promise<SessionFileVisit> {
	const err = await restorePathComponentError(caught, filePath, storage);
	if (options.throwIfMissing && (isEnoent(err) || isEnotdir(err))) throw err;
	if (isEnoent(err)) return { titleSlot: undefined, malformedRecords: 0, sourceSize: null, invalidHeader: false };
	throw err;
}

/** Visit the entries of a session read whole, as {@link visitSessionFile} visits a streamed one. */
export function visitLoadedSession(
	loaded: SessionLoadResult,
	visit: (entry: FileEntry) => void | boolean,
): SessionFileVisit {
	for (const entry of loaded.invalidHeader ? [] : loaded.entries) {
		if (visit(entry) === false) break;
	}
	return {
		titleSlot: loaded.titleSlot,
		malformedRecords: loaded.malformedRecords,
		sourceSize: loaded.sourceSize ?? null,
		invalidHeader: loaded.invalidHeader,
	};
}

/**
 * Visit a session's entries in file order, the header first, from any
 * storage. A transcript of 8 MiB or more streams from file storage or a
 * storage with `readChunks`, so it is never held whole; a smaller one is read
 * whole, as {@link loadSessionFile} reads it. Missing files and headers follow
 * {@link loadSessionFile}: a missing path visits nothing (or throws with
 * `throwIfMissing`), and a file whose first record is not a valid header
 * visits nothing. `visit` returning `false` stops the visit.
 */
export async function visitSessionFile(
	filePath: string,
	storage: SessionStorage,
	visit: (entry: FileEntry) => void | boolean,
	options: LoadSessionOptions = {},
): Promise<SessionFileVisit> {
	let size: number;
	try {
		size = storage.statSync(filePath).size;
	} catch (caught) {
		return missingSessionVisit(caught, filePath, storage, options);
	}
	if (!shouldStreamEntries(storage, filePath, size))
		return visitLoadedSession(await loadSessionFile(filePath, storage, options), visit);

	let malformedRecords = 0;
	let sourceSize = 0;
	let sawEntry = false;
	let invalidHeader = false;
	let visitorError: { error: unknown } | undefined;
	try {
		const titleSlot = await visitEntriesFromFileStream(
			filePath,
			entry => {
				if (!sawEntry) {
					sawEntry = true;
					if (!isValidSessionHeader(entry)) {
						invalidHeader = true;
						return false;
					}
				}
				try {
					return visit(entry);
				} catch (error) {
					visitorError = { error };
					throw error;
				}
			},
			{
				storage,
				throwIfMissing: true,
				onMalformedRecord: () => {
					malformedRecords++;
				},
				onChunk: chunk => {
					sourceSize += chunk.byteLength;
				},
			},
		);
		return {
			titleSlot,
			malformedRecords,
			sourceSize,
			invalidHeader: invalidHeader || (!sawEntry && malformedRecords > 0),
		};
	} catch (caught) {
		if (visitorError) throw visitorError.error;
		return missingSessionVisit(caught, filePath, storage, options);
	}
}

/**
 * The header of the session at `filePath`, read the cheapest way: a
 * transcript {@link visitSessionFile} would read whole is loaded and returned
 * too, so a caller need not read it twice; a streamed one yields its header
 * alone, read again from its start when a full rewrite or delete raced it
 * (`SessionReadConflictError`). Missing files follow {@link loadSessionFile}.
 */
export async function probeSessionFile(
	filePath: string,
	storage: SessionStorage,
	options: LoadSessionOptions = {},
): Promise<{ header: SessionHeader | undefined; loaded: SessionLoadResult | undefined }> {
	let streamed = false;
	try {
		streamed = shouldStreamEntries(storage, filePath, storage.statSync(filePath).size);
	} catch {
		// A missing or unreadable path: the read below applies loadSessionFile's rules.
	}
	if (!streamed) {
		const loaded = await loadSessionFile(filePath, storage, options);
		const first = loaded.entries[0];
		return { header: isValidSessionHeader(first) ? first : undefined, loaded };
	}
	// A full rewrite or delete can race the stream between its chunks.
	return retryRacedRead(async () => {
		const probe: { header?: SessionHeader } = {};
		await visitSessionFile(
			filePath,
			storage,
			entry => {
				probe.header = entry as SessionHeader;
				return false;
			},
			options,
		);
		return { header: probe.header, loaded: undefined };
	});
}

/**
 * Load the valid entries from a session file, skipping malformed records.
 * Each call returns freshly parsed entries owned by the caller, raw as
 * {@link loadSessionFile} returns them: records unapplied.
 */
export async function loadEntriesFromFile(
	filePath: string,
	storage: SessionStorage = defaultSessionStorage(),
	options?: { throwIfMissing?: boolean },
): Promise<FileEntry[]> {
	return (await loadSessionFile(filePath, storage, options)).entries;
}

/**
 * Visit session entries, streaming large journals from any storage that has
 * `readChunks`: a {@link visitSessionFile} whose missing path throws.
 */
export async function visitEntriesFromFile(
	filePath: string,
	visit: (entry: FileEntry) => void | boolean,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<void> {
	await visitSessionFile(filePath, storage, visit, { throwIfMissing: true });
}

/** A persisted blob reference and the place that holds it. */
interface BlobRefSite {
	/** The object whose field `key` holds the reference, or the array whose element `key` holds it. */
	holder: Record<string, unknown> | unknown[];
	key: string | number;
	ref: string;
	/** Provider image URLs persist the whole data URL; image payloads persist bare base64. */
	asDataUrl: boolean;
}

/**
 * Collect the blob references in `value` and below it, wherever persistence
 * externalizes an image and a load resolves it ({@link resolvedImageSiteOf}),
 * in the order a depth-first walk meets them. An array's elements, a string
 * one too, sit under the array's key. Snapcompact frames stay as references
 * until context rebuilding selects them. The walk keeps its own stack
 * ({@link runNested}), so it reads a value as deep as `JSON.parse` reads
 * (about ten times what a recursive walk's stack allows): the record of a
 * cold entry is one. A container met again inside itself (a cycle, never in
 * parsed JSON) is not walked again.
 */
function collectBlobRefSites(value: unknown, sites: BlobRefSite[]): void {
	if (typeof value === "object" && value !== null) runNested(blobRefSitesIn(value, undefined, sites, new Set()));
}

/** {@link collectBlobRefSites} of `node`, under `key` of its holder, skipping a container in `open`, which it is inside. */
function* blobRefSitesIn(
	node: object,
	key: string | undefined,
	sites: BlobRefSite[],
	open: Set<object>,
): NestedWalk<void> {
	if (open.has(node)) return;
	if (Array.isArray(node)) {
		open.add(node);
		for (let index = 0; index < node.length; index++) {
			const item: unknown = node[index];
			if (typeof item === "object" && item !== null) yield blobRefSitesIn(item, key, sites, open);
			else if (typeof item === "string" && resolvedImageSiteOf(item, key) !== undefined && isBlobRef(item)) {
				// A provider image's URL listed under `image_url`: its blob holds the whole data URL.
				sites.push({ holder: node, key: index, ref: item, asDataUrl: true });
			}
		}
		open.delete(node);
		return;
	}
	const holder = node as Record<string, unknown>;
	const site = resolvedImageSiteOf(holder, key);
	const ref = site === undefined ? undefined : imageAt(holder, site);
	if (site !== undefined && typeof ref === "string" && isBlobRef(ref)) {
		sites.push({ holder, key: site, ref, asDataUrl: false });
		// An image payload's other fields hold no image.
		if (site === "data") return;
	}
	open.add(holder);
	for (const childKey in holder) {
		const child = holder[childKey];
		if (typeof child === "object" && child !== null) yield blobRefSitesIn(child, childKey, sites, open);
		else if (typeof child === "string" && resolvedImageSiteOf(child, childKey) !== undefined && isBlobRef(child)) {
			// A provider image's URL: its blob holds the whole data URL.
			sites.push({ holder, key: childKey, ref: child, asDataUrl: true });
		}
	}
	open.delete(holder);
}

/**
 * Cheap synchronous precheck: does this value's tree contain any `blob:sha256:` string?
 * Early-exits on the first hit, so blob-free entries skip the
 * {@link collectBlobRefSites} descent entirely. Conservative — a blob ref in a
 * non-resolved position still returns true, which only costs an extra (no-op) walk.
 * Like that walk it keeps its own stack, so it checks a value of any depth
 * `JSON.parse` reads; it reads each container once, so a cycle ends.
 */
function containsBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value);
	if (typeof value !== "object" || value === null) return false;
	const seen = new Set<object>();
	const pending: object[] = [value];
	// Whether `member` is a blob reference; a container is left to walk.
	const isRef = (member: unknown): boolean => {
		if (typeof member === "string") return isBlobRef(member);
		if (typeof member === "object" && member !== null) pending.push(member);
		return false;
	};
	while (pending.length > 0) {
		const container = pending.pop()!;
		if (seen.has(container)) continue;
		seen.add(container);
		if (Array.isArray(container)) {
			for (const member of container) if (isRef(member)) return true;
		} else {
			for (const key in container) if (isRef(Reflect.get(container, key))) return true;
		}
	}
	return false;
}

/**
 * Older persistence versions truncated oversized frame base64 in place. Recover
 * those archives from their retained source text so an already-wedged session
 * resumes as text instead of sending malformed image data to the provider.
 */
export function repairTruncatedSnapcompactFrames(entry: FileEntry): void {
	if (entry.type !== "compaction") return;
	const archive = snapcompact.getPreservedArchive(entry.preserveData);
	if (!archive?.frames.some(frame => isPersistenceTruncatedString(frame.data))) return;
	const slot = entry.preserveData?.[snapcompact.PRESERVE_KEY];
	if (typeof slot !== "object" || slot === null) return;

	if (archive.text) {
		Object.assign(slot, { frames: [], textHead: archive.text, textTail: "" });
		return;
	}
	Object.assign(slot, {
		frames: archive.frames.filter(frame => !isPersistenceTruncatedString(frame.data)),
	});
}

function blobRefSites(values: readonly unknown[]): BlobRefSite[] {
	const sites: BlobRefSite[] = [];
	for (const value of values) {
		if (containsBlobRef(value)) collectBlobRefSites(value, sites);
	}
	return sites;
}

function blobSiteKey(site: BlobRefSite): string {
	return `${site.asDataUrl ? "url" : "base64"}:${site.ref}`;
}

/** Add to `into` the hash of each blob `values` reference where a resolve finds one, with its holder's MIME type. */
function addBlobRefNames(values: readonly unknown[], into: Map<string, string | undefined>): void {
	for (const site of blobRefSites(values)) {
		const hash = parseBlobRef(site.ref);
		if (!hash || into.has(hash)) continue;
		const mimeType = Array.isArray(site.holder) ? undefined : site.holder.mimeType;
		into.set(hash, typeof mimeType === "string" ? mimeType : undefined);
	}
}

/**
 * Add to `into` the blobs `entry` names, as {@link resolveBlobRefsInEntries}
 * finds them, for a caller that lets go of the entry before that runs.
 */
export function collectBlobRefNames(entry: FileEntry, into: Map<string, string | undefined>): void {
	if (entry.type !== "session") addBlobRefNames([entry], into);
}

async function resolveBlobRefs(values: readonly unknown[], blobStore: BlobStore): Promise<void> {
	const semaphore = new Semaphore(BLOB_READ_CONCURRENCY);
	const resolved = new Map<string, Promise<string>>();
	await Promise.all(
		blobRefSites(values).map(async site => {
			const key = blobSiteKey(site);
			let data = resolved.get(key);
			if (!data) {
				data = (async () => {
					await semaphore.acquire();
					try {
						return await (site.asDataUrl
							? resolveImageDataUrl(blobStore, site.ref)
							: resolveImageData(blobStore, site.ref));
					} finally {
						semaphore.release();
					}
				})();
				resolved.set(key, data);
			}
			Reflect.set(site.holder, site.key, await data);
		}),
	);
}

/** The non-header entries, with legacy truncated snapcompact frames repaired before their blobs resolve. */
function entriesForBlobResolution(entries: FileEntry[]): SessionEntry[] {
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	for (const entry of sessionEntries) repairTruncatedSnapcompactFrames(entry);
	return sessionEntries;
}

/**
 * The newest compaction on the active branch, when it holds a snapcompact
 * archive: the one a rebuilt context draws frames from, its legacy truncated
 * frames repaired. Finding it reads only the entries' tree fields (`type`,
 * `id`, `parentId`, `activeLeafId`), which a cold entry keeps as data.
 */
function activeSnapcompactCompaction(
	entries: readonly FileEntry[],
): { entry: CompactionEntry; archive: snapcompact.Archive } | undefined {
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const compaction = activeBranch(sessionEntries).findLast(
		(entry): entry is CompactionEntry => entry.type === "compaction",
	);
	if (!compaction) return undefined;
	repairTruncatedSnapcompactFrames(compaction);
	const archive = snapcompact.getPreservedArchive(compaction.preserveData);
	return archive ? { entry: compaction, archive } : undefined;
}

/**
 * Draw again, from the archive's kept source text, each frame whose blob this
 * machine lacks, and store each one whose bytes hash to its reference. A
 * frame that does not draw so keeps its missing blob, which the rebuilt
 * context reports as unavailable.
 */
async function restoreArchiveFrames(
	archive: snapcompact.Archive,
	blobStore: BlobStore,
	entryId: string,
): Promise<void> {
	const missing: number[] = [];
	for (const [index, frame] of archive.frames.entries()) {
		const hash = parseBlobRef(frame.data);
		if (hash && !(await blobStore.has(hash))) missing.push(index);
	}
	if (missing.length === 0) return;
	const redrawn = await snapcompact.redrawFrames(
		archive,
		missing,
		(index, data) =>
			new Bun.SHA256().update(Buffer.from(data, "base64")).digest("hex") ===
			parseBlobRef(archive.frames[index]?.data ?? ""),
	);
	for (const index of missing) {
		const frame = archive.frames[index];
		const data = redrawn.get(index);
		if (frame && data !== undefined) {
			await externalizeImageData(blobStore, data, frame.mimeType);
			continue;
		}
		logger.warn("Snapcompact frame blob is missing, and the archive text does not draw it again", {
			entryId,
			frame: index + 1,
			frames: archive.frames.length,
			ref: frame?.data,
		});
	}
}

/**
 * Restore the frames of the active snapcompact archive whose blobs this
 * machine lacks: a session resumed on another machine brings its frame
 * references but not the blob store that held them.
 */
async function restoreSnapcompactFrames(entries: readonly FileEntry[], blobStore: BlobStore): Promise<void> {
	const active = activeSnapcompactCompaction(entries);
	if (!active) return;
	for (const archive of [active.archive, active.archive.withoutThinking?.archive]) {
		if (!archive) continue;
		try {
			await restoreArchiveFrames(archive, blobStore, active.entry.id);
		} catch (error) {
			logger.warn("Restoring missing snapcompact frames failed", {
				entryId: active.entry.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Write to the local blob store each blob the references in `values` name
 * that it lacks and the store's tier holds (the SQL session storage's blob
 * table): a session resumed on another machine brings its references but not
 * the blob store that held them. A row whose bytes do not hash to its key is
 * left out and warned about. With `writeBack`, each blob this machine holds
 * and the tier lacks (one written before the tier, or whose write never
 * landed) is queued for the tier, so it lands before the session's next
 * transcript write, and each row whose bytes do not hash to its key is
 * rewritten from this machine's bytes; the tier stores no bytes that do not
 * hash to their key, whichever of the two hands them over. With
 * `sessionPath` too, the session at that path then gets its reference rows
 * for every blob it names that the tier holds, so another session's delete
 * keeps them (a session written before the tier has none). Snapcompact frames
 * are not in the tier; they are drawn again from their archive's text. Each
 * of `collected`'s blobs counts as one the references in `values` name.
 * Answers whether it wrote a blob to the local store.
 */
async function restoreTierBlobs(
	values: readonly unknown[],
	blobStore: BlobStore,
	writeBack: boolean,
	sessionPath?: string,
	collected?: ReadonlyMap<string, string | undefined>,
): Promise<boolean> {
	const tier = blobStore.tier;
	if (!tier) return false;
	const mimeTypes = new Map(collected);
	addBlobRefNames(values, mimeTypes);
	if (mimeTypes.size === 0) return false;
	const named: string[] = [];
	let restored = false;
	try {
		const held = await tier.sizes([...mimeTypes.keys()]);
		const missing: string[] = [];
		const heldHere: string[] = [];
		let writtenBack = 0;
		for (const [hash, mimeType] of mimeTypes) {
			if (held.has(hash)) {
				named.push(hash);
				if (await blobStore.has(hash)) heldHere.push(hash);
				else missing.push(hash);
				continue;
			}
			if (!writeBack) continue;
			const data = await blobStore.get(hash);
			if (!data) continue;
			tier.store(hash, data, mimeType);
			named.push(hash);
			writtenBack++;
		}
		if (writtenBack > 0) {
			logger.info("Writing local session blobs the session database lacks back to it", { blobs: writtenBack });
		}
		// A row whose bytes do not hash to its key is rewritten from this machine's bytes, when they hash to it.
		if (writeBack && heldHere.length > 0) await tier.repair(heldHere, hash => blobStore.get(hash));
		await tier.read(missing, async (hash, data) => {
			if (new Bun.SHA256().update(data).digest("hex") !== hash) {
				logger.warn("A session blob in the session database does not hash to its key; left missing", { hash });
				return;
			}
			await blobStore.put(data, { hash, extension: blobExtensionForImageMimeType(mimeTypes.get(hash)) });
			restored = true;
			logger.info("Restored a session blob from the session database", { hash, bytes: data.byteLength });
		});
	} catch (error) {
		logger.warn("Reading missing session blobs from the session database failed", {
			blobs: mimeTypes.size,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	if (!writeBack || !sessionPath || named.length === 0) return restored;
	try {
		await tier.reference(sessionPath, named);
	} catch (error) {
		logger.warn("Writing a session's blob references to the session database failed", {
			sessionPath,
			blobs: named.length,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return restored;
}

/**
 * Restore in place the image data that persistence externalized to the blob
 * store: first each blob the local store lacks from the store's tier (and
 * each one the tier lacks back to it, referenced from `sessionPath` when it is
 * given), then the references. Then draw again, from its text, each frame of
 * the active snapcompact archive whose blob the local store lacks, and store
 * there each one whose bytes hash to its reference; the frames stay
 * references, which a context build reads when it selects them.
 *
 * `collected` adds blobs, by hash with their MIME types, that entries the caller
 * no longer holds whole name (a streamed load's entries moved out of memory),
 * found with {@link collectBlobRefNames} while it held them: the tier pass
 * (restore, write-back and references) covers them too.
 *
 * `transcript`, every entry of the session with `entries` among them (a
 * streamed load's cold entries too), is where the active snapcompact archive
 * is found; only `entries` are walked for references.
 */
export async function resolveBlobRefsInEntries(
	entries: FileEntry[],
	blobStore: BlobStore,
	sessionPath?: string,
	options?: {
		collected?: ReadonlyMap<string, string | undefined>;
		transcript?: readonly FileEntry[];
	},
): Promise<void> {
	const sessionEntries = entriesForBlobResolution(entries);
	await restoreTierBlobs(sessionEntries, blobStore, true, sessionPath, options?.collected);
	await resolveBlobRefs(sessionEntries, blobStore);
	await restoreSnapcompactFrames(options?.transcript ?? sessionEntries, blobStore);
}

/**
 * Synchronous {@link resolveBlobRefsInEntries}: it resolves the references
 * whose blobs the local store holds and leaves the others. When it leaves one
 * and the store has a tier, an asynchronous pass then restores from the tier
 * the blobs it holds, resolves in place the references they answer, and draws
 * again the active snapcompact archive's missing frames, storing their blobs;
 * the frames stay references, which a context build reads. With `onRestored`
 * (a caller that freezes `entries`), the pass writes nothing into `entries`:
 * it calls `onRestored` once it has restored a blob to the local store, where
 * the caller's next parse of the entries finds it.
 */
export function resolveBlobRefsInEntriesSync(
	entries: FileEntry[],
	blobStore: BlobStore,
	onRestored?: () => void,
): void {
	const sessionEntries = entriesForBlobResolution(entries);
	const resolved = new Map<string, string>();
	let unresolved = false;
	for (const site of blobRefSites(sessionEntries)) {
		const key = blobSiteKey(site);
		let data = resolved.get(key);
		if (data === undefined) {
			data = site.asDataUrl
				? resolveImageDataUrlSync(blobStore, site.ref)
				: resolveImageDataSync(blobStore, site.ref);
			resolved.set(key, data);
		}
		Reflect.set(site.holder, site.key, data);
		if (containsBlobRef(data)) unresolved = true;
	}
	if (!unresolved || !blobStore.tier) return;
	void restoreTierBlobs(sessionEntries, blobStore, false)
		.then(restored => {
			if (!onRestored) return resolveBlobRefs(sessionEntries, blobStore);
			if (restored) onRestored();
		})
		.then(() => restoreSnapcompactFrames(sessionEntries, blobStore))
		.catch(error => {
			logger.warn("Restoring the missing blobs of adopted session entries failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

/**
 * Read-only transcript view of a session file: load entries, migrate to the
 * current version, apply prune and entry patch records, resolve blob refs,
 * and build the display transcript along the persisted leaf path (last
 * entry). Uses transcript mode (collapsed to the latest compaction) so
 * failed/aborted tail turns stay visible, unlike the provider-context builder
 * which drops them. Does NOT create a writer or take the session lock — safe
 * to call against a file another session is writing.
 * Reads through `storage`, the storage holding the transcript.
 */
export async function loadSessionMessagesReadOnly(
	filePath: string,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<AgentMessage[]> {
	const entries = await loadEntriesFromFile(filePath, storage);
	if (entries.length === 0) return [];
	migrateToCurrentVersion(entries);
	applyToolResultPrunes(entries);
	applyEntryPatches(entries);
	for (const entry of entries) repairTruncatedSnapcompactFrames(entry);
	const blobs = new BlobStore(getBlobsDir(), storage.blobTier);
	const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
	// Frames resolve lazily below, so the ones this machine lacks are drawn first.
	await restoreSnapcompactFrames(sessionEntries, blobs);
	const { messages } = buildSessionContext(sessionEntries, undefined, undefined, {
		transcript: true,
		collapseCompactedHistory: true,
		resolveFrameData: data => lazyImageDataSync(blobs, data),
	});
	// A collapsed summary carries the remote-compaction replacement history for
	// provider replay only; this transcript is never replayed, and the renderer
	// reads just the summary. Dropping it keeps hydration off every image blob
	// buried in that hidden history.
	const displayMessages = messages.map(message =>
		message.role === "compactionSummary" && message.providerPayload !== undefined
			? { ...message, providerPayload: undefined }
			: message,
	);
	// Read only: a blob the tier lacks is not written back from here.
	await restoreTierBlobs(displayMessages, blobs, false);
	await resolveBlobRefs(displayMessages, blobs);
	return displayMessages;
}
