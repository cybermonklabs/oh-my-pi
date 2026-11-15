import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, hasFsCode, isEnoent, isFsError, logger } from "@oh-my-pi/pi-utils";
import { collectEnvSecretValues, connectionUrlPasswords, MIN_ENV_VALUE_LENGTH } from "./env-secrets";
import type { SecretEntry } from "./obfuscator";
import { MIN_OBFUSCATE_SECRET_LEN, sanitizeSecretFriendlyName } from "./placeholder";
import { compileSecretRegex } from "./regex";
import { globalSecretsFilePath, loadSecretsFileSync, projectSecretsFilePath } from "./secrets-file";

export type SessionStoreMaskSourceKind = "env" | "file" | "secrets.yml";

/** Where masked values come from: the kind and the label the marker shows, never a value. */
export interface SessionStoreMaskSource {
	readonly kind: SessionStoreMaskSourceKind;
	readonly name: string;
}

export interface SessionStoreMaskerOptions {
	/** Environment to read secrets and `_FILE` paths from (default: `process.env`). */
	env?: () => Readonly<Record<string, string | undefined>>;
	/** Directory of the global secrets.yml (default: `getAgentDir()`). */
	agentDir?: string;
	/** Clock for the refresh interval (default: `Date.now`). */
	now?: () => number;
}

interface RegexMarker {
	readonly regex: RegExp;
	readonly marker: string;
}

interface HeldSource {
	readonly kind: SessionStoreMaskSourceKind;
	/** Preferred label. */
	readonly name: string;
	/** Index label, used when `name` would expose a held secret. */
	readonly fallback: string;
}

interface HeldRegex {
	readonly regex: RegExp;
	readonly source: HeldSource;
}

type Env = Readonly<Record<string, string | undefined>>;

const REFRESH_INTERVAL_MS = 60_000;
const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_.-]/g;

/** Regex source matching any of `literals`, longest first (ties in code-unit order) so a value containing another wins. */
function alternation(literals: Iterable<string>): string {
	return [...literals]
		.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
		.map(literal => RegExp.escape(literal))
		.join("|");
}

/**
 * An immutable set of secret values and regexes, each mapped to a marker that
 * names its source. `maskText` replaces every held value with its marker and
 * never touches the exact markers this snapshot makes, so masking is idempotent.
 */
export class SessionStoreMask {
	readonly sources: readonly SessionStoreMaskSource[];
	readonly empty: boolean;
	readonly #valueMarkers: ReadonlyMap<string, string>;
	readonly #regexes: readonly RegexMarker[];
	/** `(<markers>)|<values>`: a marker match is kept, a value match becomes its marker. */
	readonly #literal: RegExp | undefined;
	/** Any held value; the no-hit fast path. */
	readonly #valueProbe: RegExp | undefined;
	/** Splits text on the exact markers, keeping them at the odd indexes. */
	readonly #markerSplit: RegExp;

	constructor(
		valueMarkers: ReadonlyMap<string, string>,
		regexes: readonly RegexMarker[],
		sources: readonly SessionStoreMaskSource[],
	) {
		this.#valueMarkers = valueMarkers;
		this.#regexes = regexes;
		this.sources = sources;
		this.empty = valueMarkers.size === 0 && regexes.length === 0;
		const markers = alternation(new Set([...valueMarkers.values(), ...regexes.map(({ marker }) => marker)]));
		this.#markerSplit = new RegExp(`(${markers})`);
		if (valueMarkers.size > 0) {
			const values = alternation(valueMarkers.keys());
			this.#literal = new RegExp(`(${markers})|${values}`, "g");
			this.#valueProbe = new RegExp(values);
		}
	}

