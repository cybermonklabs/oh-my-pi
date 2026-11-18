/**
 * `omp --session-id <uuid>` starts a new session under an id the launcher chose. It refuses an
 * id a stored session already holds (before any model call), refuses a value that is not a
 * canonical UUID, and pairs with no other session flag. `--resume <id>` opens the session that
 * holds exactly that id, never another one whose id merely starts with it.
 */
import { describe, expect, it, setSystemTime } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { findArchivedSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-archive";
import { resolveResumableSession, resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { readSessionHeaderId } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const SESSION_ID = "019ea530-5e55-7000-8000-00000000c0de";
/** An id that starts with {@link SESSION_ID}: a prefix lookup for that id also matches it. */
const LONGER_ID = `${SESSION_ID}-later`;
/** A second, unrelated session id. */
const OTHER_ID = "019ea530-5e55-7000-8000-00000000beef";
const EARLIER = new Date("2026-11-01T10:00:00.000Z");
const LATER = new Date("2026-11-02T10:00:00.000Z");
const settings = () => Settings.isolated({ "marketplace.autoUpdate": "off" });

/** A stored session with one exchange, named the way the session manager names its files. */
async function storeSession(storage: SessionStorage, dir: string, id: string, cwd: string, at: Date): Promise<string> {
	storage.ensureDirSync(dir);
	const file = path.join(dir, `${at.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
	const stamp = at.toISOString();
	const lines = [
		{ type: "session", version: 3, id, cwd, timestamp: stamp },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: "hello", timestamp: at.getTime() },
		},
		{
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp: stamp,
			message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: at.getTime() },
		},
	];
	await storage.writeText(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

async function sqlStorage(): Promise<SqlSessionStorage> {
	return await SqlSessionStorage.create({ client: new SQL("sqlite::memory:") });
}

/**
 * Run the real CLI entry point with `sessionDir` as its session store and a home of its own: the agent
 * directory, `HOME` and the XDG roots all point into one temporary directory, so the launch writes
 * nothing (presence records, logs, caches) under the developer's real home. Pass `home` to share one
 * home across launches, and `env` for extra variables.
 */
async function launch(
	args: string[],
	sessionDir: string,
	options: { home?: string; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stderr: string }> {
	using ownHome = TempDir.createSync("@omp-session-id-home-");
	const root = options.home ?? ownHome.path();
	const proc = Bun.spawn([process.execPath, cliEntry, "--no-extensions", "--session-dir", sessionDir, ...args], {
		cwd: sessionDir,
		env: {
			...process.env,
			HOME: root,
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			...options.env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return { exitCode, stderr };
}

/** Every file under `dir` whose name is `name`, at any depth. */
function findFiles(dir: string, name: string): string[] {
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name === name)
		.map(entry => path.join(entry.parentPath, entry.name));
}

describe("omp --session-id", () => {
	it("starts a new session under the given id", async () => {
		using dir = TempDir.createSync("@omp-session-id-new-");
		const parsed = parseArgs(["--session-id", SESSION_ID]);
		parsed.sessionDir = dir.path();
		const manager = await createSessionManager(parsed, dir.path(), settings());
		if (!manager) throw new Error("--session-id selected no session: the flag was not applied");
		try {
			expect(manager.getHeader()?.id, "the new session's header id").toBe(SESSION_ID);
			await manager.ensureOnDisk();
			const file = manager.getSessionFile();
			if (!file) throw new Error("the new session has no file");
			expect(path.basename(file)).toEndWith(`_${SESSION_ID}.jsonl`);
			expect(await readSessionHeaderId(file), "the header written to the session file").toBe(SESSION_ID);
		} finally {
			await manager.close();
		}
	});

	it("reserves the id when it creates the session, so a second launch under it is refused", async () => {
		using dir = TempDir.createSync("@omp-session-id-reserve-");
		const launchArgs = (): Args => {
			const parsed = parseArgs(["--session-id", SESSION_ID]);
			parsed.sessionDir = dir.path();
			return parsed;
		};
		const first = await createSessionManager(launchArgs(), dir.path(), settings());
		try {
			// The first launch has not written a turn yet; the id is already taken.
			await expect(createSessionManager(launchArgs(), dir.path(), settings())).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${SESSION_ID}" already exists; resume it with --resume ${SESSION_ID}.`,
			});
			expect(fs.readdirSync(dir.path()).filter(name => name.endsWith(".jsonl"))).toEqual([
				path.basename(first?.getSessionFile() ?? ""),
			]);
		} finally {
			await first?.close();
		}
	});

	it("refuses an id another live process has claimed, before that process writes anything", async () => {
		using dir = TempDir.createSync("@omp-session-id-claimed-");
		let refused: { exitCode: number; stderr: string; files: string[] } | undefined;
		// This test process plays the first launch. While it checks the store it owns the id and has
		// written nothing; a second launch under the id runs in that window.
		const owner = await SessionManager.createWithSessionId(dir.path(), dir.path(), SESSION_ID, async () => {
			const result = await launch(["--session-id", SESSION_ID, "-p", "hello"], dir.path());
			refused = { ...result, files: fs.readdirSync(dir.path()) };
			return false;
		});
		try {
			expect(owner?.getSessionId(), "the first launch got the id").toBe(SESSION_ID);
			expect(refused?.exitCode, refused?.stderr).toBe(1);
			expect(refused?.stderr).toContain(`Session "${SESSION_ID}" already exists`);
			expect(refused?.files, "nothing was written while the second launch ran").toEqual([]);
		} finally {
			await owner?.close();
		}
	}, 30_000);

	it("leaves the terminal's last-session record alone when it refuses an id", async () => {
		using home = TempDir.createSync("@omp-session-id-terminal-");
		using dir = TempDir.createSync("@omp-session-id-crumb-");
		// Zellij's pane outranks tmux's in the terminal identity, so an inherited one is cleared.
		const terminal = { ZELLIJ_PANE_ID: "", ZELLIJ_SESSION_NAME: "", TMUX_PANE: "%e0-session-id" };
		// A first launch in this terminal records its session (the run itself stops at model selection).
		await launch(["--session-id", OTHER_ID, "-p", "hello"], dir.path(), {
			home: home.path(),
			env: terminal,
		});
		const [crumb] = findFiles(home.path(), "tmux-%e0-session-id");
		if (!crumb) throw new Error("the first launch recorded no terminal breadcrumb");
		const before = fs.readFileSync(crumb, "utf8");

		await storeSession(new FileSessionStorage(), dir.path(), SESSION_ID, dir.path(), EARLIER);
		const refused = await launch(["--session-id", SESSION_ID, "-p", "hello"], dir.path(), {
			home: home.path(),
			env: terminal,
		});
		expect(refused.exitCode, refused.stderr).toBe(1);
		expect(fs.readFileSync(crumb, "utf8"), "the refused launch did not replace the terminal's record").toBe(before);
	}, 30_000);

	it("refuses an id a stored session holds, in file storage, before any model call", async () => {
		using dir = TempDir.createSync("@omp-session-id-held-");
		await storeSession(new FileSessionStorage(), dir.path(), SESSION_ID, dir.path(), EARLIER);
		const before = fs.readdirSync(dir.path()).sort();

		const result = await launch(["--session-id", SESSION_ID, "-p", "hello"], dir.path());

		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain(`Session "${SESSION_ID}" already exists; resume it with --resume ${SESSION_ID}.`);
		expect(fs.readdirSync(dir.path()).sort(), "no session file was written").toEqual(before);
	}, 30_000);

	it("refuses an id a stored session holds, in SQL storage: the held lookup matches the exact id", async () => {
		const storage = await sqlStorage();
		const dir = path.resolve("/sessions/session-id-held");
		await storeSession(storage, dir, LONGER_ID, "/work", LATER);
		// A session whose id only starts with the given id does not hold it.
		expect(await resolveResumableSession(SESSION_ID, "/work", dir, storage, { exactId: true })).toBeUndefined();

		await storeSession(storage, dir, SESSION_ID, "/work", EARLIER);
		const held = await resolveResumableSession(SESSION_ID, "/work", dir, storage, { exactId: true });
		expect(held?.session.id).toBe(SESSION_ID);
	});

	it("refuses a value that is no UUID", async () => {
		// Malformed, not lowercase (ids are minted lowercase, so an uppercase id would be a second spelling), empty.
		for (const value of ["not-a-uuid", SESSION_ID.toUpperCase(), ""]) {
			expect(() => parseArgs(["--session-id", value]), JSON.stringify(value)).toThrow(
				`Invalid --session-id value: ${JSON.stringify(value)}. Expected a UUID.`,
			);
		}
		expect(parseArgs(["--session-id", SESSION_ID]).sessionId).toBe(SESSION_ID);

		using dir = TempDir.createSync("@omp-session-id-invalid-");
		const result = await launch(["--session-id", "not-a-uuid", "-p", "hello"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain('Invalid --session-id value: "not-a-uuid". Expected a UUID.');
		expect(fs.readdirSync(dir.path())).toEqual([]);
	}, 30_000);

	it("refuses an invalid value before another session flag acts", async () => {
		using dir = TempDir.createSync("@omp-session-id-invalid-fork-");
		const source = await storeSession(new FileSessionStorage(), dir.path(), LONGER_ID, dir.path(), EARLIER);
		const before = fs.readdirSync(dir.path()).sort();
		const result = await launch(["--session-id", "not-a-uuid", "--fork", source, "-p", "hello"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain('Invalid --session-id value: "not-a-uuid". Expected a UUID.');
		expect(fs.readdirSync(dir.path()).sort(), "the fork wrote no session").toEqual(before);
	}, 30_000);

	it("refuses the flag with no value instead of starting a session under a minted id", async () => {
		expect(() => parseArgs(["-p", "hello", "--session-id"])).toThrow("--session-id requires a UUID.");

		using dir = TempDir.createSync("@omp-session-id-missing-");
		const result = await launch(["-p", "hello", "--session-id"], dir.path());
		expect(result.exitCode, result.stderr).toBe(2);
		expect(result.stderr).toContain("--session-id requires a UUID.");
		expect(fs.readdirSync(dir.path()), "no session file was written").toEqual([]);
	}, 30_000);

	it("refuses --session-id with --resume, --continue, --fork, --no-session and ACP mode", async () => {
		using dir = TempDir.createSync("@omp-session-id-pairs-");
		const other = await storeSession(new FileSessionStorage(), dir.path(), LONGER_ID, dir.path(), EARLIER);
		const before = fs.readdirSync(dir.path()).sort();
		// One row per option `--session-id` refuses; `-r`/`--session` and `-c` parse to `--resume` and `--continue`.
		// ACP mode starts a session per client request, so the id would name none of them.
		const shapes: Array<{ args: string[]; names: string }> = [
			{ args: ["--resume", other], names: "--resume" },
			{ args: ["--restore", other], names: "--restore" },
			{ args: ["--continue"], names: "--continue" },
			{ args: ["--fork", other], names: "--fork" },
			{ args: ["--no-session"], names: "--no-session" },
			{ args: ["--from-claude"], names: "--from-claude" },
			{ args: ["--from-codex"], names: "--from-codex" },
			{ args: ["--mode", "acp"], names: "--mode acp" },
		];
		for (const shape of shapes) {
			const label = shape.args.join(" ");
			const result = await launch(["--session-id", SESSION_ID, ...shape.args, "-p", "hello"], dir.path());
			expect(result.exitCode, `${label}: ${result.stderr}`).toBe(2);
			expect(result.stderr, label).toContain(`--session-id cannot be combined with ${shape.names}`);
			expect(fs.readdirSync(dir.path()).sort(), label).toEqual(before);
		}
	}, 120_000);

	it("is dropped from a relaunch, which restores the session instead", () => {
		expect(restartArgv(["--session-id", SESSION_ID, "--model", "m"], SESSION_ID)).toEqual([
			"--model",
			"m",
			"--restore",
			SESSION_ID,
		]);
	});

	for (const clock of ["distinct milliseconds", "the same millisecond"] as const) {
		it(`lets only one of two concurrent launches under an id go on in SQL storage, at ${clock}`, async () => {
			const storage = await sqlStorage();
			const dir = path.resolve("/sessions/session-id-race");
			const previous = defaultSessionStorage();
			setDefaultSessionStorage(storage);
			// At the same millisecond both launches name the same session file, `<time>_<id>.jsonl`.
			if (clock === "the same millisecond") setSystemTime(LATER);
			const isHeld = async () =>
				(await resolveResumableSession(SESSION_ID, "/work", dir, storage, { exactId: true })) !== undefined;
			let second: SessionManager | undefined;
			try {
				const first = await SessionManager.createWithSessionId("/work", dir, SESSION_ID, async () => {
					const held = await isHeld();
					// The competing launch runs whole between this launch's check and its first write.
					second = await SessionManager.createWithSessionId("/work", dir, SESSION_ID, isHeld);
					return held;
				});
				const accepted = [first, second].filter(manager => manager !== undefined);
				try {
					expect(accepted, "exactly one launch keeps the id").toHaveLength(1);
					await storage.refresh?.();
					const holders = storage
						.listFilesSync(dir, "*.jsonl")
						.filter(file => file.endsWith(`_${SESSION_ID}.jsonl`));
					expect(holders, "one stored session holds the id").toHaveLength(1);
				} finally {
					for (const manager of accepted) await manager.close();
				}
			} finally {
				setSystemTime();
				setDefaultSessionStorage(previous);
			}
		});
	}
});

describe("omp --resume <id>", () => {
	it("resumes an exact id from SQL storage with --resume", async () => {
		const storage = await sqlStorage();
		const dir = path.resolve("/sessions/session-id-resume");
		await storeSession(storage, dir, SESSION_ID, "/work", EARLIER);
		// Newer, so the listing puts it first; its id starts with the one asked for.
		await storeSession(storage, dir, LONGER_ID, "/work", LATER);

		const match = await resolveResumableSession(SESSION_ID, "/work", dir, storage);
		expect(match?.session.id).toBe(SESSION_ID);
	});

	it("never resumes a session whose id only starts with a full id", async () => {
		const storage = await sqlStorage();
		const dir = path.resolve("/sessions/session-id-resume-absent");
		await storeSession(storage, dir, LONGER_ID, "/work", LATER);
		// A full id names one session; a short prefix still selects by prefix.
		expect(await resolveResumableSession(SESSION_ID, "/work", dir, storage)).toBeUndefined();
		const byPrefix = await resolveResumableSession(SESSION_ID.slice(0, 8), "/work", dir, storage);
		expect(byPrefix?.session.id).toBe(LONGER_ID);
	});

	it("resumes an exact id from file storage, never a newer session whose id starts with it", async () => {
		using dir = TempDir.createSync("@omp-session-id-resume-");
		await storeSession(new FileSessionStorage(), dir.path(), SESSION_ID, dir.path(), EARLIER);
		await storeSession(new FileSessionStorage(), dir.path(), LONGER_ID, dir.path(), LATER);

		const parsed = parseArgs(["--resume", SESSION_ID]);
		parsed.sessionDir = dir.path();
		const manager = await createSessionManager(parsed, dir.path(), settings());
		if (!manager) throw new Error("--resume opened no session");
		try {
			expect(manager.getSessionId()).toBe(SESSION_ID);
		} finally {
			await manager.close();
		}
	});
});

describe("an archived session and a full id", () => {
	/** Write `id`'s transcript where `gc --archive` leaves it, under `agentDir`. */
	async function archiveSession(agentDir: string, id: string, at: Date): Promise<void> {
		const dir = path.join(agentDir, "archive", "sessions", "--work--");
		fs.mkdirSync(dir, { recursive: true });
		const stamp = at.toISOString();
		const header = JSON.stringify({ type: "session", version: 3, id, cwd: "/work", timestamp: stamp });
		const name = `${stamp.replace(/[:.]/g, "-")}_${id}.jsonl.gz`;
		fs.writeFileSync(path.join(dir, name), gzipSync(`${header}\n`));
	}

	async function withAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
		using dir = TempDir.createSync("@omp-session-id-archive-");
		const original = getAgentDir();
		setAgentDir(dir.path());
		try {
			return await run(dir.path());
		} finally {
			setAgentDir(original);
		}
	}

	it("resumes only the archive holding exactly that id", async () => {
		await withAgentDir(async agentDir => {
			await archiveSession(agentDir, LONGER_ID, LATER);
			expect(await resolveResumableSession(SESSION_ID, "/work")).toBeUndefined();
			// A short prefix still selects the archive by prefix.
			expect((await resolveResumableSession(SESSION_ID.slice(0, 8), "/work"))?.session.id).toBe(LONGER_ID);

			await archiveSession(agentDir, SESSION_ID, EARLIER);
			const match = await resolveResumableSession(SESSION_ID, "/work");
			expect(match?.scope).toBe("archive");
			expect(match?.session.id).toBe(SESSION_ID);
		});
	});

	it("counts an archived session as holding its id for --session-id", async () => {
		await withAgentDir(async agentDir => {
			await archiveSession(agentDir, LONGER_ID, LATER);
			expect(await resolveResumeTarget(SESSION_ID, "/work", undefined, { exactId: true })).toBeUndefined();
			await archiveSession(agentDir, SESSION_ID, EARLIER);
			expect(await resolveResumeTarget(SESSION_ID, "/work", undefined, { exactId: true })).toBeDefined();
		});
	});

	it("finds only the archive holding exactly a full id, as `omp gc --restore <id>` asks", async () => {
		await withAgentDir(async agentDir => {
			await archiveSession(agentDir, LONGER_ID, LATER);
			expect(await findArchivedSessionFiles(SESSION_ID, agentDir)).toEqual([]);
			await archiveSession(agentDir, SESSION_ID, EARLIER);
			const found = (await findArchivedSessionFiles(SESSION_ID, agentDir)).map(file => path.basename(file));
			expect(found).toEqual([`${EARLIER.toISOString().replace(/[:.]/g, "-")}_${SESSION_ID}.jsonl.gz`]);
			// A short prefix still lists every archive it starts.
			expect(await findArchivedSessionFiles(SESSION_ID.slice(0, 8), agentDir)).toHaveLength(2);
		});
	});
});
