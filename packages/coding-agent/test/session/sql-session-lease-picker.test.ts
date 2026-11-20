/**
 * `omp --resume` (the startup picker) with `autoResume` on, under SQL session storage: the launch first resumes and
 * claims the most recent session of its directory on its own, then the picker opens. When another session is picked,
 * the launch must give the first session's lease back: it no longer runs that session, so another holder (a second
 * store, as a second process holds one) can claim it at once. When that same session is picked, the launch keeps it:
 * the same session id, its claim held (another holder is refused) and its content as stored, never a move to a new
 * id, which a second manager of the same session would cause wherever one session has one writer. The fixture runs
 * the CLI's own startup (`runRootCommand`) in a process of its own, in the default session directory of its working
 * directory (a `--session-dir` would start a new session instead of resuming one), with the picker answered by the
 * fixture and the agent session never started: its `createAgentSession` reads the lease rows and tries the other
 * holder's claim, then stops the launch. PostgreSQL and MySQL run when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a server. On file storage under `OMP_SESSION_EXCLUSIVE=1`, a pick of that same
 * session is an explicit resume: it waits for another process's lease on it, as `--resume <id>` does.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cliDatabase, LeaseProcess, ROW_LEASE_BACKENDS, transcript } from "./sql-session-lease-fixture";

const sourceDir = path.resolve(import.meta.dir, "../../src");
const RECENT = "01a1fa00-0000-7000-8000-000000000001";
const PICKED = "01a1fa00-0000-7000-8000-000000000002";

interface Observation {
	error?: string;
	offered?: string[];
	rowsRecentAtPicker?: number;
	sessionId?: string;
	/** The file the launch wrote its turn to (file storage). */
	sessionFile?: string;
	rowsRecent?: number;
	rowsPicked?: number;
	otherClaimsRecent?: boolean;
	recentContentKept?: boolean;
}

