import { isAnthropicServerToolHistoryBlock } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { isImageBlock } from "@oh-my-pi/pi-ai/types";
import {
	ContainerPath,
	countNewlines,
	DEEP_JSON_LEVELS,
	isRecord,
	type NestedWalk,
	nestsDeeperThan,
	runNested,
	stringifyDeepJson,
	stringifyJsonIteratively,
} from "@oh-my-pi/pi-utils";
import { PRESERVE_KEY as SNAPCOMPACT_PRESERVE_KEY } from "@oh-my-pi/snapcompact";
import {
	type BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	isBlobRef,
	isImageDataUrl,
} from "./blob-store";
import type { FileEntry } from "./session-entries";

const MAX_PERSIST_CHARS = 500_000;
const TRUNCATION_NOTICE = "\n\n[Session persistence truncated large content]";
/** Minimum base64 length to externalize to blob store (skip tiny inline images) */
const BLOB_EXTERNALIZE_THRESHOLD = 1024;
const TEXT_CONTENT_KEY = "content";
/** Parent key under which snapcompact persists its base64 PNG frame archive
 *  (`preserveData.snapcompact.frames[]`). Frame objects are image payloads, so
 *  their base64 must externalize to the blob store rather than fall through to
 *  generic string truncation, which appends {@link TRUNCATION_NOTICE} and
 *  corrupts the base64 the provider decodes on resume. */
const SNAPCOMPACT_FRAMES_KEY = "frames";
/** Key of a provider image's URL (OpenAI `input_image`, computer-use screenshot); a data URL there is one blob. */
const IMAGE_URL_KEY = "image_url";

function truncateString(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	let truncated = value.slice(0, maxLength);
	if (truncated.length > 0) {
		const last = truncated.charCodeAt(truncated.length - 1);
		if (last >= 0xd800 && last <= 0xdbff) {
			truncated = truncated.slice(0, -1);
		}
	}
	return truncated;
}

/** Detect strings damaged by an older persistence pass so loaders can migrate them safely. */
export function isPersistenceTruncatedString(value: unknown): value is string {
	return typeof value === "string" && value.endsWith(TRUNCATION_NOTICE);
}

function isImageMimeType(value: unknown): value is string {
	return typeof value === "string" && value.toLowerCase().startsWith("image/");
}

export function isImageDataPayload(value: unknown): value is { data: string; mimeType?: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof (value as { data?: string }).data === "string" &&
		(isImageBlock(value) || ("mimeType" in value && isImageMimeType((value as { mimeType?: unknown }).mimeType)))
	);
}

/**
 * True when an image payload sits in a persistence position whose base64 is
 * externalized to the blob store instead of truncated as a generic string: a
 * `content` image block, an `images[]` entry, or a snapcompact frame under
 * `frames[]`.
 */
function isExternalizableImagePosition(
	value: unknown,
	key: string | undefined,
): value is { data: string; mimeType?: string } {
	if (!isImageDataPayload(value)) return false;
	return (key === TEXT_CONTENT_KEY && isImageBlock(value)) || key === "images" || key === SNAPCOMPACT_FRAMES_KEY;
}

/**
 * Where a node of a session entry holds an image ({@link imageSiteOf}): `data`
 * or `result`, the field of an object node that holds the image's base64; or
 * `image_url`, a string node that is itself the image's URL, of which a data
 * URL is stored whole.
 */
export type ImageSite = "data" | "result" | typeof IMAGE_URL_KEY;

/**
 * Where `value`, a node under `key` of its holder (an array element under its
 * array's key, at any depth), holds an image: the `data` of an image payload at
 * an image position ({@link isExternalizableImagePosition}), the `result` of a
 * generated image (`type: "image_generation_call"`), or `value` itself, a
 * string under `image_url`. The one rule by which persistence writes an image
 * to the blob store and its blob reference in its place, a load resolves that
 * reference ({@link resolvedImageSiteOf}), and store masking keeps it.
 */
function imageSiteOf(value: unknown, key: string | undefined): ImageSite | undefined {
	if (typeof value === "string") return key === IMAGE_URL_KEY ? IMAGE_URL_KEY : undefined;
	if (typeof value !== "object" || value === null) return undefined;
	if (isExternalizableImagePosition(value, key)) return "data";
	const generated =
		"type" in value &&
		value.type === "image_generation_call" &&
		"result" in value &&
		typeof value.result === "string";
	return generated ? "result" : undefined;
}

/**
 * The {@link imageSiteOf} site of `value` whose blob reference a load resolves:
 * every site but a snapcompact frame's, which stays a reference until context
 * rebuilding draws the frame (`lazyImageDataSync`).
 */
export function resolvedImageSiteOf(value: unknown, key: string | undefined): ImageSite | undefined {
	const site = imageSiteOf(value, key);
	return site === "data" && key === SNAPCOMPACT_FRAMES_KEY ? undefined : site;
}

/**
 * The image `value` holds at `site`, its {@link imageSiteOf} site: `value`
 * itself, a string under `image_url`, or else its field `site`.
 */
export function imageAt(value: unknown, site: ImageSite): unknown {
	return typeof value === "string" ? value : (value as Record<string, unknown>)[site];
}

/**
 * The {@link imageSiteOf} site of `value` whose image a persisted line
 * externalizes: a data URL, or base64 that is no blob reference yet and at
 * least {@link BLOB_EXTERNALIZE_THRESHOLD} long (a smaller image stays inline).
 */
