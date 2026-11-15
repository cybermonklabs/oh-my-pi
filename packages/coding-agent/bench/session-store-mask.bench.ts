/**
 * Benchmark: what masking held secrets (`secrets.maskSessionStore`) costs a session writer.
 *
 * Each case runs with masking off and on in one process: every session manager here is bound
 * (`SessionManager.setStoreMasking`) to one switch the runs flip, as a session binds its manager to
 * its `secrets.maskSessionStore`, and every write takes its mask from the manager's `storeMask()`.
 * The process masker reads only what this bench makes: `process.env` is emptied and refilled
 * with synthetic variables, and the agent dir points into a scratch directory. Sessions live in
 * `MemorySessionStorage`, so no disk I/O is timed.
 *
 * Maskers:
 * - typical: nine held values, as on a pod: three `*_TOKEN_FILE` variables (each path, by the name
 *   rule, and each file's 26-48 character value), one `*_KEY_DIR` path, and one connection-URL
 *   file (the URL and its password).
 * - heavy: the typical sources plus a global secrets.yml of 50 plain values and 5 regexes.
 *
 * Cases, wall-clock ms, median of 5 runs after one warm-up run:
 * 1. build the masker: the first `snapshot()` of a fresh process masker;
 * 2. append one ~2 KB user message holding one secret to an existing session;
 * 3. append one 500,000-character tool result holding one secret;
 * 4. rewrite (`rewriteEntries`) a session of 5,000 entries, at least 100 MiB serialized, in which
 *    one string in ten holds a secret.
 *
 * Self-check: the run fails unless the masked rewrite holds one marker per planted secret and no
 * secret value, the unmasked rewrite holds each planted value as often as it was planted, and each
 * masked append stored a marker where each unmasked append stored the secret. `--no-sources` gives
 * the masker no source, so the self-check must fail: the negative control.
 *
 * Run: cd packages/coding-agent && bun bench/session-store-mask.bench.ts [--no-sources]
 * The commit shown is `BENCH_COMMIT` when set, else "unknown".
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import type { SessionStoreMask } from "../src/secrets/session-store-mask";
import { SessionManager } from "../src/session/session-manager";
import { MemorySessionStorage } from "../src/session/session-storage";
import { countOccurrences } from "../src/tools/jfind/text";

const RUNS = 5;
const ENTRIES = 5_000;
/** One string in this many holds a secret. */
const SECRET_EVERY = 10;
const MESSAGE_CHARS = 4 * 1024;
/** 88 KiB rather than 80: with 80 KiB results the session stays under 100 MiB. */
const TOOL_RESULT_CHARS = 88 * 1024;
const APPEND_MESSAGE_CHARS = 2 * 1024;
/** `MAX_PERSIST_CHARS` in session-persistence.ts: the longest string stored untruncated. */
const APPEND_RESULT_CHARS = 500_000;
const MIN_SESSION_BYTES = 100 * 1024 * 1024;
/** `STREAM_LOAD_THRESHOLD_BYTES` in session-loader.ts. */
const STREAM_LOAD_BYTES = 8 * 1024 * 1024;
const CORPUS_CHARS = 1024 * 1024;
const HEAVY_PLAIN_VALUES = 50;
const HEAVY_REGEXES = 5;
const MARKER_PREFIX = "[REDACTED:";
const NOW = 1_700_000_000_000;
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const WORDS = [
	"the",
	"session",
	"writer",
	"appends",
	"each",
	"entry",
	"after",
	"tool",
	"call",
	"returns",
	"output",
	"file",
	"line",
	"read",
	"write",
	"src/index.ts",
	"src/app/server.ts",
	"function",
	"const",
	"value",
	"return",
	"error",
	"warning",
	"build",
	"test",
	"passed",
	"failed",
	"path",
	"module",
	"import",
	"export",
	"string",
	"number",
	"object",
	"await",
	"result",
	"cache",
	"query",
	"update",
	"select",
	"where",
	"order",
	"limit",
	"request",
	"response",
	"status",
	"200",
	"404",
	"model",
	"context",
];