	/** Replace every held secret in `text` with its marker. Throws rather than return text that may hold one. */
	maskText(text: string): string {
		if (this.empty || !this.#mayHit(text)) return text;
		// A changing step turns at least one character outside the exact markers
		// into a marker, so the text settles within `text.length` changing steps;
		// only a held value that overlaps a marker could keep it changing.
		let current = text;
		for (let step = 0; step <= text.length; step++) {
			const next = this.#step(current);
			if (next === current) return current;
			current = next;
		}
		throw new Error("Session store masking did not settle");
	}

	#mayHit(text: string): boolean {
		if (this.#valueProbe?.test(text)) return true;
		for (const { regex } of this.#regexes) {
			regex.lastIndex = 0;
			if (regex.test(text)) return true;
		}
		return false;
	}

	#step(text: string): string {
		let next = this.#literal ? text.replace(this.#literal, this.#maskLiteral) : text;
		for (const { regex, marker } of this.#regexes) {
			const parts = next.split(this.#markerSplit);
			for (let i = 0; i < parts.length; i += 2) {
				parts[i] = parts[i].replace(regex, match => (match === "" ? match : marker));
			}
			next = parts.join("");
		}
		return next;
	}

	#maskLiteral = (match: string, marker: string | undefined): string => marker ?? this.#valueMarkers.get(match)!;
}

/** Identity of the file at `filePath` for change checks; throws when it cannot be stat'ed. */
function statStamp(filePath: string): string {
	const stat = fs.statSync(filePath, { bigint: true });
	return `${filePath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function fileErrorReason(err: unknown): string {
	if (isEnoent(err) || hasFsCode(err, "ENOTDIR")) return "missing";
	return `unreadable (${isFsError(err) ? err.code : "error"})`;
}

/** Read a regular file of at most 1 MiB, following links; throws on filesystem errors. */
function readSecretFile(filePath: string): { text: string } | { skip: string } {
	// Non-blocking: opening a FIFO with no writer returns at once, and fstat rejects it.
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return { skip: "not a regular file" };
		if (stat.size > MAX_SECRET_FILE_BYTES) return { skip: "larger than 1 MiB" };
		// One byte past the reported size reveals a file that grew after fstat.
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
			if (read === 0) break;
			length += read;
		}
		if (length > stat.size) return { skip: "grew past its reported size" };
		return { text: buffer.toString("utf8", 0, length) };
	} finally {
		fs.closeSync(fd);
	}
}

function collectSafely(kind: SessionStoreMaskSourceKind, collect: () => void): void {
	try {
		collect();
	} catch (err) {
		logger.warn("Session store masking source failed", { kind, error: String(err) });
	}
}

/**
 * Holds every secret value Oh My Pi knows — secret-named environment variables,
 * the files `_FILE` variables name, and the project and global secrets.yml — and
 * hands out {@link SessionStoreMask} snapshots of them. Values are only ever
 * added: a rotated secret's old value stays masked.
 */
export class SessionStoreMasker {
	readonly #env: () => Env;
	readonly #agentDir: string;
	readonly #now: () => number;
	#snapshot: SessionStoreMask | undefined;
	#refreshedAt = 0;
	/** A snapshot was handed out in the current synchronous run. */
	#handedOut = false;
	#grew = false;
	readonly #cwds = new Set<string>();
	readonly #sources: HeldSource[] = [];
	readonly #namedSources = new Map<string, HeldSource>();
	readonly #values = new Map<string, HeldSource>();
	readonly #regexes: HeldRegex[] = [];
	readonly #regexKeys = new Set<string>();
	/** Stamp of each `_FILE` variable's file at its last read, by variable name. */
	readonly #fileStamps = new Map<string, string>();
	/** Stamp of each secrets.yml at its last read, by path. */
	readonly #secretsFileStamps = new Map<string, string>();
	/** Last logged skip reason, by `_FILE` variable name. */
	readonly #skipReasons = new Map<string, string>();

	constructor(options: SessionStoreMaskerOptions = {}) {
		this.#env = options.env ?? (() => process.env);
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#now = options.now ?? Date.now;
	}

	/**
	 * The mask for a writer in `cwd`. Built at the first call; afterwards the
	 * sources are read again at most once a minute, never twice in one
	 * synchronous run. A new `cwd` adds its project secrets.yml at once.
	 */
	snapshot(cwd: string): SessionStoreMask {
		const dir = path.resolve(cwd);
		let snapshot = this.#snapshot;
		if (snapshot === undefined) {
			this.#refreshedAt = this.#now();
			this.#cwds.add(dir);
			this.#collect();
			snapshot = this.#publish();
		} else {
			if (!this.#handedOut && this.#now() - this.#refreshedAt >= REFRESH_INTERVAL_MS) {
				this.#refreshedAt = this.#now();
				this.#collect();
			}
			if (!this.#cwds.has(dir)) {
				this.#cwds.add(dir);
				collectSafely("secrets.yml", () => this.#collectSecretsFile(projectSecretsFilePath(dir), "project"));
			}
			if (this.#grew) snapshot = this.#publish();
		}
		if (!this.#handedOut) {
			this.#handedOut = true;
			queueMicrotask(() => {
				this.#handedOut = false;
			});
		}
		return snapshot;
	}

	#collect(): void {
		let env: Env = {};
		try {
			env = this.#env();
		} catch (err) {
			logger.warn("Session store masking could not read the environment", { error: String(err) });
		}
		collectSafely("env", () => {
			for (const { name, value } of collectEnvSecretValues(env)) this.#holdNamed("env", name, value);
		});
		collectSafely("file", () => {
			for (const [name, value] of Object.entries(env)) {
				if (name.endsWith("_FILE") && value) this.#collectFile(name, value);
			}
		});
		for (const cwd of this.#cwds) {
			collectSafely("secrets.yml", () => this.#collectSecretsFile(projectSecretsFilePath(cwd), "project"));
		}
		collectSafely("secrets.yml", () => this.#collectSecretsFile(globalSecretsFilePath(this.#agentDir), "global"));
	}

	#collectFile(name: string, value: string): void {
		const filePath = path.resolve(value);
		let stamp: string;
		let read: { text: string } | { skip: string };
		try {
			stamp = statStamp(filePath);
			if (this.#fileStamps.get(name) === stamp) return;
			read = readSecretFile(filePath);
		} catch (err) {
			// Not stamped: a permission fix leaves the stamp unchanged, so retry next time.
			this.#skipFile(name, fileErrorReason(err));
			return;
		}
		this.#fileStamps.set(name, stamp);
		if ("skip" in read) {
			this.#skipFile(name, read.skip);
			return;
		}
		const content = read.text.trim();
		if (content.length < MIN_ENV_VALUE_LENGTH) {
			this.#skipFile(name, `shorter than ${MIN_ENV_VALUE_LENGTH} characters`);
			return;
		}
		this.#skipReasons.delete(name);
		this.#holdNamed("file", name, content);
		for (const line of content.split("\n")) {
			for (const password of connectionUrlPasswords(line.trim())) this.#holdNamed("file", name, password);
		}
	}

	#skipFile(name: string, reason: string): void {
		if (this.#skipReasons.get(name) === reason) return;
		this.#skipReasons.set(name, reason);
		logger.debug("Session store masking skipped a file", { variable: name, reason });
	}

	#collectSecretsFile(filePath: string, scope: "project" | "global"): void {
		let stamp: string;
		try {
			stamp = statStamp(filePath);
		} catch {
			return;
		}
		if (this.#secretsFileStamps.get(filePath) === stamp) return;
		this.#secretsFileStamps.set(filePath, stamp);
		for (const { entry, position } of loadSecretsFileSync(filePath)) this.#holdEntry(entry, `${scope}#${position}`);
	}