function externalizedImageSite(value: unknown, key: string | undefined): ImageSite | undefined {
	const site = imageSiteOf(value, key);
	if (site === undefined) return undefined;
	const image = imageAt(value, site);
	if (typeof image !== "string") return undefined;
	if (site === IMAGE_URL_KEY) return isImageDataUrl(image) ? site : undefined;
	return isBlobRef(image) || image.length < BLOB_EXTERNALIZE_THRESHOLD ? undefined : site;
}

/**
 * The node a persisted line holds for `value` when it externalizes the image
 * `value` holds ({@link externalizedImageSite}), with the image replaced by its
 * blob reference; undefined for any other value.
 */
function externalizeImageNode(value: unknown, blobStore: BlobStore, key: string | undefined): unknown {
	const site = externalizedImageSite(value, key);
	if (site === undefined) return undefined;
	if (typeof value === "string") return externalizeImageDataUrlSync(blobStore, value, { mirror: true });
	if (site === "result") {
		const generated = value as { result: string };
		return {
			...generated,
			result: externalizeImagePayloadSync(blobStore, generated, generated.result, undefined, true),
		};
	}
	const payload = value as { data: string; mimeType?: string };
	// A snapcompact frame never goes to the tier: its archive's text draws it again.
	const mirror = key !== SNAPCOMPACT_FRAMES_KEY;
	return { ...payload, data: externalizeImagePayloadSync(blobStore, payload, payload.data, payload.mimeType, mirror) };
}

/** True for a non-empty string — marks signature/encrypted fields whose block must persist verbatim. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

interface ExternalizedImage {
	readonly data: string;
	readonly mimeType: string | undefined;
	readonly ref: string;
}

/**
 * Blob refs already minted for live image payload objects, per blob store.
 * The persisted copy of an entry is structurally shared while the in-memory
 * entry keeps its base64, so without this every full rewrite would decode,
 * hash, and stat every image in the session again. A hit requires the
 * payload's current data and mime type, so a payload mutated in place is
 * externalized afresh; keying by store keeps a ref minted into one blob dir
 * from being reused for another.
 */
const externalizedImageRefs = new WeakMap<BlobStore, WeakMap<object, ExternalizedImage>>();

/**
 * Externalize one image payload, once per live payload object. `mirror`
 * also hands it to the blob store's tier, which keeps it until it lands, so
 * this once-per-object cache never drops a write; a snapcompact frame never
 * goes there, since its archive's text draws it again.
 */
function externalizeImagePayloadSync(
	blobStore: BlobStore,
	payload: object,
	data: string,
	mimeType: string | undefined,
	mirror: boolean,
): string {
	let refs = externalizedImageRefs.get(blobStore);
	const cached = refs?.get(payload);
	if (cached && cached.data === data && cached.mimeType === mimeType) return cached.ref;
	const ref = externalizeImageDataSync(blobStore, data, mimeType, { mirror });
	if (!refs) {
		refs = new WeakMap();
		externalizedImageRefs.set(blobStore, refs);
	}
	refs.set(payload, { data, mimeType, ref });
	return ref;
}

/**
 * Drop every image ref remembered for `blobStore`, so the next persist checks
 * each blob on disk again. Call when a session write failed: a ref whose line
 * never reached a session file is unreferenced, so `omp gc` may collect its blob.
 */
export function forgetExternalizedImages(blobStore: BlobStore): void {
	externalizedImageRefs.delete(blobStore);
}

/** True for the snapcompact archive slot, `preserveData[PRESERVE_KEY]`. */
function isSnapcompactArchiveSlot(
	key: string | undefined,
	childKey: string,
	value: unknown,
): value is Record<string, unknown> {
	return key === "preserveData" && childKey === SNAPCOMPACT_PRESERVE_KEY && isRecord(value);
}

/**
 * One walk of a value for persistence, a rebuild ({@link truncateNode}) or an
 * image externalization ({@link externalizedImagesNode}): its blob store, the
 * containers it is inside (a cycle fails), and the deepest level it reached,
 * which says whether the value nests past {@link DEEP_JSON_LEVELS}.
 */
interface PersistenceWalk {
	readonly blobStore: BlobStore;
	readonly path: ContainerPath;
	deepest: number;
}

/** A rebuild's walk ({@link truncateNode}), which also counts the changes to the value a persisted line makes. */
interface RebuildWalk extends PersistenceWalk {
	changes: number;
}

/** What a rebuild learned of a value's shape: whether it nests past {@link DEEP_JSON_LEVELS}. */
interface PersistedShape {
	deep: boolean;
}

/**
 * What {@link persistenceScan} found of a value: nothing a persisted line
 * changes (`clean`), something it changes (`dirty`), or a level past
 * {@link PERSISTENCE_SCAN_DEPTH} that it did not scan (`deep`).
 */
type PersistenceScan = "clean" | "dirty" | "deep";

/**
 * Levels {@link persistenceScan} scans before it answers `deep` instead: far
 * deeper than an entry a session writes, far shallower than the call stack
 * allows, a worker thread's included.
 */
const PERSISTENCE_SCAN_DEPTH = 1_000;

/**
 * What one {@link persistenceScan} read, in the order it read it, up to the
 * field it did not find clean, or of the whole value when it found it clean.
 * `values` holds each field it read: an object's as its key and then its
 * value, an array's element as its value. `counts` holds, for each object or
 * array it went into, in the order it went in, how many of its fields it read
 * (none of a node it keeps verbatim, rewrites whole or does not scan); a
 * node's count comes before its fields' own counts. Its arrays are reused, so
 * a scan allocates nothing once they have grown: `size` and `nodes` say how
 * much of them this scan wrote, and the slots of `values` past `size` hold
 * `undefined`.
 */