/** The launch's startup in a process of its own, the picker answering `pick`: what the picker and `createAgentSession` saw. */
async function runLaunch(dir: TempDir, adapter: string, dsn: string, pick: string): Promise<Observation> {
	const dsnFile = dir.join("dsn");
	await Bun.write(dsnFile, `${dsn}\n`);
	const script = `
		import { SQL } from "bun";
		import { parseArgs } from ${JSON.stringify(path.join(sourceDir, "cli/args.ts"))};
		import { runRootCommand } from ${JSON.stringify(path.join(sourceDir, "main.ts"))};
		import { Settings } from ${JSON.stringify(path.join(sourceDir, "config/settings.ts"))};
		import { AuthStorage } from ${JSON.stringify(path.join(sourceDir, "session/auth-storage.ts"))};
		import { SessionManager } from ${JSON.stringify(path.join(sourceDir, "session/session-manager.ts"))};
		import { installConfiguredSessionStorage } from ${JSON.stringify(path.join(sourceDir, "session/session-storage-config.ts"))};
		import { SqlSessionStorage } from ${JSON.stringify(path.join(sourceDir, "session/sql-session-storage.ts"))};
		const dsn = ${JSON.stringify(dsn)};
		const RECENT = ${JSON.stringify(RECENT)};
		const PICKED = ${JSON.stringify(PICKED)};
		const statement = ${JSON.stringify(`SELECT holder FROM omp_session_leases WHERE session_id = ${adapter === "postgres" ? "$1" : "?"}`)};
		const rows = async id => {
			const sql = new SQL(dsn);
			try { return (await sql.unsafe(statement, [id])).length; } finally { await sql.end(); }
		};
		const cwd = process.cwd();
		// Two stored sessions of this directory, in its default session directory; the one written last is the most
		// recent. Written by a store that claims nothing.
		await installConfiguredSessionStorage(cwd);
		const sessionDir = SessionManager.getDefaultSessionDir(cwd);
		const fileOf = (stamp, id) => sessionDir + "/2026-11-19T00-00-0" + stamp + "-000Z_" + id + ".jsonl";
		const transcript = (id, text) => [
			{ type: "session", version: 3, id, timestamp: "2026-11-19T00:00:00.000Z", cwd },
			{ type: "message", id: "m1", parentId: null, timestamp: "2026-11-19T00:00:00.000Z",
				message: { role: "user", content: text, timestamp: 1 } },
		].map(row => JSON.stringify(row)).join("\\n") + "\\n";
		const writer = await SqlSessionStorage.create({ client: new SQL(dsn), claims: false });
		await writer.writeText(fileOf(1, PICKED), transcript(PICKED, "the one picked"));
		await writer.drain();
		await Bun.sleep(50);
		await writer.writeText(fileOf(2, RECENT), transcript(RECENT, "the most recent"));
		await writer.drain();
		// A terminal on stdin: the launch reads no piped prompt; --print keeps it headless.
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const settings = Settings.isolated({
			autoResume: true, retry: { enabled: false }, marketplace: { autoUpdate: "off" },
			telemetry: { otlpExportEnabled: false },
		});
		const authStorage = await AuthStorage.create(":memory:");
		const args = ["--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--no-extensions",
			"--resume", "--print", "hello"];
		const stop = new Error("fixture stops the launch before the agent session");
		const observation = {};
		let manager;
		try {
			await runRootCommand(parseArgs(args), args, {
				settings,
				discoverAuthStorage: async () => authStorage,
				selectSession: async sessions => {
					observation.offered = sessions.map(session => session.id).sort();
					observation.rowsRecentAtPicker = await rows(RECENT);
					return sessions.find(session => session.id === ${JSON.stringify(pick)}) ?? null;
				},
				createAgentSession: async options => {
					manager = options.sessionManager;
					observation.sessionId = manager?.getSessionId();
					observation.rowsRecent = await rows(RECENT);
					observation.rowsPicked = await rows(PICKED);
					// Another holder: a store of its own, as a second process holds one, claiming without a wait.
					const other = await SqlSessionStorage.create({ client: new SQL(dsn), claims: true });
					const release = await other.acquireSessionClaim(RECENT, fileOf(2, RECENT));
					observation.otherClaimsRecent = typeof release === "function";
					const reader = await SqlSessionStorage.create({ client: new SQL(dsn), claims: false });
					observation.recentContentKept = (await reader.readText(fileOf(2, RECENT))) === transcript(RECENT, "the most recent");
					release?.();
					await other.drain();
					throw stop;
				},
			});
		} catch (error) {
			if (error !== stop) observation.error = String((error && error.stack) || error);
		} finally {
			await manager?.close();
			authStorage.close();
		}
		console.log("OBSERVATION:" + JSON.stringify(observation));
		process.exit(0);
	`;
	const home = dir.join("home");
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: dir.path(),
		env: {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
			TMPDIR: process.env.TMPDIR,
			NO_COLOR: "1",
			PI_NO_TITLE: "1",
			OMP_SESSION_STORAGE: "sql",
			OMP_SESSION_SQL_DSN_FILE: dsnFile,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(60_000),
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const line = stdout.split("\n").find(row => row.startsWith("OBSERVATION:"));
	if (exitCode !== 0 || !line) throw new Error(`the launch fixture exited ${exitCode}: ${stderr}\n${stdout}`);
	return JSON.parse(line.slice("OBSERVATION:".length)) as Observation;
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`omp --resume with autoResume on, picking a session (${adapter})`, () => {
		it("gives back the lease of the session it resumed on its own, so another holder claims it at once", async () => {
			using dir = TempDir.createSync("@omp-lease-picker-");
			await using db = await cliDatabase(adapter, url ?? "");
			const observation = await runLaunch(dir, adapter, db.dsn, PICKED);
			console.log(`${adapter} picker, another session: ${JSON.stringify(observation)}`);
			expect(observation).toEqual({
				offered: [RECENT, PICKED].sort(),
				// The launch resumed and claimed the most recent session before the picker opened.
				rowsRecentAtPicker: 1,
				sessionId: PICKED,
				rowsRecent: 0,
				rowsPicked: 1,
				otherClaimsRecent: true,
				recentContentKept: true,
			});
		}, 90_000);

		it("keeps the session it resumed on its own, and that session's claim, when that same session is picked", async () => {
			using dir = TempDir.createSync("@omp-lease-picker-");
			await using db = await cliDatabase(adapter, url ?? "");
			const observation = await runLaunch(dir, adapter, db.dsn, RECENT);
			console.log(`${adapter} picker, the same session: ${JSON.stringify(observation)}`);
			expect(observation).toEqual({
				offered: [RECENT, PICKED].sort(),
				rowsRecentAtPicker: 1,
				sessionId: RECENT,
				rowsRecent: 1,
				rowsPicked: 0,
				otherClaimsRecent: false,
				recentContentKept: true,
			});
		}, 90_000);
	});
}

/**
 * The variables that place a process's profile, and so its sessions, beyond the home and XDG directories both
 * processes of the file-storage case are given: the default profile and the default config directory, whatever the
 * test's own shell sets (a Legion pod sets OMP_PROFILE). The holder, which starts with the test's environment, and
 * the launch, which starts with only what it is given, then name one session directory.
 */
const DEFAULT_PLACEMENT = { OMP_PROFILE: "default", PI_PROFILE: "default", PI_CONFIG_DIR: ".omp" } as const;

/**
 * The launch's startup on file storage under `OMP_SESSION_EXCLUSIVE=1`, in `dir` with `home`'s directories (those a
 * `LeaseProcess` started with `home` and {@link DEFAULT_PLACEMENT} uses), the picker answering session `id`; once
 * the agent session would start it writes one turn and stops. The running process, whose stderr the caller reads.
 */
