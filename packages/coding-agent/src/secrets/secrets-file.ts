import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { SecretEntry } from "./obfuscator";
import { sanitizeSecretFriendlyName } from "./placeholder";
import { compileSecretRegex } from "./regex";
import { regexHasUnresolvableShortMatchFallback } from "./replacement";

/** A valid secrets.yml entry and its 1-based position in the file's YAML array. */
export interface PositionedSecretEntry {
	entry: SecretEntry;
	position: number;
}

type RawSecretEntry = Omit<SecretEntry, "friendlyName"> & { friendlyName?: unknown };

/** One mebibyte: a caller's size bound is a whole number of them. */
export const MIB = 1024 * 1024;
/** Non-blocking: by the open, the path may name a FIFO. */
const SECRET_FILE_OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
/** UTF-8, as both readers decode: a leading byte-order mark is dropped, a malformed sequence becomes U+FFFD. */
const UTF8 = new TextDecoder();

/**
 * A read of a secret file: its text, or why it was not read. Either way the stat of the path the read
 * went by, which the session-store masker stamps the file with.
 */
export type SecretFileRead =
	| { readonly text: string; readonly stat: fs.BigIntStats }
	| {
			readonly skip: string;
			/** Skipped for its size: over the caller's bound, or grown past what its stat reported while it was read. */
			readonly oversized: boolean;
			readonly stat: fs.BigIntStats;
	  };

/** What a read gives when the caller's `unchanged` answered true: it opened nothing. */
export interface UnchangedSecretFile {
	readonly unchanged: true;
}

export interface SecretFileReadOptions {
	/**
	 * Sees the stat the read took of the path, before anything else: when it answers true, the read
	 * opens nothing and gives {@link UnchangedSecretFile}.
	 */
	readonly unchanged: (stat: fs.BigIntStats) => boolean;
	/** The most bytes the file may hold: a larger one is skipped unread. No bound when absent. */
	readonly maxBytes?: number;
}

const UNCHANGED: UnchangedSecretFile = { unchanged: true };

/** The project-local secrets.yml of `cwd`. */
export function projectSecretsFilePath(cwd: string): string {
	return path.join(cwd, ".omp", "secrets.yml");
}

/** The global secrets.yml under `agentDir`. */
export function globalSecretsFilePath(agentDir: string): string {
	return path.join(agentDir, "secrets.yml");
}

/**
 * Read one secrets.yml, of any size; a missing file, a path that is not a regular file, one that grew
 * while it was read, a file that is not a YAML array, and invalid entries yield nothing.
 */
export async function loadSecretsFile(filePath: string): Promise<SecretEntry[]> {
	try {
		const read = await readSecretFile(filePath);
		if ("skip" in read) {
			if (read.oversized) logger.warn("Skipped secrets.yml", { path: filePath, reason: read.skip });
			else logger.debug("Skipped secrets.yml", { path: filePath, reason: read.skip });
			return [];
		}
		return parseSecretsFile(read.text, filePath).map(({ entry }) => entry);
	} catch (err) {
		return secretsFileFailure(err, filePath);
	}
}

/** The skip of a path whose stat is `stat` when it is not a regular file, which neither reader opens. */
function notRegularFile(stat: fs.BigIntStats): SecretFileRead | undefined {
	return stat.isFile() ? undefined : { skip: "not a regular file", oversized: false, stat };
}

/**
 * The skip of the descriptor opened for the path whose stat is `stat`, when the descriptor's own stat,
 * `opened`, shows another file than `stat` does, or one over `maxBytes` when the caller gave a bound.
 */
function openedFileSkip(
	stat: fs.BigIntStats,
	opened: fs.BigIntStats,
	maxBytes: number | undefined,
): SecretFileRead | undefined {
	if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
		return { skip: "replaced before it was opened", oversized: false, stat };
	}
	if (maxBytes !== undefined && opened.size > maxBytes) {
		return { skip: `larger than ${maxBytes / MIB} MiB`, oversized: true, stat };
	}
	return undefined;
}

/** The text of the `length` bytes read into `buffer`, which is one byte longer than the size the descriptor reported. */
function readFileText(stat: fs.BigIntStats, buffer: Buffer, length: number): SecretFileRead {
	// The byte past the reported size was read: the file grew after its stat.
	if (length === buffer.length) return { skip: "grew past its reported size", oversized: true, stat };
	return { text: UTF8.decode(buffer.subarray(0, length)), stat };
}

/**
 * Reads the secret file at `filePath`, a `_FILE` file or a secrets.yml, following links; throws on a
 * filesystem error, a missing path included. `options.unchanged` sees the stat first and, answering
 * true, leaves the file unopened. Nothing but a regular file is opened: an open of a FIFO, even a
 * non-blocking one, lets a writer that waits in its own open go on, and the close then leaves that
 * writer with no reader. The descriptor is checked again, as by then the path may name another file,
 * and the file is read only when it did not grow while it was read and, when `options.maxBytes` is
 * given, holds at most that many bytes. {@link readSecretFile} is the same read for an async caller.
 */