interface ScanTrail {
	readonly values: unknown[];
	size: number;
	readonly counts: number[];
	nodes: number;
}

/**
 * The trails no scan holds now. Each scan takes one ({@link truncateForPersistence})
 * for itself and the rebuild that takes what it read, so a scan a getter
 * starts during another scan or its rebuild (the getter persists another
 * session's entry) takes a trail of its own.
 */
const freeScanTrails: ScanTrail[] = [];

/** The slots of `values` past which a trail is not kept for a later scan: the scan of a larger entry grows its own. */
const POOLED_SCAN_TRAIL_SLOTS = 1 << 16;

/**
 * Give `trail` back once its scan and rebuild ended, however they ended (a
 * getter's throw included): emptied, so it keeps none of the values the scan
 * read, and kept for a later scan unless it grew past {@link POOLED_SCAN_TRAIL_SLOTS}.
 */
function releaseScanTrail(trail: ScanTrail): void {
	if (trail.values.length > POOLED_SCAN_TRAIL_SLOTS) return;
	trail.values.fill(undefined, 0, trail.size);
	trail.size = 0;
	trail.nodes = 0;
	freeScanTrails.push(trail);
}

/**
 * A rebuild's place in the trail of the scan that found its value not clean:
 * it takes each field the scan read from there instead of reading it again,
 * since a getter read again could answer otherwise than the value the scan
 * checked, and the line then writes the rebuilt copy, whose fields are plain.
 */
interface ScanReads {
	readonly values: readonly unknown[];
	readonly counts: readonly number[];
	/** The next of `values` and of `counts` the rebuild takes. */
	value: number;
	node: number;
}

/** How many of the fields of the node a rebuild starts on the scan read, `0` past where it stopped. */
function scannedFieldCount(reads: ScanReads | undefined): number {
	return reads ? (reads.counts[reads.node++] ?? 0) : 0;
}

/** A session line holds a bigint (an extension hook can put one in an entry) as its decimal string. */
const BIGINT_AS_STRING = { bigintAsString: true } as const;

