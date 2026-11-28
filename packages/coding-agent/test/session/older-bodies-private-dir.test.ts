/**
 * Where a resumed session keeps the bodies before its cut, and where a full
 * rewrite on indexed storage keeps its body until the store has it, by what
 * the temporary directory holds and whether the account id can be read. A
 * directory there is private only when it is a real directory (not a link to
 * one) this account owns with mode exactly 0700, as the store makes it: the
 * older-entry store and the spool use a file in one, and otherwise keep the
 * bodies compressed in memory (the store) or stream the rewrite from its lines
 * (the spool), warning once each. Where the account id cannot be read
 * (Windows) both keep the bodies in memory and log nothing. Each scenario runs
 * in a process of its own, so a warning logged once per process is that
 * process's first.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { OlderBodiesProbeResult } from "../fixtures/older-bodies-private-dir-probe";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const probePath = path.join(import.meta.dir, "../fixtures/older-bodies-private-dir-probe.ts");
const COLD_WARNING =
	"Older session entries are kept compressed in memory: their store cannot be made under the temporary directory";
const SPOOL_WARNING = "Session rewrites stream straight to the store: their spool file cannot be used";

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

/** The store and spool directories a test puts under the directory standing for `os.tmpdir()`. */
interface PrivateDirs {
	/** The directories' mode bits. */
	mode: number;
	/** The account id the directories are named for; this account's by default. */
	uid?: number;
	/** Make each a link to a directory of this account's with `mode`, made elsewhere. */
	linked?: boolean;
}

/** A session, and a directory standing for `os.tmpdir()` that holds `privateDirs`, or no store or spool directory. */
async function setUp(privateDirs: PrivateDirs | undefined): Promise<{ file: string; tmp: string }> {
	const sessionDir = TempDir.createSync("@omp-private-dir-session-");
	const tmp = TempDir.createSync("@omp-private-dir-tmp-");
	// Removed after `tmp`, whose links name directories in it.
	const linkTargets = TempDir.createSync("@omp-private-dir-link-targets-");
	dirs.push(sessionDir, tmp, linkTargets);
	if (privateDirs) {
		const { mode, uid = process.getuid?.(), linked = false } = privateDirs;
		for (const kind of ["cold", "spool"]) {
			const name = `omp-${kind}-${uid}`;
			const dir = (linked ? linkTargets : tmp).join(name);
			fs.mkdirSync(dir);
			fs.chmodSync(dir, mode);
			if (linked) fs.symlinkSync(dir, tmp.join(name));
		}
	}
	return { file: await writeSession(sessionDir.path()), tmp: tmp.path() };
}

/** What the probe reports when the store and the spool refuse their directories, named for account `uid`. */
function refusedDirs(uid: number | undefined): OlderBodiesProbeResult {
	return {
		resumes: [
			{ storeInMemory: true, coldEntries: 2, readsBack: true },
			{ storeInMemory: true, coldEntries: 2, readsBack: true },
		],
		rewritesStored: [true, true],
		streamed: 2,
		opened: [],
		warnings: [COLD_WARNING, SPOOL_WARNING],
		underTmp: [`omp-cold-${uid}`, `omp-spool-${uid}`],
	};
}

async function probe(scenario: string, tmp: string, file: string): Promise<OlderBodiesProbeResult> {
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
	return JSON.parse(stdout) as OlderBodiesProbeResult;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		for (const name of fs.readdirSync(dir.path())) fs.chmodSync(path.join(dir.path(), name), 0o700);
		dir.removeSync();
	}
});

describe("older entry bodies and rewrite bodies by the temporary directory", () => {
	// Each case here names its directories for the account id and checks them against it; the links of
	// the linked case also need a privilege on Windows, which has no account id.
	describe.skipIf(process.getuid === undefined)("where the account id can be read", () => {
		// If this regresses, a session keeps its older bodies whole in memory, or every rewrite streams
		// from the live entries, on a host whose store and spool directories are exactly as omp makes them.
		it("use a file in a directory this account owns with mode 0700", async () => {
			const { file, tmp } = await setUp({ mode: 0o700 });
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
				streamed: 2,
				opened: [`omp-cold-${uid}`, `omp-cold-${uid}`, `omp-spool-${uid}`, `omp-spool-${uid}`],
				warnings: [],
				underTmp: [`omp-cold-${uid}`, `omp-spool-${uid}`],
			});
			// Every file was unlinked as soon as it was open.
			for (const name of result.underTmp) expect(await fs.promises.readdir(path.join(tmp, name))).toEqual([]);
		}, 30_000);

		// If this regresses, the store or the spool writes unmasked bodies into a directory whose mode omp
		// did not set (owner-only but not 0700), or stops warning, or warns at every resume and rewrite.
		it("keep the bodies in memory and stream the rewrites, warning once each, in an owner-only 0300 directory", async () => {
			const { file, tmp } = await setUp({ mode: 0o300 });
			expect(await probe("owner-only-0300", tmp, file)).toEqual(refusedDirs(process.getuid?.()));
		}, 30_000);

		// If this regresses, the store or the spool follows a link planted under the temporary directory
		// and writes unmasked bodies into whatever directory it names, here one this account owns with
		// mode 0700, so only the link itself is wrong.
		it("keep the bodies in memory and stream the rewrites, warning once each, where the directories are links to 0700 directories of this account's", async () => {
			const { file, tmp } = await setUp({ mode: 0o700, linked: true });
			expect(await probe("linked", tmp, file)).toEqual(refusedDirs(process.getuid?.()));
		}, 30_000);

		// If this regresses, the store or the spool writes unmasked bodies into a directory another account
		// made first under this account's name, which that account can read whatever its mode.
		it("keep the bodies in memory and stream the rewrites, warning once each, in 0700 directories another account owns", async () => {
			// The probe reads this account's id plus one as its own (`other-account`), so the directories
			// named for that id, which this account makes, are another account's to it.
			const other = (process.getuid?.() ?? 0) + 1;
			const { file, tmp } = await setUp({ mode: 0o700, uid: other });
			expect(await probe("other-account", tmp, file)).toEqual(refusedDirs(other));
		}, 30_000);
	});

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
			streamed: 2,
			opened: [],
			warnings: [],
			underTmp: [],
		});
	}, 30_000);
});
