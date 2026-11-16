import type * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isEnotdir, isFsError, logger, toError } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	collectEnvSecretValues,
	connectionUrlPasswords,
	type Env,
	isSecretFileEnvName,
	MIN_ENV_VALUE_LENGTH,
} from "./env-secrets";
import type { SecretEntry } from "./obfuscator";
import { MIN_OBFUSCATE_SECRET_LEN, sanitizeSecretFriendlyName } from "./placeholder";
import { compileSecretRegex } from "./regex";
import {
	globalSecretsFilePath,
	parseSecretsFileText,
	projectSecretsFilePath,
	readSecretFileSync,
	type SecretFileRead,
	type UnchangedSecretFile,
} from "./secrets-file";
import { buildSessionStoreMatcher, MARKER_PREFIX, type SessionStoreMatcher } from "./session-store-matcher";
import { cfgSecretsMaskSessionStore } from "./settings";

export type SessionStoreMaskSourceKind = "env" | "file" | "secrets.yml";

/** Where masked values come from: the kind and the label the marker shows, never a value. */
export interface SessionStoreMaskSource {
	readonly kind: SessionStoreMaskSourceKind;
	readonly name: string;
}

export interface SessionStoreMaskerOptions {
	/** Environment to read secrets and `_FILE` paths from (default: `process.env`). */
	env?: () => Env;
	/** Directory of the global secrets.yml. */
	agentDir: string;
	/** Clock for the refresh interval (default: `Date.now`). */
	now?: () => number;
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

interface HeldValue {
	readonly source: HeldSource;
	/**
	 * The value as JSON text holds it: a quote, a backslash or a control character escaped. The
	 * value itself when it holds none, so a value without an escape is not kept twice.
	 */
	readonly escaped: string;
}

const REFRESH_INTERVAL_MS = 60_000;
/** The most the file a `_FILE` variable names may hold: a larger one gives no value. A secrets.yml has no bound. */
const MAX_FILE_SOURCE_BYTES = 1024 * 1024;
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_.-]/g;

/**
 * An immutable set of secret values and regexes, each mapped to a marker that
 * names its source. `maskText` replaces every held value with a marker and
 * returns text it has masked as it is, so masking is idempotent.
 */
export class SessionStoreMask {
	readonly sources: readonly SessionStoreMaskSource[];
	readonly empty: boolean;
	readonly #matcher: SessionStoreMatcher;

	constructor(matcher: SessionStoreMatcher, sources: readonly SessionStoreMaskSource[], empty: boolean) {
		this.#matcher = matcher;
		this.sources = sources;
		this.empty = empty;
	}

	/** Replace every held secret in `text` with a marker. Throws rather than return text that may hold one. */
	maskText(text: string): string {
		return this.empty ? text : this.#matcher.mask(text);
	}
}

/**
 * The values and regexes of one origin: the environment with the files its `_FILE` variables name,
 * one project's secrets.yml, or the global secrets.yml. Only ever added to.
 */
class HeldSet {
	/** Counts what was added, so a snapshot knows whether it holds all of it. */
	additions = 0;
	readonly sources: HeldSource[] = [];
	readonly values = new Map<string, HeldValue>();
	/** By `<source>/<flags>`, in the order they were added. */
	readonly regexes = new Map<string, HeldRegex>();

	addSource(source: HeldSource): HeldSource {
		this.sources.push(source);
		return source;
	}

	holdValue(value: string, source: () => HeldSource): void {
		if (this.values.has(value)) return;
		const escaped = JSON.stringify(value).slice(1, -1);
		this.values.set(value, { source: source(), escaped: escaped === value ? value : escaped });
		this.additions++;
	}

	holdRegex(regex: RegExp, source: () => HeldSource): void {
		const key = `${regex.source}/${regex.flags}`;
		if (this.regexes.has(key)) return;
		this.regexes.set(key, { regex, source: source() });
		this.additions++;
	}
}

/** One cwd's part of a masker. */
interface ProjectState {
	/** What the project secrets.yml of the cwd holds. */
	readonly held: HeldSet;
	/** The refresh that last checked that file. */
	round: number;
	/** A mask was handed out for the cwd. */
	served: boolean;
	/** The cwd's own last snapshot, once its project secrets.yml holds something. */
	mask?: SessionStoreMask;
	/** The additions of the held sets that snapshot was built from. */
	additions: number;
}