function isContainer(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/**
 * The snapcompact archive under `preserveData[PRESERVE_KEY]`: its frames
 * externalize to the blob store, and every other field persists verbatim. The
 * next compaction re-renders the archive from `text`, so a cut would drop the
 * newest history uncounted and render {@link TRUNCATION_NOTICE} into the frames.
 */
function* persistSnapcompactArchive(
	archive: Record<string, unknown>,
	walk: RebuildWalk,
	depth: number,
	reads?: ScanReads,
): NestedWalk<Record<string, unknown>> {
	walk.path.enter(archive);
	// The scan read the frames (it stopped at them), or the frames, the view and its archive.
	const scanned = scannedFieldCount(reads);
	const source = scanned > 0 ? reads!.values[reads!.value++] : archive.frames;
	const frames = isContainer(source)
		? yield truncateNode(source, SNAPCOMPACT_FRAMES_KEY, walk, depth + 1, scanned > 0 ? reads : undefined)
		: persistedLeaf(source, SNAPCOMPACT_FRAMES_KEY, walk);
	let persisted: Record<string, unknown> = { ...archive, frames };
	const view = scanned > 1 ? reads!.values[reads!.value++] : archive.withoutThinking;
	const viewArchive = scanned > 1 ? reads!.values[reads!.value++] : isRecord(view) ? view.archive : undefined;
	if (isRecord(view) && isRecord(viewArchive)) {
		const next = yield persistSnapcompactArchive(viewArchive, walk, depth + 1, scanned > 1 ? reads : undefined);
		persisted = { ...persisted, withoutThinking: { ...view, archive: next } };
	}
	walk.path.leave(archive);
	return persisted;
}

/** {@link persistenceScan} of a snapcompact archive: its frames, then the archive of its view without reasoning. */
function snapcompactArchiveScan(archive: Record<string, unknown>, depth: number, trail: ScanTrail): PersistenceScan {
	const node = trail.nodes++;
	trail.counts[node] = 0;
	if (depth >= PERSISTENCE_SCAN_DEPTH) return "deep";
	const source = archive.frames;
	trail.values[trail.size++] = source;
	trail.counts[node] = 1;
	const frames = persistenceScan(source, SNAPCOMPACT_FRAMES_KEY, depth + 1, trail);
	if (frames !== "clean") return frames;
	const view = archive.withoutThinking;
	const viewArchive = isRecord(view) ? view.archive : undefined;
	trail.values[trail.size++] = view;
	trail.values[trail.size++] = viewArchive;
	trail.counts[node] = 3;
	return isRecord(viewArchive) ? snapcompactArchiveScan(viewArchive, depth + 1, trail) : "clean";
}

/**
 * Truncate large strings in an object for session persistence.
 * - Truncates oversized string fields (key-agnostic), except signed/encrypted
 *   blocks and signature keys, which persist verbatim
 * - Externalizes oversized image payloads to blob refs
 * - Updates lineCount when content is truncated
 * - Returns original object if no changes needed
 *
 * A scan that allocates nothing once its trail has grown first finds the
 * common entry clean ({@link persistenceScan}); only a value it finds dirty,
 * or deeper than it scans, is rebuilt ({@link truncateNode}), on an explicit
 * stack, so a value of any depth `JSON.parse` reads is persisted. The rebuild
 * is a copy that takes each field the scan read from what the scan read
 * ({@link ScanTrail}) and reads each other field once, scanning none, so each
 * field is read once and a value deeper than the scan costs one pass. With
 * `shape`, a rebuild past {@link DEEP_JSON_LEVELS} levels sets `shape.deep`.
 *
 * Runs in one synchronous tick so an OOM/SIGKILL landing right after a persist
 * call returns cannot lose the entry. Image externalization happens via the
 * synchronous blob-store path (`fs.writeFileSync`), so blob bytes are in the
 * kernel page cache before the JSONL line referencing them is written.
 */
function truncateForPersistence(value: unknown, blobStore: BlobStore, shape?: PersistedShape): unknown {
	if (!isContainer(value)) return truncateLeaf(value, undefined, blobStore);
	const trail = freeScanTrails.pop() ?? { values: [], size: 0, counts: [], nodes: 0 };
	try {
		let reads: ScanReads | undefined;
		if (!Array.isArray(value)) {
			if (persistenceScan(value, undefined, 0, trail) === "clean") return value;
			reads = { values: trail.values, counts: trail.counts, value: 0, node: 0 };
		}
		const walk: RebuildWalk = { blobStore, path: new ContainerPath(), deepest: 0, changes: 0 };
		const persisted = runNested(truncateNode(value, undefined, walk, 0, reads));
		if (shape && walk.deepest > DEEP_JSON_LEVELS) shape.deep = true;
		return persisted;
	} finally {
		releaseScanTrail(trail);
	}
}

/** {@link truncateNode} of `value`, no object, under `key` of its holder. */
function truncateLeaf(value: unknown, key: string | undefined, blobStore: BlobStore): unknown {
	if (typeof value !== "string") return value;
	const image = externalizeImageNode(value, blobStore, key);
	if (image !== undefined) return image;
	if (value.length <= MAX_PERSIST_CHARS) return value;
	// Defensive: signature keys normally sit on blocks the guard in truncateNode returns
	// verbatim, but if one is reached here (unknown carrier shape), preserve it —
	// truncation produces an invalid signature the API rejects, and clearing
	// drops reasoning context the provider needs on replay.
	if (key === "thinkingSignature" || key === "thoughtSignature" || key === "textSignature") {
		return value;
	}
	const limit = Math.max(0, MAX_PERSIST_CHARS - TRUNCATION_NOTICE.length);
	return `${truncateString(value, limit)}${TRUNCATION_NOTICE}`;
}

/** {@link truncateLeaf} in a rebuild, which counts a change it makes. */
function persistedLeaf(value: unknown, key: string | undefined, walk: RebuildWalk): unknown {
	const next = truncateLeaf(value, key, walk.blobStore);
	if (next !== value) walk.changes++;
	return next;
}

/**
 * True for an object `JSON.stringify` writes as its own fields, as it writes a
 * copy of them: a plain object or array. An object of a class may write itself
 * otherwise, as a `Date` does by its `toJSON`.
 */
function isPlainContainer(obj: object): boolean {
	const prototype = Object.getPrototypeOf(obj);
	return prototype === Object.prototype || prototype === Array.prototype || prototype === null;
}

/**
 * `obj`, under `key` of its holder at `depth` levels, as a persisted line
 * holds it. A plain object or array comes back a copy even when nothing in it
 * changes, so the line's `JSON.stringify` reads plain fields and calls no
 * getter of `obj` again; an object of a class nothing in which changes comes
 * back as it is, for `JSON.stringify` to write as it would. Each child that is
 * an object is a nested step ({@link runNested}). `reads`, when the scan read
 * fields of `obj`, holds them with their keys: the copy takes each the object
 * still holds as the scan read it, then reads each field the scan did not read
 * (past the one it stopped at, or one a getter added) once.
 */
function* truncateNode(
	obj: object,
	key: string | undefined,
	walk: RebuildWalk,
	depth: number,
	reads?: ScanReads,
): NestedWalk {
	const scanned = scannedFieldCount(reads);
	if (depth > walk.deepest) walk.deepest = depth;
	// A node the scan read fields of is no image and not verbatim: the scan asked first, and its answer stands, so
	// the rebuild takes every field it read (a getter the question reads could answer otherwise the second time).
	if (scanned === 0) {
		const image = externalizeImageNode(obj, walk.blobStore, key);
		if (image !== undefined) {
			walk.changes++;
			return image;
		}
		if (isAtomicPersistenceNode(obj, key)) return obj;
	}

	const changes = walk.changes;
	walk.path.enter(obj);
	if (Array.isArray(obj)) {
		const result: unknown[] = [];
		for (let i = 0; i < scanned; i++) {
			const item = reads!.values[reads!.value++];
			const next = isContainer(item)
				? yield truncateNode(item, key, walk, depth + 1, reads)
				: persistedLeaf(item, key, walk);
			// An element a getter took off the array after the scan read it is not written.
			if (i < obj.length) result.push(next);
		}
		for (let i = scanned; i < obj.length; i++) {
			const item: unknown = obj[i];
			const next = isContainer(item)
				? yield truncateNode(item, key, walk, depth + 1)
				: persistedLeaf(item, key, walk);
			result.push(next);
		}
		walk.path.leave(obj);
		return walk.changes === changes && !isPlainContainer(obj) ? obj : result;
	}

	const holder = obj as Record<string, unknown>;
	const entries: Array<readonly [string, unknown]> = [];
	// The fields the scan read, in its order, each with the value it read. One a getter deleted after the scan read
	// it is not written; its value is still rebuilt, so the rest of the trail stays in step.
	let scannedKeys: string[] | undefined;
	for (let i = 0; i < scanned; i++) {
		const childKey = reads!.values[reads!.value++] as string;
		const value = reads!.values[reads!.value++];
		(scannedKeys ??= []).push(childKey);
		let next: unknown;
		if (!isContainer(value)) next = persistedLeaf(value, childKey, walk);
		else if (isSnapcompactArchiveSlot(key, childKey, value))
			next = yield persistSnapcompactArchive(value, walk, depth + 1, reads);
		else next = yield truncateNode(value, childKey, walk, depth + 1, reads);
		if (childKey === "jsonlEvents") walk.changes++;
		else if (Object.hasOwn(holder, childKey)) entries.push([childKey, next]);
	}
	// Then each field the scan did not read, once. The object's keys come in the order the scan read them unless a
	// getter changed them, so each is checked against the next key the scan read before a lookup among all of them.
	let matched = 0;
	let scannedSet: Set<string> | undefined;
	for (const childKey in holder) {
		if (!Object.hasOwn(holder, childKey)) continue;
		if (scannedKeys !== undefined && matched < scannedKeys.length) {
			if (scannedKeys[matched] === childKey) {
				matched++;
				continue;
			}
			scannedSet ??= new Set(scannedKeys);
			if (scannedSet.has(childKey)) continue;
		}
		// Strip transient/redundant properties that shouldn't be persisted.
		// - jsonlEvents: raw subprocess streaming events (already saved to artifact files)
		// A scan stops at an object that holds it before it reads any field, so the field is never read.
		if (childKey === "jsonlEvents") {
			walk.changes++;
			continue;
		}
		const value = holder[childKey];
		let next: unknown;
		if (!isContainer(value)) next = persistedLeaf(value, childKey, walk);
		else if (isSnapcompactArchiveSlot(key, childKey, value))
			next = yield persistSnapcompactArchive(value, walk, depth + 1);
		else next = yield truncateNode(value, childKey, walk, depth + 1);
		entries.push([childKey, next]);
	}
	walk.path.leave(obj);
	if (walk.changes === changes) return isPlainContainer(obj) ? Object.fromEntries(entries) : obj;

	const contentEntry = entries.find(([childKey]) => childKey === "content");
	const lineCountEntry = entries.find(([childKey]) => childKey === "lineCount");
	if (contentEntry && typeof contentEntry[1] === "string" && lineCountEntry && typeof lineCountEntry[1] === "number") {
		// Same count as `content.split("\n").length` without the array.
		const lineCount = countNewlines(contentEntry[1]) + 1;
		const updatedEntries = entries.map(([childKey, value]) =>
			childKey === "lineCount" ? ([childKey, lineCount] as const) : ([childKey, value] as const),
		);
		return Object.fromEntries(updatedEntries);
	}
	return Object.fromEntries(entries);
}

/**
 * The JSON text {@link entryRecordText} writes for `entry`, an entry parsed from a session file, whose
 * images are blob references already: by `stringifyJsonIteratively` past {@link DEEP_JSON_LEVELS} levels,
 * as {@link persistedEntryText} writes its line, where `JSON.stringify` would take seconds or run out of
 * stack, else by `JSON.stringify`.
 */
export function loadedEntryRecordText(entry: FileEntry): string {
	return persistedJson(entry, { deep: nestsDeeperThan(entry, DEEP_JSON_LEVELS) });
}

/**
 * Whether this node can possibly change under `truncateForPersistence`:
 * `dirty` when it carries `jsonlEvents`, an oversized or image-position
 * string, or (for objects) a child that can. Mirrors the change conditions of
 * the rebuild pass exactly — a false negative silently keeps oversized
 * content, so when in doubt this must not answer `clean`. It recurses, so a
 * node past {@link PERSISTENCE_SCAN_DEPTH} levels it answers `deep` for
 * unscanned: the rebuild, which keeps its own stack, fails on a cycle, where
 * this scan stops too. The first child that is not clean decides the answer.
 * What it reads on its way goes onto `trail` ({@link ScanTrail}).
 */
function persistenceScan(obj: unknown, key: string | undefined, depth: number, trail: ScanTrail): PersistenceScan {
	if (obj === null || obj === undefined) return "clean";
	if (typeof obj === "string") {
		if (
			obj.length > MAX_PERSIST_CHARS &&
			key !== "thinkingSignature" &&
			key !== "thoughtSignature" &&
			key !== "textSignature"
		)
			return "dirty";
		return externalizedImageSite(obj, key) !== undefined ? "dirty" : "clean";
	}
	if (typeof obj !== "object") return "clean";
	// This node's count goes ahead of its fields' own counts, so its slot is taken before any of theirs.
	const node = trail.nodes++;
	trail.counts[node] = 0;
	if (depth >= PERSISTENCE_SCAN_DEPTH) return "deep";
	const values = trail.values;
	let read = 0;
	if (Array.isArray(obj)) {
		for (const item of obj) {
			values[trail.size++] = item;
			read++;
			const found = persistenceScan(item, key, depth + 1, trail);
			if (found !== "clean") {
				trail.counts[node] = read;
				return found;
			}
		}
		trail.counts[node] = read;
		return "clean";
	}
	// Externalize shapes rewrite (not verbatim): check before the
	// atomic/verbatim classification below.
	if ("jsonlEvents" in obj || externalizedImageSite(obj, key) !== undefined) return "dirty";
	if (isAtomicPersistenceNode(obj, key)) return "clean";
	for (const childKey in obj) {
		if (!Object.hasOwn(obj, childKey)) continue;
		const value = (obj as Record<string, unknown>)[childKey];
		const at = trail.size;
		values[at] = childKey;
		values[at + 1] = value;
		trail.size = at + 2;
		read++;
		const found = isSnapcompactArchiveSlot(key, childKey, value)
			? snapcompactArchiveScan(value, depth + 1, trail)
			: persistenceScan(value, childKey, depth + 1, trail);
		if (found !== "clean") {
			trail.counts[node] = read;
			return found;
		}
	}
	trail.counts[node] = read;
	return "clean";
}

/**
 * True for nodes `truncateForPersistence` returns verbatim without
 * descending: anthropic server-tool/compaction carriers, Cursor and Gemini
 * native records, and signed/encrypted blocks. The scan and the rebuild both
 * ask this, so the rebuild keeps verbatim exactly the nodes the scan read no
 * field of.
 */
function isAtomicPersistenceNode(obj: object, key?: string): boolean {
	// NOTE: image_generation_call results and externalizable image payloads
	// are NOT atomic — truncateForPersistence rewrites them via the blob
	// store. They are checked explicitly in the predicate and must never be
	// classified here.
	// Anthropic server-side compaction replay state: `encrypted_content` is
	// opaque provider state the API validates byte-for-byte on replay, so the
	// carrier persists atomically with its summary and metadata — both as a
	// message `providerPayload` (`type: "anthropicCompaction"`) and under the
	// preserveData slot, whose object carries no `type` marker of its own.
	if (key === "anthropicCompaction" && "content" in obj && typeof obj.content === "string") return true;
	if ("type" in obj) {
		const typed = obj as Record<string, unknown>;
		// Anthropic validates native web-search and tool-search history
		// byte-for-byte on replay. Keep the complete typed block atomic,
		// including opaque content. Only a block that passes
		// isAnthropicServerToolHistoryBlock is atomic. An interrupted,
		// corrupt, or forward-version block that FAILS validation falls
		// through into the generic recursion, so oversized strings and
		// jsonlEvents inside it are still truncated/stripped instead of
		// bypassing size controls.
		if (typed.type === "anthropicServerTool" && "block" in typed) {
			const block = typed.block;
			if (
				typeof block === "object" &&
				block !== null &&
				"type" in block &&
				typeof (block as { type?: unknown }).type === "string"
			) {
				const asBlock = block as Record<string, unknown>;
				const validationView = {
					type: asBlock.type as string,
					...("name" in asBlock ? { name: asBlock.name } : {}),
					...("id" in asBlock ? { id: asBlock.id } : {}),
					...("tool_use_id" in asBlock ? { tool_use_id: asBlock.tool_use_id } : {}),
					...("content" in asBlock ? { content: asBlock.content } : {}),
				};
				if (isAnthropicServerToolHistoryBlock(validationView)) return true;
			}
			return false;
		}
		// Cursor server records are addressed by the SHA-256 of their bytes and
		// carry signed reasoning, and Gemini native content replays its signed
		// parts byte-for-byte, so both persist atomically too.
		if (
			typed.type === "anthropicCompaction" ||
			typed.type === "cursorHistory" ||
			typed.type === "geminiNativeContent"
		)
			return true;
		// Signed content is bound to its exact bytes: a truncated `thinking`/`text`/
		// `arguments` no longer matches its signature and a truncated
		// `redacted_thinking` blob is undecryptable, so the provider 400s the replay.
		// Persist signed blocks verbatim — never truncate, externalize, or descend.
		// Unsigned blocks (e.g. an interrupted stream) have no such binding and stay
		// truncatable for size control.
		const signed =
			(typed.type === "thinking" && "thinkingSignature" in typed && isNonEmptyString(typed.thinkingSignature)) ||
			(typed.type === "text" && "textSignature" in typed && isNonEmptyString(typed.textSignature)) ||
			(typed.type === "toolCall" && "thoughtSignature" in typed && isNonEmptyString(typed.thoughtSignature));
		const redacted = typed.type === "redactedThinking" && "data" in typed && isNonEmptyString(typed.data);
		// OpenAI Responses reasoning items (providerPayload.items) carry
		// `encrypted_content`, server-validated on replay — atomic like signed blocks.
		const encryptedReasoning =
			typed.type === "reasoning" && "encrypted_content" in typed && isNonEmptyString(typed.encrypted_content);
		if (signed || redacted || encryptedReasoning) return true;
	}
	return false;
}

/**
 * Read the duplication-relevant fields of an OpenAI Responses reasoning item.
 * Returns `undefined` for anything that is not a `type: "reasoning"` object, so
 * non-reasoning payload entries and corrupt signatures are never matched.
 */
function readReasoningItem(item: unknown): { encrypted_content?: string; id?: string } | undefined {
	if (item === null || typeof item !== "object") return undefined;
	if (!("type" in item) || item.type !== "reasoning") return undefined;
	const reasoning: { encrypted_content?: string; id?: string } = {};
	if ("encrypted_content" in item && typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
		reasoning.encrypted_content = item.encrypted_content;
	}
	if ("id" in item && typeof item.id === "string" && item.id.length > 0) reasoning.id = item.id;
	return reasoning;
}

/**
 * True when a `thinkingSignature` (a JSON-encoded reasoning item) is already
 * carried by a reasoning item in the message's provider payload — matched on
 * `encrypted_content` (the load-bearing blob) when present, else on item `id`.
 * A signature the payload does not cover is never reported as recoverable, so it
 * is always kept.
 */
function signatureCoveredByPayload(
	signature: string,
	encrypted: ReadonlySet<string>,
	ids: ReadonlySet<string>,
): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(signature);
	} catch {
		return false;
	}
	const reasoning = readReasoningItem(parsed);
	if (!reasoning) return false;
	if (reasoning.encrypted_content) return encrypted.has(reasoning.encrypted_content);
	if (reasoning.id) return ids.has(reasoning.id);
	return false;
}