function startFileLaunch(dir: TempDir, home: string, id: string): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const script = `
		import { parseArgs } from ${JSON.stringify(path.join(sourceDir, "cli/args.ts"))};
		import { runRootCommand } from ${JSON.stringify(path.join(sourceDir, "main.ts"))};
		import { Settings } from ${JSON.stringify(path.join(sourceDir, "config/settings.ts"))};
		import { AuthStorage } from ${JSON.stringify(path.join(sourceDir, "session/auth-storage.ts"))};
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const settings = Settings.isolated({
			autoResume: true, retry: { enabled: false }, marketplace: { autoUpdate: "off" },
			telemetry: { otlpExportEnabled: false },
		});
		const authStorage = await AuthStorage.create(":memory:");
		const args = ["--no-title", "--no-tools", "--no-skills", "--no-rules", "--no-lsp", "--no-extensions",
			"--resume", "--print", "hello"];
		const stop = new Error("fixture stops the launch before the agent session");
		const observation = {};
		let manager;
		try {
			await runRootCommand(parseArgs(args), args, {
				settings,
				discoverAuthStorage: async () => authStorage,
				selectSession: async sessions => sessions.find(session => session.id === ${JSON.stringify(id)}) ?? null,
				createAgentSession: async options => {
					manager = options.sessionManager;
					observation.sessionId = manager?.getSessionId();
					manager.appendMessage({ role: "user", content: "written by the launch", timestamp: Date.now() });
					await manager.flush();
					observation.sessionFile = manager.getSessionFile();
					throw stop;
				},
			});
		} catch (error) {
			if (error !== stop) observation.error = String((error && error.stack) || error);
		} finally {
			await manager?.close();
			authStorage.close();
		}
		console.log("OBSERVATION:" + JSON.stringify(observation));
		process.exit(0);
	`;
	return Bun.spawn([process.execPath, "--eval", script], {
		cwd: dir.path(),
		env: {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: path.join(home, "agent"),
			XDG_CONFIG_HOME: path.join(home, "config"),
			XDG_DATA_HOME: path.join(home, "data"),
			XDG_STATE_HOME: path.join(home, "state"),
			XDG_CACHE_HOME: path.join(home, "cache"),
			TMPDIR: process.env.TMPDIR,
			...DEFAULT_PLACEMENT,
			NO_COLOR: "1",
			PI_NO_TITLE: "1",
			OMP_SESSION_EXCLUSIVE: "1",
			// The session-owner lease directory the holder (started with this test's environment) uses.
			...(process.env.PI_TEST_SESSION_OWNERS_DIR
				? { PI_TEST_SESSION_OWNERS_DIR: process.env.PI_TEST_SESSION_OWNERS_DIR }
				: {}),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		signal: AbortSignal.timeout(60_000),
	});
}

describe("omp --resume with autoResume on, picking the session it resumed, under OMP_SESSION_EXCLUSIVE=1 (file storage)", () => {
	it("waits for another process's lease on that session, then writes it under its own id", async () => {
		using dir = TempDir.createSync("@omp-lease-picker-file-");
		const home = dir.join("home");
		const config = { dsn: "", table: "", leaseTable: "", storage: "file" as const };
		await using holder = await LeaseProcess.start(config, home, DEFAULT_PLACEMENT);
		const { sessionDir } = await holder.run({ op: "defaultSessionDir", cwd: dir.path() });
		if (!sessionDir) throw new Error("the holder named no session directory");
		// A new id each run: a file lease is keyed by the session id alone, machine-wide.
		const id = Bun.randomUUIDv7();
		const file = path.join(sessionDir, `2026-11-19T00-00-00-000Z_${id}.jsonl`);
		await Bun.write(file, transcript(id, "the most recent", dir.path()));
		expect((await holder.run({ op: "hold", file, sessionDir })).sessionId).toBe(id);

		const launch = startFileLaunch(dir, home, id);
		const waitLine = `Session ${id} is held by another omp process; waiting up to 35 s for its lease to go`;
		const decoder = new TextDecoder();
		const reader = launch.stderr.getReader();
		let stderr = "";
		// The holder ends only once the launch says it waits on the holder's lease, or once the launch is over.
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			stderr += decoder.decode(read.value, { stream: true });
			if (stderr.includes(waitLine)) break;
		}
		const waited = stderr.includes(waitLine);
		await holder[Symbol.asyncDispose]();
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			stderr += decoder.decode(read.value, { stream: true });
		}
		const [exitCode, stdout] = await Promise.all([launch.exited, new Response(launch.stdout).text()]);
		const line = stdout.split("\n").find(row => row.startsWith("OBSERVATION:"));
		const observation = line ? (JSON.parse(line.slice("OBSERVATION:".length)) as Observation) : undefined;

		expect({ waited, exitCode, observation }, stderr).toEqual({
			waited: true,
			exitCode: 0,
			observation: { sessionId: id, sessionFile: file },
		});
		expect(await Bun.file(file).text()).toContain("written by the launch");
	}, 90_000);
});