/**
 * Identity of the file `stat` describes, for change checks.
 * The ctime is part of it, so a file fixed by `chmod` or `chown` is read again.
 */
function stampOf(filePath: string, stat: fs.BigIntStats): string {
	return `${filePath}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function collectSafely(kind: SessionStoreMaskSourceKind, collect: () => void): void {
	try {
		collect();
	} catch (err) {
		logger.warn("Session store masking source failed", { kind, error: String(err) });
	}
}

/** Whether `label` contains a held plain value or a non-empty match of a held regex. */
function exposesSecret(
	label: string,
	values: ReadonlyMap<string, HeldValue>,
	regexes: ReadonlyMap<string, HeldRegex>,
): boolean {
	for (const value of values.keys()) {
		if (label.includes(value)) return true;
	}
	for (const { regex } of regexes.values()) {
		regex.lastIndex = 0;
		for (const match of label.matchAll(regex)) {
			if (match[0] !== "") return true;
		}
	}
	return false;
}

/**
 * Holds every secret value Oh My Pi knows — secret-named environment variables,
 * the files `_FILE` variables name, and the project and global secrets.yml — and
 * hands out {@link SessionStoreMask} snapshots of them for each cwd: its own for a
 * cwd whose project secrets.yml holds something, one shared by every other cwd.
 * Values are only ever added: a rotated secret's old value stays masked.
 */
export class SessionStoreMasker {
	readonly #env: () => Env;
	readonly #agentDir: string;
	readonly #now: () => number;
	#refreshedAt = 0;
	/** Counts the refreshes: 0 until the sources are first read. */
	#round = 0;
	/** A snapshot was handed out in the current synchronous run. */
	#handedOut = false;
	/** What the environment and the `_FILE` files hold. */
	readonly #named = new HeldSet();
	/** What the global secrets.yml holds. */
	readonly #global = new HeldSet();
	/** Each cwd's project secrets.yml, by resolved cwd. */
	readonly #projects = new Map<string, ProjectState>();
	/** The mask of every cwd whose project secrets.yml holds nothing, and the additions it was built from. */
	#shared: SessionStoreMask | undefined;
	#sharedAdditions = 0;
	readonly #namedSources = new Map<string, HeldSource>();
	/** Env and file sources held so far, by kind: the last `#<n>` position given. */
	readonly #namedCounts = { env: 0, file: 0 };
	/** Stamp of each `_FILE` variable's file at its last read, by variable name. */
	readonly #fileStamps = new Map<string, string>();
	/** Stamp of each secrets.yml at its last read, by path. */
	readonly #secretsFileStamps = new Map<string, string>();
	/** Last logged reason a source gave no value, by {@link #reasonKey}. */
	readonly #loggedReasons = new Map<string, string>();

	constructor(options: SessionStoreMaskerOptions) {
		this.#env = options.env ?? (() => process.env);
		this.#agentDir = options.agentDir;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * The mask for a writer in `cwd`: the environment values, the `_FILE` values, the global
	 * secrets.yml and the project secrets.yml of `cwd`, never that of another cwd. Every cwd whose
	 * project secrets.yml holds nothing shares one mask. A mask is built at the first call that
	 * needs it and again once a source it holds has given a new value; the sources are read again
	 * at most once a minute, never twice in one synchronous run.
	 *
	 * Throws when the mask cannot be built, so the write fails rather than store a value raw: a
	 * mask that lacks a value the masker has taken in is never returned, and the next call builds
	 * again.
	 */
	snapshot(cwd: string): SessionStoreMask {
		const dir = path.resolve(cwd);
		if (this.#round === 0 || (!this.#handedOut && this.#now() - this.#refreshedAt >= REFRESH_INTERVAL_MS)) {
			this.#refreshedAt = this.#now();
			this.#round++;
			this.#collect();
		}
		let project = this.#projects.get(dir);
		if (project === undefined) {
			project = { held: new HeldSet(), round: 0, served: false, additions: 0 };
			this.#projects.set(dir, project);
		}
		const { held } = project;
		// Once per refresh, at the cwd's first write after it; a new cwd's file is read at once.
		if (project.round !== this.#round) {
			project.round = this.#round;
			collectSafely("secrets.yml", () => this.#collectSecretsFile(projectSecretsFilePath(dir), "project", held));
		}
		// Each mask is built whole before it replaces the last one: after a build that throws, the
		// additions still count as not built, so the next call builds again.
		const stage = project.served ? "refresh" : "build";
		let mask: SessionStoreMask;
		if (held.additions === 0) {
			const additions = this.#named.additions + this.#global.additions;
			if (this.#shared === undefined || this.#sharedAdditions !== additions) {
				this.#shared = this.#build([this.#named, this.#global], stage);
				this.#sharedAdditions = additions;
			}
			mask = this.#shared;
		} else {
			const additions = this.#named.additions + held.additions + this.#global.additions;
			if (project.mask === undefined || project.additions !== additions) {
				project.mask = this.#build([this.#named, held, this.#global], stage);
				project.additions = additions;
			}
			mask = project.mask;
		}
		project.served = true;
		if (!this.#handedOut) {
			this.#handedOut = true;
			queueMicrotask(() => {
				this.#handedOut = false;
			});
		}
		return mask;
	}

	/** Reads the sources every cwd shares: the environment, the `_FILE` files and the global secrets.yml. */
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
				if (value && isSecretFileEnvName(name)) this.#collectFile(name, value);
			}
		});
		collectSafely("secrets.yml", () =>
			this.#collectSecretsFile(globalSecretsFilePath(this.#agentDir), "global", this.#global),
		);
	}

	#collectFile(name: string, value: string): void {
		const filePath = path.resolve(value);
		let read: SecretFileRead | UnchangedSecretFile;
		try {
			// A file whose stamp has not changed is neither opened nor read: what it gave still holds.
			read = readSecretFileSync(filePath, {
				maxBytes: MAX_FILE_SOURCE_BYTES,
				unchanged: stat => this.#fileStamps.get(name) === stampOf(filePath, stat),
			});
		} catch (err) {
			// Not stamped, so the next refresh tries again even when the file has not changed.
			if (isEnoent(err) || isEnotdir(err)) this.#skipFile(name, "missing");
			else this.#failedRead("file", name, err);
			return;
		}
		if ("unchanged" in read) return;
		this.#fileStamps.set(name, stampOf(filePath, read.stat));
		if ("skip" in read) {
			this.#skipFile(name, read.skip, read.oversized);
			return;
		}
		const content = read.text.trim();
		if (content.length < MIN_ENV_VALUE_LENGTH) {
			this.#skipFile(name, `shorter than ${MIN_ENV_VALUE_LENGTH} characters`);
			return;
		}
		this.#loggedReasons.delete(this.#reasonKey("file", name));
		this.#holdNamed("file", name, content);
		for (const line of content.split("\n")) {
			for (const password of connectionUrlPasswords(line.trim())) this.#holdNamed("file", name, password);
		}
	}

	/** Logs once why the file of `name` gives no value: as a warning when it was skipped for its size. */
	#skipFile(name: string, reason: string, oversized = false): void {
		if (!this.#isNews(this.#reasonKey("file", name), reason)) return;
		if (oversized) logger.warn("Session store masking skipped a file", { variable: name, reason });
		else logger.debug("Session store masking skipped a file", { variable: name, reason });
	}

	/** Logs once why a secrets.yml gives no value: as a warning when it grew while it was read. */
	#skipSecretsFile(filePath: string, reason: string, oversized: boolean): void {
		if (!this.#isNews(this.#reasonKey("secrets.yml", filePath), reason)) return;
		if (oversized) logger.warn("Session store masking skipped a secrets.yml", { path: filePath, reason });
		else logger.debug("Session store masking skipped a secrets.yml", { path: filePath, reason });
	}

	/** Logs a read that failed, with its source and its cause; the values held so far stay masked. */
	#failedRead(kind: "file" | "secrets.yml", source: string, err: unknown): void {
		// The error code of a filesystem error, which names no path.
		const cause = isFsError(err) ? err.code : String(err);
		if (this.#isNews(this.#reasonKey(kind, source), `unreadable (${cause})`)) {
			logger.warn("Session store masking could not read a source", { kind, source, cause });
		}
	}

	/** The key of `source`'s last logged reason: a `_FILE` variable's name, or a secrets.yml's path. */
	#reasonKey(kind: "file" | "secrets.yml", source: string): string {
		return `${kind}:${source}`;
	}

	/** Whether `reason` differs from the last one logged under `key`: each is logged once. */
	#isNews(key: string, reason: string): boolean {
		if (this.#loggedReasons.get(key) === reason) return false;
		this.#loggedReasons.set(key, reason);
		return true;
	}

	#collectSecretsFile(filePath: string, scope: "project" | "global", held: HeldSet): void {
		let read: SecretFileRead | UnchangedSecretFile;
		try {
			// A file whose stamp has not changed is neither opened nor read: what it gave still holds. A
			// secrets.yml of any size is read: only a `_FILE` content is bounded.
			read = readSecretFileSync(filePath, {
				unchanged: stat => this.#secretsFileStamps.get(filePath) === stampOf(filePath, stat),
			});
		} catch (err) {
			// Not stamped, so the next refresh reads the file again even when it has not changed. A
			// missing file clears the last reason, so a reason given after it is logged again.
			if (isEnoent(err) || isEnotdir(err)) this.#loggedReasons.delete(this.#reasonKey("secrets.yml", filePath));
			else this.#failedRead("secrets.yml", filePath, err);
			return;
		}
		if ("unchanged" in read) return;
		// Stamped now that it is read or skipped: the same file gives the same result next time, a
		// text that does not parse included.
		this.#secretsFileStamps.set(filePath, stampOf(filePath, read.stat));
		if ("skip" in read) {
			this.#skipSecretsFile(filePath, read.skip, read.oversized);
			return;
		}
		this.#loggedReasons.delete(this.#reasonKey("secrets.yml", filePath));
		for (const { entry, position } of parseSecretsFileText(read.text, filePath)) {
			this.#holdEntry(held, entry, `${scope}#${position}`);
		}
	}

	#holdEntry(held: HeldSet, entry: SecretEntry, fallback: string): void {
		const friendlyName =
			entry.friendlyName === undefined ? undefined : sanitizeSecretFriendlyName(entry.friendlyName);
		const source = (): HeldSource =>
			held.addSource({ kind: "secrets.yml", name: friendlyName ?? fallback, fallback });
		if (entry.type === "plain") {
			// Obfuscate-mode plain values below the floor are never masked by the obfuscator either.
			if (entry.mode === "replace" || entry.content.length >= MIN_OBFUSCATE_SECRET_LEN) {
				held.holdValue(entry.content, source);
			}
			return;
		}
		held.holdRegex(compileSecretRegex(entry.content, entry.flags), source);
	}

	#holdNamed(kind: "env" | "file", name: string, value: string): void {
		this.#named.holdValue(value, () => {
			const key = `${kind}:${name}`;
			let source = this.#namedSources.get(key);
			if (source === undefined) {
				const position = ++this.#namedCounts[kind];
				source = this.#named.addSource({
					kind,
					name: name.replace(UNSAFE_NAME_CHARS, "_"),
					fallback: `#${position}`,
				});
				this.#namedSources.set(key, source);
			}
			return source;
		});
	}

	/**
	 * A snapshot of `sets`. Throws, after one warning that names the cause, when it cannot be built:
	 * the caller's write then fails rather than store a value raw.
	 */
	#build(sets: readonly HeldSet[], stage: "build" | "refresh"): SessionStoreMask {
		try {
			return this.#assemble(sets);
		} catch (err) {
			logger.warn(`Session store masking ${stage} failed; the write fails rather than store a value raw`, {
				error: String(err),
			});
			throw new Error(
				`Session store masking ${stage} failed, so the write fails rather than store a value raw: ${toError(err).message}`,
				{ cause: err },
			);
		}
	}

	#assemble(sets: readonly HeldSet[]): SessionStoreMask {
		// The first set that holds a value or a regex names it; a source that names none is not listed.
		const values = new Map<string, HeldValue>();
		const regexes = new Map<string, HeldRegex>();
		for (const set of sets) {
			for (const [value, held] of set.values) {
				if (!values.has(value)) values.set(value, held);
			}
			for (const [key, held] of set.regexes) {
				if (!regexes.has(key)) regexes.set(key, held);
			}
		}
		const naming = new Set<HeldSource>();
		for (const { source } of values.values()) naming.add(source);
		for (const { source } of regexes.values()) naming.add(source);
		const markers = new Map<HeldSource, string>();
		const sources: SessionStoreMaskSource[] = [];
		const listed = new Set<string>();
		for (const set of sets) {
			for (const source of set.sources) {
				if (!naming.has(source)) continue;
				// Labels are computed over every secret the snapshot holds, so a value added later still never shows in a marker.
				const name = exposesSecret(source.name, values, regexes) ? source.fallback : source.name;
				markers.set(source, `${MARKER_PREFIX}${source.kind}:${name}]`);
				const id = `${source.kind}:${name}`;
				if (listed.has(id)) continue;
				listed.add(id);
				sources.push({ kind: source.kind, name });
			}
		}
		const literals = new Map<string, string>();
		for (const [value, { source }] of values) literals.set(value, markers.get(source)!);
		// JSON text (a structured yield's `<id>.md`, a printed JSON document) holds a value with a
		// quote, a backslash or a control character only escaped, so the escaped form is held too,
		// with the same marker; a held value of that text keeps its own. A marker needs no escape:
		// masked JSON stays valid.
		for (const { source, escaped } of values.values()) {
			if (!literals.has(escaped)) literals.set(escaped, markers.get(source)!);
		}
		const matcher = buildSessionStoreMatcher(
			literals,
			Array.from(regexes.values(), ({ regex, source }) => ({ regex, marker: markers.get(source)! })),
		);
		logger.info("Session store masking sources", { sources: [...listed] });
		return new SessionStoreMask(matcher, sources, literals.size === 0 && regexes.size === 0);
	}
}