/**
 * Drop `thinkingSignature` from assistant thinking blocks whose reasoning item is
 * already carried, verbatim, in the message's OpenAI Responses `providerPayload`.
 *
 * Responses/Codex turns mint each reasoning item once and store it twice:
 * `providerPayload.items` (the authoritative native-history copy that replay and
 * remote compaction read) and `content[].thinkingSignature`, which is literally
 * `JSON.stringify(reasoningItem)` — including the large `encrypted_content` blob.
 * Replay only ever reads the payload; the signature is a no-payload fallback that
 * same-provider turns never reach and cross-model turns strip as untrustworthy.
 * Persisting both stores the encrypted reasoning twice for zero token or replay
 * benefit, so the on-disk copy drops the duplicate signature whenever its
 * reasoning item is recoverable from the payload. The in-memory entry is left
 * untouched; only the serialized line is slimmed.
 */
function stripReplayedReasoningSignatures(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "assistant") return entry;
	const message = entry.message;
	const payload = message.providerPayload;
	if (payload?.type !== "openaiResponsesHistory" || !Array.isArray(payload.items)) return entry;
	const hasSignedThinking = message.content.some(
		block =>
			block.type === "thinking" && typeof block.thinkingSignature === "string" && block.thinkingSignature.length > 0,
	);
	if (!hasSignedThinking) return entry;

	const encrypted = new Set<string>();
	const ids = new Set<string>();
	for (const rawItem of payload.items) {
		const reasoning = readReasoningItem(rawItem);
		if (!reasoning) continue;
		if (reasoning.encrypted_content) encrypted.add(reasoning.encrypted_content);
		if (reasoning.id) ids.add(reasoning.id);
	}
	if (encrypted.size === 0 && ids.size === 0) return entry;

	let changed = false;
	const content = message.content.map(block => {
		if (
			block.type !== "thinking" ||
			typeof block.thinkingSignature !== "string" ||
			block.thinkingSignature.length === 0
		) {
			return block;
		}
		if (!signatureCoveredByPayload(block.thinkingSignature, encrypted, ids)) return block;
		changed = true;
		return { ...block, thinkingSignature: undefined };
	});
	if (!changed) return entry;
	return { ...entry, message: { ...message, content } };
}