/** A self-check failure: reported as one message, with a non-zero exit. */
class SelfCheckFailure extends Error {}

/** The setting every bench manager is bound to; {@link measure} turns it on for each masked run. */
let masking = false;

/** `manager`, bound to {@link masking}. */
function bound(manager: SessionManager): SessionManager {
	manager.setStoreMasking(() => masking);
	return manager;
}

/** A masker under test and the session text planted for it. */
interface MaskerSpec {
	name: string;
	/** Global secrets.yml written into each of its agent dirs. */
	secretsYml: string | undefined;
	/** `kind:name` of every source its snapshots must list. */
	sources: string[];
	/** The values it holds; a regex entry is represented by a string it matches. */
	values: string[];
	/** How many of `values` stand for a regex entry. */
	regexes: number;
}

interface Samples {
	off: number[];
	on: number[];
}

interface CaseResult extends Samples {
	label: string;
	masker: string;
}

interface MaskerReport {
	cases: CaseResult[];
	unmaskedBytes: number;
	maskedBytes: number;
	markers: number;
}

/** The secret each planted string holds, and how often each value occurs across them. */
interface Planting {
	secrets: string[];
	occurrences: Map<string, number>;
}

/** mulberry32: the same synthetic values and text on every run. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function randomString(random: () => number, length: number, alphabet: string): string {
	const chars: string[] = [];
	for (let i = 0; i < length; i++) chars.push(alphabet[Math.floor(random() * alphabet.length)]);
	return chars.join("");
}

function buildCorpus(random: () => number): string {
	const parts: string[] = [];
	let length = 0;
	while (length < CORPUS_CHARS) {
		const word = WORDS[Math.floor(random() * WORDS.length)];
		parts.push(word, random() < 0.08 ? "\n" : " ");
		length += word.length + 1;
	}
	return parts.join("");
}

const CORPUS = buildCorpus(seededRandom(0xc0ffee));

/** `chars` characters of ordinary text; a `secret` sits in the middle, between spaces. */
function textOf(chars: number, seed: number, secret?: string): string {
	const offset = (seed * 7_919) % (CORPUS.length - chars);
	if (secret === undefined) return CORPUS.slice(offset, offset + chars);
	const filler = chars - secret.length - 2;
	const head = filler >> 1;
	// `join` gives a flat string, as text decoded from a tool's output is.
	return [CORPUS.slice(offset, offset + head), secret, CORPUS.slice(offset + head, offset + filler)].join(" ");
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: NOW };
}

function assistantMessage(text: string, toolCallId?: string): AssistantMessage {
	return {
		role: "assistant",
		content: toolCallId
			? [
					{ type: "text", text },
					{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/index.ts" } },
				]
			: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "synthetic",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallId ? "toolUse" : "stop",
		timestamp: NOW,
	};
}

function toolResultMessage(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: NOW,
	};
}

/** Writes the typical masker's files; returns its environment, held values and source labels. */
async function writeTypicalSources(
	root: string,
	random: () => number,
): Promise<{ env: Record<string, string>; values: string[]; sources: string[] }> {
	const env: Record<string, string> = {};
	const values: string[] = [];
	const sources: string[] = [];
	for (const [name, length] of [
		["ALPHA", 26],
		["BRAVO", 36],
		["CHARLIE", 48],
	] as const) {
		const variable = `BENCH_${name}_TOKEN_FILE`;
		const file = path.join(root, "sources", `${name.toLowerCase()}.token`);
		const token = randomString(random, length, ALNUM);
		await Bun.write(file, `${token}\n`);
		env[variable] = file;
		// The name rule holds the path; the file source holds what the file contains.
		values.push(file, token);
		sources.push(`env:${variable}`, `file:${variable}`);
	}
	const keyDir = path.join(root, "sources", "keys");
	await fs.mkdir(keyDir, { recursive: true });
	env.BENCH_SIGNING_KEY_DIR = keyDir;
	values.push(keyDir);
	sources.push("env:BENCH_SIGNING_KEY_DIR");
	// The URL API sets the user and the password, so no source line spells a credential URL.
	const url = new URL("postgres://db.invalid:5432/app");
	url.username = "bench";
	url.password = randomString(random, 32, ALNUM);
	const urlFile = path.join(root, "sources", "database.url");
	await Bun.write(urlFile, `${url.href}\n`);
	env.BENCH_DATABASE_URL_FILE = urlFile;
	values.push(url.href, url.password);
	sources.push("file:BENCH_DATABASE_URL_FILE");
	return { env, values, sources };
}