	#holdEntry(entry: SecretEntry, fallback: string): void {
		const friendlyName =
			entry.friendlyName === undefined ? undefined : sanitizeSecretFriendlyName(entry.friendlyName);
		const source = (): HeldSource =>
			this.#addSource({ kind: "secrets.yml", name: friendlyName ?? fallback, fallback });
		if (entry.type === "plain") {
			// Obfuscate-mode plain values below the floor are never masked by the obfuscator either.
			if (entry.mode === "replace" || entry.content.length >= MIN_OBFUSCATE_SECRET_LEN) {
				this.#holdValue(entry.content, source);
			}
			return;
		}
		const regex = compileSecretRegex(entry.content, entry.flags);
		const key = `${regex.source}/${regex.flags}`;
		if (this.#regexKeys.has(key)) return;
		this.#regexKeys.add(key);
		this.#regexes.push({ regex, source: source() });
		this.#grew = true;
	}

	#holdNamed(kind: "env" | "file", name: string, value: string): void {
		this.#holdValue(value, () => {
			const key = `${kind}:${name}`;
			let source = this.#namedSources.get(key);
			if (source === undefined) {
				const position = this.#sources.filter(held => held.kind === kind).length + 1;
				source = this.#addSource({ kind, name: name.replace(UNSAFE_NAME_CHARS, "_"), fallback: `#${position}` });
				this.#namedSources.set(key, source);
			}
			return source;
		});
	}

	#holdValue(value: string, source: () => HeldSource): void {
		if (this.#values.has(value)) return;
		this.#values.set(value, source());
		this.#grew = true;
	}

	#addSource(source: HeldSource): HeldSource {
		this.#sources.push(source);
		return source;
	}

	/** Whether `label` contains a held plain value or a non-empty match of a held regex. */
	#exposesSecret(label: string): boolean {
		for (const value of this.#values.keys()) {
			if (label.includes(value)) return true;
		}
		for (const { regex } of this.#regexes) {
			regex.lastIndex = 0;
			for (const match of label.matchAll(regex)) {
				if (match[0] !== "") return true;
			}
		}
		return false;
	}

	#publish(): SessionStoreMask {
		const markers = new Map<HeldSource, string>();
		const sources: SessionStoreMaskSource[] = [];
		const listed = new Set<string>();
		for (const source of this.#sources) {
			// Labels are recomputed over every held secret, so a value added later still never shows in a marker.
			const name = this.#exposesSecret(source.name) ? source.fallback : source.name;
			markers.set(source, `[REDACTED:${source.kind}:${name}]`);
			const id = `${source.kind}:${name}`;
			if (listed.has(id)) continue;
			listed.add(id);
			sources.push({ kind: source.kind, name });
		}
		const values = new Map<string, string>();
		for (const [value, source] of this.#values) values.set(value, markers.get(source)!);
		const regexes = this.#regexes.map(({ regex, source }) => ({ regex, marker: markers.get(source)! }));
		logger.info("Session store masking sources", { sources: [...listed] });
		this.#grew = false;
		this.#snapshot = new SessionStoreMask(values, regexes, sources);
		return this.#snapshot;
	}
}

const processMaskers = new Map<string, SessionStoreMasker>();

/** The process-wide masker for `agentDir` (default: the active agent dir), shared by every session writer. */
export function processSessionStoreMasker(agentDir: string = getAgentDir()): SessionStoreMasker {
	let masker = processMaskers.get(agentDir);
	if (masker === undefined) {
		masker = new SessionStoreMasker({ agentDir });
		processMaskers.set(agentDir, masker);
	}
	return masker;
}

let sessionStoreMasking = false;

/** Turn masking of stored session entries on or off for this process (`secrets.maskSessionStore`). */
export function setSessionStoreMasking(enabled: boolean): void {
	sessionStoreMasking = enabled;
}

/**
 * The mask every session store writer applies for `cwd`, or `null` while masking is off.
 * `null`, not `undefined`, so a writer that took one mask for a whole body can pass "no mask"
 * on without a default parameter asking again.
 */
export function sessionStoreMaskFor(cwd: string): SessionStoreMask | null {
	return sessionStoreMasking ? processSessionStoreMasker().snapshot(cwd) : null;
}