/**
 * Spilled MCP text already includes the rendered structured payload in its
 * artifact. Keep the live object for eval, but omit the duplicate from the
 * serialized top-level tool result. Never mutate the in-memory message.
 */
function stripSpilledMcpStructuredContent(entry: FileEntry): FileEntry {
	if (entry.type !== "message" || entry.message.role !== "toolResult") return entry;
	const details = entry.message.details;
	if (
		!isRecord(details) ||
		typeof details.serverName !== "string" ||
		typeof details.mcpToolName !== "string" ||
		!Object.hasOwn(details, "structuredContent") ||
		!isRecord(details.meta) ||
		!isRecord(details.meta.truncation) ||
		typeof details.meta.truncation.artifactId !== "string" ||
		details.meta.truncation.artifactId.length === 0
	) {
		return entry;
	}
	const persistedDetails = { ...details };
	delete persistedDetails.structuredContent;
	return { ...entry, message: { ...entry.message, details: persistedDetails } };
}

export function prepareEntryForPersistence(entry: FileEntry, blobStore: BlobStore): FileEntry {
	return preparedEntry(entry, blobStore, undefined);
}

/**
 * The JSON text of the line a session file holds for `entry`:
 * {@link prepareEntryForPersistence}'s result as `stringifyJson` writes it. An
 * entry nested past {@link DEEP_JSON_LEVELS} levels is written by
 * `stringifyJsonIteratively`, the same bytes in milliseconds where
 * `JSON.stringify` takes seconds or runs out of stack.
 */