/** A global secrets.yml of 50 plain values and 5 regexes, with its values and source labels. */
function heavySecretsFile(random: () => number): { yml: string; values: string[]; sources: string[] } {
	const lines: string[] = [];
	const values: string[] = [];
	const sources: string[] = [];
	for (let i = 1; i <= HEAVY_PLAIN_VALUES; i++) {
		const value = randomString(random, 20 + (i % 21), ALNUM);
		lines.push("- type: plain", `  content: "${value}"`, `  friendlyName: BenchPlain${i}`);
		values.push(value);
		sources.push(`secrets.yml:BENCHPLAIN${i}`);
	}
	for (let i = 1; i <= HEAVY_REGEXES; i++) {
		lines.push("- type: regex", `  content: "benchrx${i}_[0-9a-f]{24}"`, `  friendlyName: BenchPattern${i}`);
		values.push(`benchrx${i}_${randomString(random, 24, HEX)}`);
		sources.push(`secrets.yml:BENCHPATTERN${i}`);
	}
	return { yml: `${lines.join("\n")}\n`, values, sources };
}

/** Leave exactly `env` in `process.env`: the process masker reads it and must find only the bench's sources. */
function replaceEnvironment(env: Readonly<Record<string, string>>): void {
	for (const name of Object.keys(process.env)) delete process.env[name];
	Object.assign(process.env, env);
}

function plant(values: readonly string[], count: number): Planting {
	const secrets = Array.from({ length: count }, (_, k) => values[k % values.length]);
	const counts = new Map<string, number>();
	// A planted URL also holds its password, so count each value inside every planted secret.
	for (const value of values) {
		counts.set(
			value,
			secrets.reduce((sum, secret) => sum + countOccurrences(secret, value), 0),
		);
	}
	return { secrets, occurrences: counts };
}