const processMaskers = new Map<string, SessionStoreMasker>();

/**
 * The process-wide masker for `agentDir`, shared by every session writer of that agent dir: one
 * masker per agent dir, a snapshot per `cwd`. Whether a writer masks is up to its session's
 * `secrets.maskSessionStore` (`SessionManager.storeMask`).
 */
export function processSessionStoreMasker(agentDir: string): SessionStoreMasker {
	let masker = processMaskers.get(agentDir);
	if (masker === undefined) {
		masker = new SessionStoreMasker({ agentDir });
		processMaskers.set(agentDir, masker);
	}
	return masker;
}

/**
 * The mask a session's stored writes apply for `cwd`, or `null` while its setting is off; off, no
 * masker is built. `agentDir` is the session's own, whose secrets.yml its provider obfuscator reads.
 * `null`, not `undefined`, as `SessionManager.storeMask` documents.
 */
export function sessionStoreMaskFor(enabled: boolean, cwd: string, agentDir: string): SessionStoreMask | null {
	return enabled ? processSessionStoreMasker(agentDir).snapshot(cwd) : null;
}

/**
 * Makes the history.db `record` write of session `sessionId`: `write` gets `text` through the mask
 * `owner.storeMask()` gives (`text` itself while masking is off). A mask that cannot be built, or
 * that fails on `text`, skips that write and logs it: it is never made with the value unmasked,
 * and a history.db write never fails the rename or the recap it serves.
 */