export function persistedEntryText(entry: FileEntry, blobStore: BlobStore): string {
	const shape: PersistedShape = { deep: false };
	return persistedJson(preparedEntry(entry, blobStore, shape), shape);
}

/**
 * The JSON text of `value` as a session line holds it: by `stringifyJsonIteratively`
 * where `shape` says it nests past {@link DEEP_JSON_LEVELS} levels, else by
 * `JSON.stringify`; a bigint as its decimal string either way.
 */
function persistedJson(value: unknown, shape: PersistedShape): string {
	return (
		(shape.deep ? stringifyJsonIteratively(value, BIGINT_AS_STRING) : stringifyDeepJson(value, BIGINT_AS_STRING)) ??
		"null"
	);
}

/** {@link prepareEntryForPersistence}, setting `shape.deep` for an entry nested past {@link DEEP_JSON_LEVELS} levels. */
function preparedEntry(entry: FileEntry, blobStore: BlobStore, shape: PersistedShape | undefined): FileEntry {
	const projected = stripSpilledMcpStructuredContent(stripReplayedReasoningSignatures(entry));
	try {
		return truncateForPersistence(projected, blobStore, shape) as FileEntry;
	} catch (error) {
		// The walk probes fields such as `data` and `type` with `in` and plain
		// reads, so it also reaches non-enumerable and inherited accessors that
		// the JSONL line never holds. Tool `details` can keep a library object
		// whose getter throws (firecrawl-js `SearchData.data`). Left unhandled,
		// that latches a disk failure, and every later rewrite of the session
		// meets the same entry, so nothing persists for the rest of the process.
		// Retry once on the plain JSON of the entry: it holds the fields the
		// line would serialize, and no accessors.
		let json: string | undefined;
		try {
			json = stringifyDeepJson(projected, BIGINT_AS_STRING);
		} catch {
			throw error;
		}
		if (json === undefined) throw error;
		try {
			return truncateForPersistence(JSON.parse(json), blobStore, shape) as FileEntry;
		} catch {
			// A cause the clone does not remove (blob I/O) fails again: keep the
			// first error so the logged cause stays stable.
			throw error;
		}
	}
}