/** Fails unless `mask` is `null` with masking off, and with it on lists exactly the bench's sources. */
function expectMask(mask: SessionStoreMask | null, on: boolean, spec: MaskerSpec): void {
	if (!on) {
		if (mask !== null) throw new SelfCheckFailure(`${spec.name}: storeMask gave a mask with masking off`);
		return;
	}
	if (mask === null) throw new SelfCheckFailure(`${spec.name}: storeMask gave no mask with masking on`);
	const listed = mask.sources.map(source => `${source.kind}:${source.name}`);
	const unexpected = listed.filter(label => !spec.sources.includes(label));
	const missing = spec.sources.filter(label => !listed.includes(label));
	if (unexpected.length > 0 || missing.length > 0) {
		throw new SelfCheckFailure(
			`${spec.name}: the masker's sources are not the bench's own (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
		);
	}
}

/** Fails unless the rewrite masked every planted secret (on) or kept every one (off); returns the marker count. */
function checkRewrite(spec: MaskerSpec, planting: Planting, output: string, on: boolean): number {
	const markers = countOccurrences(output, MARKER_PREFIX);
	if (on) {
		const leaked = [...planting.occurrences.keys()].filter(value => output.includes(value)).length;
		if (markers !== planting.secrets.length || leaked > 0) {
			throw new SelfCheckFailure(
				`${spec.name}: the masked rewrite holds ${markers} markers for ${planting.secrets.length} planted secrets, and ${leaked} of ${planting.occurrences.size} secret values`,
			);
		}
		return markers;
	}
	const misplanted = [...planting.occurrences].filter(
		([value, count]) => countOccurrences(output, value) !== count,
	).length;
	if (markers > 0 || misplanted > 0) {
		throw new SelfCheckFailure(
			`${spec.name}: the unmasked rewrite holds ${markers} markers, and ${misplanted} of ${planting.occurrences.size} secret values not as often as planted`,
		);
	}
	return markers;
}

/**
 * Times `run` with masking off and on: one warm-up run of each, then {@link RUNS} of each,
 * alternating which goes first. A full collection before each run keeps the last one's garbage out.
 */
async function measure(run: (on: boolean, warm: boolean) => number | Promise<number>): Promise<Samples> {
	const samples: Samples = { off: [], on: [] };
	const once = async (on: boolean, warm: boolean): Promise<void> => {
		Bun.gc(true);
		masking = on;
		try {
			const elapsed = await run(on, warm);
			if (!warm) (on ? samples.on : samples.off).push(elapsed);
		} finally {
			masking = false;
		}
	};
	await once(false, true);
	await once(true, true);
	for (let i = 0; i < RUNS; i++) {
		for (const on of i % 2 === 0 ? [false, true] : [true, false]) await once(on, false);
	}
	return samples;
}

/** A session of {@link ENTRIES} entries, materialized in memory storage with masking off. */
function buildLargeSession(
	cwd: string,
	sessionsDir: string,
	secrets: readonly string[],
): { manager: SessionManager; storage: MemorySessionStorage; file: string } {
	const storage = new MemorySessionStorage();
	const manager = bound(SessionManager.create(cwd, sessionsDir, storage));
	for (let i = 0; i < ENTRIES; i++) {
		// One string in each block of ten holds a secret, at a position that moves through the block.
		const block = Math.floor(i / SECRET_EVERY);
		const secret = i % SECRET_EVERY === block % SECRET_EVERY ? secrets[block] : undefined;
		// Per five entries: user, assistant, user, assistant calling a tool, its result.
		switch (i % 5) {
			case 4:
				manager.appendMessage(toolResultMessage(`call-${i - 1}`, textOf(TOOL_RESULT_CHARS, i, secret)));
				break;
			case 3:
				manager.appendMessage(assistantMessage(textOf(MESSAGE_CHARS, i, secret), `call-${i}`));
				break;
			case 1:
				manager.appendMessage(assistantMessage(textOf(MESSAGE_CHARS, i, secret)));
				break;
			default:
				manager.appendMessage(userMessage(textOf(MESSAGE_CHARS, i, secret)));
		}
	}
	const file = manager.getSessionFile();
	if (!file) throw new Error("The large session has no session file");
	return { manager, storage, file };
}

async function benchMasker(spec: MaskerSpec, root: string, cwd: string, sessionsDir: string): Promise<MaskerReport> {
	let agentDirs = 0;
	/** A new agent dir: the process masker is per agent dir, so the next snapshot builds a fresh one. */
	const freshAgentDir = async (): Promise<string> => {
		const dir = path.join(root, "agents", `${spec.name}-${agentDirs++}`);
		await fs.mkdir(dir, { recursive: true });
		if (spec.secretsYml !== undefined) await Bun.write(path.join(dir, "secrets.yml"), spec.secretsYml);
		return dir;
	};
	const cases: CaseResult[] = [];

	// Case 1 times a manager's `storeMask()`, the call each of its writes makes, on a fresh process masker.
	const probe = bound(SessionManager.create(cwd, sessionsDir, new MemorySessionStorage()));
	const build = await measure(async on => {
		if (on) setAgentDir(await freshAgentDir());
		const start = Bun.nanoseconds();
		const mask = probe.storeMask();
		const elapsed = (Bun.nanoseconds() - start) / 1e6;
		expectMask(mask, on, spec);
		return elapsed;
	});
	cases.push({ label: "1 build masker (first snapshot)", masker: spec.name, ...build });

	// Cases 2-4 share one process masker, built here.
	setAgentDir(await freshAgentDir());
	masking = true;
	expectMask(probe.storeMask(), true, spec);
	masking = false;

	const appendStorage = new MemorySessionStorage();
	const appendManager = bound(SessionManager.create(cwd, sessionsDir, appendStorage));
	appendManager.appendMessage(userMessage(textOf(MESSAGE_CHARS, 1)));
	// The first assistant message writes the session file; later appends take the append path.
	appendManager.appendMessage(assistantMessage(textOf(MESSAGE_CHARS, 2)));
	// The longest value: its marker is shorter, so the masked 500,000-character result is not truncated either.
	const secret = spec.values.reduce((longest, value) => (value.length > longest.length ? value : longest));
	let seed = 3;
	const append = (message: UserMessage | ToolResultMessage): number => {
		const start = Bun.nanoseconds();
		appendManager.appendMessage(message);
		return (Bun.nanoseconds() - start) / 1e6;
	};
	const appendUser = await measure(() => append(userMessage(textOf(APPEND_MESSAGE_CHARS, seed++, secret))));
	cases.push({ label: "2 append ~2 KB user message", masker: spec.name, ...appendUser });
	const appendResult = await measure(() =>
		append(toolResultMessage(`call-${seed}`, textOf(APPEND_RESULT_CHARS, seed++, secret))),
	);
	cases.push({ label: "3 append 500,000-char tool result", masker: spec.name, ...appendResult });

	const planting = plant(spec.values, ENTRIES / SECRET_EVERY);
	const large = buildLargeSession(cwd, sessionsDir, planting.secrets);
	let unmaskedBytes = 0;
	let maskedBytes = 0;
	let markers = 0;
	const rewrite = await measure(async (on, warm) => {
		const start = Bun.nanoseconds();
		await large.manager.rewriteEntries();
		const elapsed = (Bun.nanoseconds() - start) / 1e6;
		if (warm) {
			// The self-check reads the warm-up rewrites, before any timed run.
			const output = large.storage.readTextSync(large.file);
			const bytes = large.storage.statSync(large.file).size;
			if (on) {
				markers = checkRewrite(spec, planting, output, true);
				maskedBytes = bytes;
			} else {
				checkRewrite(spec, planting, output, false);
				unmaskedBytes = bytes;
				if (bytes < MIN_SESSION_BYTES) throw new Error(`${spec.name}: the large session is only ${mib(bytes)} MiB`);
			}
		}
		return elapsed;
	});
	cases.push({ label: `4 rewrite ${ENTRIES.toLocaleString("en-US")}-entry session`, masker: spec.name, ...rewrite });
	await large.manager.close();
	// Each masked append stored a marker in place of the secret, each unmasked one the secret itself.
	const appended = appendStorage.readTextSync(appendManager.getSessionFile()!);
	const appendsPerMode = 2 * (RUNS + 1);
	const appendMarkers = countOccurrences(appended, MARKER_PREFIX);
	const appendSecrets = countOccurrences(appended, secret);
	if (appendMarkers !== appendsPerMode || appendSecrets !== appendsPerMode) {
		throw new SelfCheckFailure(
			`${spec.name}: ${appendsPerMode} masked and ${appendsPerMode} unmasked appends stored ${appendMarkers} markers and ${appendSecrets} secrets`,
		);
	}
	await appendManager.close();
	return { cases, unmaskedBytes, maskedBytes, markers };
}

function mib(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(1);
}

function ms(value: number): string {
	const size = Math.abs(value);
	return value.toFixed(size < 1 ? 3 : size < 100 ? 2 : 0);
}

function stats(samples: readonly number[]): { min: number; median: number; max: number } {
	const sorted = samples.toSorted((a, b) => a - b);
	return { min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
}

/** Columns padded to their widest cell: the first two left-aligned, the rest right-aligned. */
function formatTable(rows: readonly string[][]): string {
	const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
	return rows
		.map(row =>
			row
				.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])))
				.join("  "),
		)
		.join("\n");
}

async function main(root: string, noSources: boolean, commitOverride: string | undefined): Promise<void> {
	const started = Bun.nanoseconds();
	const commit = commitOverride || "unknown";
	const random = seededRandom(0x5eed);
	const typical = await writeTypicalSources(root, random);
	const heavy = heavySecretsFile(random);
	replaceEnvironment(noSources ? {} : typical.env);
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd, { recursive: true });
	const sessionsDir = path.join(root, "sessions");
	const specs: MaskerSpec[] = [
		{
			name: "typical",
			secretsYml: undefined,
			sources: noSources ? [] : typical.sources,
			values: typical.values,
			regexes: 0,
		},
		{
			name: "heavy",
			secretsYml: noSources ? undefined : heavy.yml,
			sources: noSources ? [] : [...typical.sources, ...heavy.sources],
			values: [...typical.values, ...heavy.values],
			regexes: HEAVY_REGEXES,
		},
	];

	if (noSources)
		console.log("Negative control (--no-sources): the masker holds no source, so the self-check must fail.");
	const reports = new Map<string, MaskerReport>();
	for (const spec of specs) reports.set(spec.name, await benchMasker(spec, root, cwd, sessionsDir));

	const cpus = os.cpus();
	const header = ["case", "masker", "off median", "off min-max", "on median", "on min-max", "on - off"];
	const rows = [header];
	for (const report of reports.values()) {
		for (const result of report.cases) {
			const off = stats(result.off);
			const on = stats(result.on);
			const added = on.median - off.median;
			rows.push([
				result.label,
				result.masker,
				ms(off.median),
				`${ms(off.min)}-${ms(off.max)}`,
				ms(on.median),
				`${ms(on.min)}-${ms(on.max)}`,
				`${added >= 0 ? "+" : ""}${ms(added)}`,
			]);
		}
	}
	console.log("Session store masking: what masking held secrets costs a session writer");
	console.log(
		`Bun ${Bun.version}; CPU ${cpus[0]?.model?.trim() || "unknown"} x${os.availableParallelism()}; commit ${commit}`,
	);
	console.log(
		`Wall-clock ms, median of ${RUNS} runs after one warm-up (min-max); storage MemorySessionStorage, no disk I/O timed`,
	);
	for (const spec of specs) {
		const report = reports.get(spec.name)!;
		console.log(
			`${spec.name}: ${spec.sources.length} sources holding ${spec.values.length - spec.regexes} values and ${spec.regexes} regexes; rewrite of ${ENTRIES.toLocaleString("en-US")} entries: ${mib(report.unmaskedBytes)} MiB unmasked (${(report.unmaskedBytes / STREAM_LOAD_BYTES).toFixed(1)}x the 8 MiB streaming threshold), ${mib(report.maskedBytes)} MiB masked, ${report.markers} markers`,
		);
	}
	console.log("");
	console.log(formatTable(rows));
	console.log("");
	console.log("Self-check passed: each masked rewrite holds one marker per planted secret and no secret value,");
	console.log("each unmasked rewrite holds every planted value as often as it was planted, and each masked");
	console.log("append stored a marker where each unmasked append stored the secret.");
	console.log(`Run time: ${((Bun.nanoseconds() - started) / 1e9).toFixed(1)} s`);
}

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--no-sources")) {
	console.error("Usage: bun bench/session-store-mask.bench.ts [--no-sources]");
	process.exit(2);
}
const commitOverride = process.env.BENCH_COMMIT;
const scratch = TempDir.createSync("@store-masking-bench-");
try {
	await main(scratch.path(), args.includes("--no-sources"), commitOverride);
} catch (error) {
	if (!(error instanceof SelfCheckFailure)) throw error;
	console.error(`Self-check FAILED: ${error.message}`);
	process.exitCode = 1;
} finally {
	scratch.removeSync();
}
