/**
 * Where a resumed session keeps the bodies before its cut, and where a full
 * rewrite on indexed storage keeps its body until the store has it, by what
 * the temporary directory holds and whether the account id can be read. A
 * directory there is private only when it is a real directory this account
 * owns with mode exactly 0700, as the store makes it: the older-entry store
 * and the spool use a file in one, and otherwise keep the bodies compressed in
 * memory (the store) or stream the rewrite from its lines (the spool),
 * warning once each. Where the account id cannot be read (Windows) both keep
 * the bodies in memory and log nothing. Each scenario runs in a process of its
 * own, so a warning logged once per process is that process's first.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Root ignores directory permissions; the owner-only directory cases need an account that does not. */
const RUNS_AS_ROOT = process.getuid?.() === 0;
const probePath = path.join(import.meta.dir, "../fixtures/older-bodies-private-dir-probe.ts");
const COLD_WARNING =
	"Older session entries are kept compressed in memory: their store cannot be made under the temporary directory";
const SPOOL_WARNING = "Session rewrites stream straight to the store: their spool file cannot be used";

interface ProbeResult {
	resumes: Array<{ storeInMemory: boolean; coldEntries: number; readsBack: boolean }>;
	rewritesStored: boolean[];
	opened: string[];
	warnings: string[];
	underTmp: string[];
}

/** A session whose compaction keeps `u2` on: `u1` and `a1` lie before the cut. */
async function writeSession(dir: string): Promise<string> {
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	const reply = (text: string) => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const records = [
		{ type: "message", id: "u1", message: { role: "user", content: `u1 ${BODY}`, timestamp: 1 } },
		{ type: "message", id: "a1", message: reply(`a1 ${BODY}`) },
		{ type: "message", id: "u2", message: { role: "user", content: `u2 ${BODY}`, timestamp: 3 } },
		{ type: "compaction", id: "c1", summary: `c1 ${BODY}`, firstKeptEntryId: "u2", tokensBefore: 1000 },
		{ type: "message", id: "a2", message: reply(`a2 ${BODY}`) },
	];
	const entries = records.map((record, index) => ({
		...record,
		parentId: index === 0 ? null : records[index - 1]!.id,
		timestamp: TIMESTAMP,
	}));
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, [header, ...entries].map(line => `${JSON.stringify(line)}\n`).join(""));
	return file;
}

const dirs: TempDir[] = [];

/** A session, and a directory standing for `os.tmpdir()` that holds this account's store and spool directories with `mode`, or none. */
async function setUp(mode: number | undefined): Promise<{ file: string; tmp: string }> {
	const sessionDir = TempDir.createSync("@omp-private-dir-session-");
	const tmp = TempDir.createSync("@omp-private-dir-tmp-");
	dirs.push(sessionDir, tmp);
	if (mode !== undefined) {
		for (const name of ["cold", "spool"]) {
			const dir = path.join(tmp.path(), `omp-${name}-${process.getuid?.()}`);
			fs.mkdirSync(dir);
			fs.chmodSync(dir, mode);
		}
	}
	return { file: await writeSession(sessionDir.path()), tmp: tmp.path() };
}

async function probe(scenario: string, tmp: string, file: string): Promise<ProbeResult> {
	const child = Bun.spawn([process.execPath, probePath, scenario, tmp, file], {
		cwd: path.join(import.meta.dir, "../../../.."),
		env: { ...process.env, PI_CODING_AGENT_DIR: path.join(path.dirname(file), "agent") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as ProbeResult;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		for (const name of fs.readdirSync(dir.path())) fs.chmodSync(path.join(dir.path(), name), 0o700);
		dir.removeSync();
	}
});

describe("older entry bodies and rewrite bodies by the temporary directory", () => {
	// If this regresses, a session keeps its older bodies whole in memory, or every rewrite streams
	// from the live entries, on a host whose store and spool directories are exactly as omp makes them.
	it.skipIf(RUNS_AS_ROOT)(
		"use a file in a directory this account owns with mode 0700",
		async () => {
			const { file, tmp } = await setUp(0o700);
			const result = await probe("private", tmp, file);
			const uid = process.getuid?.();
			expect({
				...result,
				opened: result.opened.map(name => path.dirname(name)),
			}).toEqual({
				resumes: [
					{ storeInMemory: false, coldEntries: 2, readsBack: true },
					{ storeInMemory: false, coldEntries: 2, readsBack: true },
				],
				rewritesStored: [true, true],
				opened: [`omp-cold-${uid}`, `omp-cold-${uid}`, `omp-spool-${uid}`, `omp-spool-${uid}`],
				warnings: [],
				underTmp: [`omp-cold-${uid}`, `omp-spool-${uid}`],
			});
			// Every file was unlinked as soon as it was open.
			for (const name of result.underTmp) expect(fs.readdirSync(path.join(tmp, name))).toEqual([]);
		},
		30_000,
	);

	// If this regresses, the store or the spool writes unmasked bodies into a directory whose mode omp
	// did not set (owner-only but not 0700), or stops warning, or warns at every resume and rewrite.
	it.skipIf(RUNS_AS_ROOT)(
		"keep the bodies in memory and stream the rewrites, warning once each, in an owner-only 0300 directory",
		async () => {
			const { file, tmp } = await setUp(0o300);
			const result = await probe("owner-only-0300", tmp, file);
			expect(result).toEqual({
				resumes: [
					{ storeInMemory: true, coldEntries: 2, readsBack: true },
					{ storeInMemory: true, coldEntries: 2, readsBack: true },
				],
				rewritesStored: [true, true],
				opened: [],
				warnings: [COLD_WARNING, SPOOL_WARNING],
				underTmp: [`omp-cold-${process.getuid?.()}`, `omp-spool-${process.getuid?.()}`],
			});
		},
		30_000,
	);

	// If this regresses, a session where the account id cannot be read (Windows) writes its older
	// bodies or its rewrites to files under the temporary directory, or logs a warning for a host
	// that has nothing wrong with it.
	it("keep the bodies compressed in memory, make no file and log nothing where the account id cannot be read", async () => {
		const { file, tmp } = await setUp(undefined);
		const result = await probe("no-account-id", tmp, file);
		expect(result).toEqual({
			resumes: [
				{ storeInMemory: true, coldEntries: 2, readsBack: true },
				{ storeInMemory: true, coldEntries: 2, readsBack: true },
			],
			rewritesStored: [true, true],
			opened: [],
			warnings: [],
			underTmp: [],
		});
	}, 30_000);
});