/**
 * `value` with each image payload a persisted line externalizes (content image
 * blocks, `images[]`, snapcompact frames, image data URLs, generated images)
 * replaced by its blob reference, and nothing else changed. A block a persisted
 * line keeps verbatim ({@link isAtomicPersistenceNode}) keeps its images inline,
 * as the line does. Untouched subtrees are shared. The walk keeps its own
 * stack ({@link runNested}), so it reaches the images of a value of any depth
 * `JSON.parse` reads; past {@link DEEP_JSON_LEVELS} levels it sets `shape.deep`.
 */
function externalizeImagesOnly(value: unknown, blobStore: BlobStore, shape: PersistedShape): unknown {
	if (!isContainer(value)) return externalizedImagesLeaf(value, undefined, blobStore);
	const walk: PersistenceWalk = { blobStore, path: new ContainerPath(), deepest: 0 };
	const externalized = runNested(externalizedImagesNode(value, undefined, walk, 0));
	if (walk.deepest > DEEP_JSON_LEVELS) shape.deep = true;
	return externalized;
}

/** {@link externalizeImagesOnly} of `value`, no object, under `key` of its holder. */
function externalizedImagesLeaf(value: unknown, key: string | undefined, blobStore: BlobStore): unknown {
	return externalizeImageNode(value, blobStore, key) ?? value;
}

/** {@link externalizeImagesOnly} of `value`, an object under `key` of its holder at `depth` levels. */
function* externalizedImagesNode(
	value: object,
	key: string | undefined,
	walk: PersistenceWalk,
	depth: number,
): NestedWalk {
	// An image is replaced before its level counts toward `walk.deepest`: the walk does not go into it.
	const image = externalizeImageNode(value, walk.blobStore, key);
	if (image !== undefined) return image;
	if (depth > walk.deepest) walk.deepest = depth;
	if (isAtomicPersistenceNode(value, key)) return value;
	walk.path.enter(value);
	if (Array.isArray(value)) {
		let changed: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item: unknown = value[index];
			const next = isContainer(item)
				? yield externalizedImagesNode(item, key, walk, depth + 1)
				: externalizedImagesLeaf(item, key, walk.blobStore);
			if (next === item) continue;
			changed ??= value.slice();
			changed[index] = next;
		}
		walk.path.leave(value);
		return changed ?? value;
	}
	let changed: Record<string, unknown> | undefined;
	for (const childKey in value) {
		if (!Object.hasOwn(value, childKey)) continue;
		const child: unknown = Reflect.get(value, childKey);
		const next = isContainer(child)
			? yield externalizedImagesNode(child, childKey, walk, depth + 1)
			: externalizedImagesLeaf(child, childKey, walk.blobStore);
		if (next === child) continue;
		changed ??= { ...value };
		changed[childKey] = next;
	}
	walk.path.leave(value);
	return changed ?? value;
}

/**
 * The JSON text of `entry` as the manager holds it, with image payloads
 * replaced by blob references (the blob store keeps their bytes). Unlike
 * {@link prepareEntryForPersistence} nothing is truncated, stripped or masked:
 * parsing the text and resolving its blob references gives the entry back,
 * but for snapcompact frames, which resolving leaves as references where the
 * entry may have held their base64 data; their readers resolve a reference as
 * they read it (`lazyImageDataSync`). An entry nested past
 * {@link DEEP_JSON_LEVELS} levels is written by `stringifyJsonIteratively`, as
 * its session line is. Where the blob store cannot take an image (a full
 * disk), the text is the entry's JSON with its images inline, which parses
 * back to the entry as well. Throws only for a value JSON cannot write: a
 * cycle, a getter or `toJSON` that throws, or a text longer than the engine's
 * longest string (2^31 - 1 units). A value parsed from a transcript line holds
 * none of the first two, and the last needs a line about that long.
 */
export function entryRecordText(entry: FileEntry, blobStore: BlobStore): string {
	const shape: PersistedShape = { deep: false };
	let externalized: unknown;
	try {
		externalized = externalizeImagesOnly(entry, blobStore, shape);
	} catch (error) {
		// A library object in `details` can carry a getter that throws when the
		// walk probes it (see prepareEntryForPersistence); its plain JSON has none,
		// and the walk replaces the images in that. A value JSON cannot write
		// fails here: the first error is kept.
		let json: string | undefined;
		try {
			json = stringifyDeepJson(entry, BIGINT_AS_STRING);
		} catch {
			throw error;
		}
		if (json === undefined) throw error;
		try {
			externalized = externalizeImagesOnly(JSON.parse(json), blobStore, shape);
		} catch {
			// The walk fails on the clone too: an image the blob store cannot take (a full disk).
			return json;
		}
	}
	return persistedJson(externalized, shape);
}