export function recordMaskedHistory(
	owner: { storeMask(): SessionStoreMask | null },
	text: string,
	sessionId: string,
	record: "title" | "recap",
	write: (stored: string) => void,
): void {
	let stored: string;
	try {
		stored = owner.storeMask()?.maskText(text) ?? text;
	} catch (err) {
		logger.warn("Session store masking failed; skipped a history.db write", {
			sessionId,
			record,
			error: toError(err).message,
		});
		return;
	}
	write(stored);
}

/** What a session binds its session manager's store masking to (`SessionManager.setStoreMasking`). */
export interface StoreMaskingBinding {
	/** The session's `secrets.maskSessionStore`, read at each write. */
	readonly enabled: () => boolean;
	/** The session's agent dir, whose secrets.yml the mask holds. */
	readonly agentDir: string;
}

/** The store masking binding of the session whose settings are `settings`: its setting and its agent dir. */
export function storeMaskingOf(settings: Settings): StoreMaskingBinding {
	return { enabled: () => cfgSecretsMaskSessionStore.get(settings), agentDir: settings.getAgentDir() };
}

/** The mask a writer for `cwd` applies under `settings` now, or `null` while their `secrets.maskSessionStore` is off. */
export function settingsStoreMask(settings: Settings, cwd: string): SessionStoreMask | null {
	return sessionStoreMaskFor(cfgSecretsMaskSessionStore.get(settings), cwd, settings.getAgentDir());
}