export function readSecretFileSync(
	filePath: string,
	options: SecretFileReadOptions,
): SecretFileRead | UnchangedSecretFile {
	const stat = fs.statSync(filePath, { bigint: true });
	if (options.unchanged(stat)) return UNCHANGED;
	const notFile = notRegularFile(stat);
	if (notFile !== undefined) return notFile;
	const fd = fs.openSync(filePath, SECRET_FILE_OPEN_FLAGS);
	try {
		const opened = fs.fstatSync(fd, { bigint: true });
		const refused = openedFileSkip(stat, opened, options.maxBytes);
		if (refused !== undefined) return refused;
		const buffer = Buffer.allocUnsafe(Number(opened.size) + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
			if (read === 0) break;
			length += read;
		}
		return readFileText(stat, buffer, length);
	} finally {
		fs.closeSync(fd);
	}
}

/** {@link readSecretFileSync} for an async caller, a secrets.yml's: the same checks and decoding, with no size bound. */
async function readSecretFile(filePath: string): Promise<SecretFileRead> {
	const stat = await fs.promises.stat(filePath, { bigint: true });
	const notFile = notRegularFile(stat);
	if (notFile !== undefined) return notFile;
	const handle = await fs.promises.open(filePath, SECRET_FILE_OPEN_FLAGS);
	try {
		const opened = await handle.stat({ bigint: true });
		const refused = openedFileSkip(stat, opened, undefined);
		if (refused !== undefined) return refused;
		const buffer = Buffer.allocUnsafe(Number(opened.size) + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		return readFileText(stat, buffer, length);
	} finally {
		await handle.close();
	}
}

/**
 * The valid entries of a secrets.yml's `text`, each with its position; a text that does not parse, or
 * is not a YAML array, yields nothing. The caller reads the text, so it knows a read that failed
 * from a file that holds no entry.
 */
export function parseSecretsFileText(text: string, filePath: string): PositionedSecretEntry[] {
	try {
		return parseSecretsFile(text, filePath);
	} catch (err) {
		return secretsFileFailure(err, filePath);
	}
}

function secretsFileFailure(err: unknown, filePath: string): [] {
	if (!isEnoent(err)) logger.warn("Failed to load secrets.yml", { path: filePath, error: String(err) });
	return [];
}

function parseSecretsFile(text: string, filePath: string): PositionedSecretEntry[] {
	const raw = YAML.parse(text);
	if (!Array.isArray(raw)) {
		logger.warn("secrets.yml must be a YAML array", { path: filePath });
		return [];
	}
	const entries: PositionedSecretEntry[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (!validateEntry(entry, filePath, i)) continue;
		const friendlyName = loadFriendlyName(entry, filePath, i);
		entries.push({
			entry: {
				type: entry.type,
				content: entry.content,
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				flags: entry.flags,
				friendlyName,
			},
			position: i + 1,
		});
	}
	return entries;
}

// Validates the friendlyName but returns it UNSANITIZED: `SecretObfuscator`'s
// own `#createPlaceholder` sanitizes it again and, critically, needs the raw
// string for `#friendlyNameCollidesWithSecret`'s regex-collision check — a
// case-sensitive/punctuated regex pattern (e.g. `tok_[a-z0-9]+`) only matches
// the label as it was actually written, not an already-uppercased,
// separator-stripped rendering of it. Pre-sanitizing here would silently
// defeat that check for every `secrets.yml`-loaded entry.
function loadFriendlyName(entry: RawSecretEntry, filePath: string, index: number): string | undefined {
	if (entry.friendlyName === undefined) return undefined;
	if (typeof entry.friendlyName !== "string") {
		logger.warn(`secrets.yml[${index}]: friendlyName must be a string`, { path: filePath });
		return undefined;
	}
	if (sanitizeSecretFriendlyName(entry.friendlyName) === undefined) {
		logger.warn(`secrets.yml[${index}]: friendlyName must contain at least one letter or digit`, { path: filePath });
		return undefined;
	}
	return entry.friendlyName;
}

function validateEntry(entry: unknown, filePath: string, index: number): entry is RawSecretEntry {
	if (entry === null || typeof entry !== "object") {
		logger.warn(`secrets.yml[${index}]: entry must be an object`, { path: filePath });
		return false;
	}
	const e = entry as Record<string, unknown>;
	if (e.type !== "plain" && e.type !== "regex") {
		logger.warn(`secrets.yml[${index}]: type must be "plain" or "regex"`, { path: filePath });
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		logger.warn(`secrets.yml[${index}]: content must be a non-empty string`, { path: filePath });
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		logger.warn(`secrets.yml[${index}]: mode must be "obfuscate" or "replace"`, { path: filePath });
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		logger.warn(`secrets.yml[${index}]: replacement must be a string`, { path: filePath });
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		logger.warn(`secrets.yml[${index}]: flags must be a string`, { path: filePath });
		return false;
	}
	if (e.type === "regex") {
		let regex: RegExp;
		try {
			regex = compileSecretRegex(e.content as string, e.flags as string | undefined);
		} catch (error) {
			logger.warn(`secrets.yml[${index}]: invalid regex pattern`, {
				path: filePath,
				pattern: e.content,
				error: String(error),
			});
			return false;
		}
		const mode = (e.mode as "obfuscate" | "replace" | undefined) ?? "obfuscate";
		if (mode === "replace" && e.replacement === undefined && regexHasUnresolvableShortMatchFallback(regex)) {
			logger.warn(
				`secrets.yml[${index}]: regex matches every 1-2 character candidate with no custom replacement, so a match can never be redacted distinctly from itself`,
				{ path: filePath, pattern: e.content },
			);
			return false;
		}
	}
	return true;
}
