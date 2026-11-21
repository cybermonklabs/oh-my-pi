import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

// Launch-mode selection without a terminal on stdin (scripts, CI, `</dev/null`).
// Before: a bare or prompt-carrying launch chose interactive mode, booted the TUI
// against a closed stdin, and exited 129 with no output.

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const TTY_ERROR = "interactive mode requires a terminal";
const NO_API_KEY = "No API key found for anthropic.";
const MODEL_ARGS = ["--provider", "anthropic", "--model", "claude-sonnet-4-5"];

interface LaunchRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

async function launchWithoutTerminal(
	tempDir: TempDir,
	args: string[],
	{
		extensionDiscovery = false,
		persistSession = false,
		env: extraEnv = {},
	}: { extensionDiscovery?: boolean; persistSession?: boolean; env?: Record<string, string> } = {},
): Promise<LaunchRun> {
	const home = tempDir.join("home");
	fs.mkdirSync(home, { recursive: true });
	// An isolated home, minimal environment, and explicit authenticated model
	// keep prompts off ambient cloud credentials and keyless on-device models.
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		TMPDIR: process.env.TMPDIR,
		TMP: process.env.TMP,
		TEMP: process.env.TEMP,
		SystemRoot: process.env.SystemRoot,
		WINDIR: process.env.WINDIR,
		HOME: home,
		USERPROFILE: home,
		NO_COLOR: "1",
		// CI can run on EC2 even when no credential variables are inherited.
		AWS_EC2_METADATA_DISABLED: "true",
	};
	Object.assign(env, extraEnv);
	const discoveryArgs = extensionDiscovery ? [] : ["--no-extensions"];
	// `--resume` needs the session layer; every other case keeps it off.
	const sessionArgs = persistSession ? [] : ["--no-session"];
	const proc = Bun.spawn([process.execPath, cliEntry, ...sessionArgs, ...discoveryArgs, ...MODEL_ARGS, ...args], {
		cwd: tempDir.path(),
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Write an extension registering flag `name` that reports the value it received
 * at session start or exit — usage failures exit before any session event fires.
 */
async function writeFlagExtension(
	tempDir: TempDir,
	name: string,
	type: "string" | "boolean" = "string",
): Promise<string> {
	const extensionPath = tempDir.join(`${name}-extension.ts`);
	await Bun.write(
		extensionPath,
		[
			"export default function (pi) {",
			`\tpi.registerFlag(${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });`,
			"\tlet reported = false;",
			"\tconst report = () => {",
			"\t\tif (reported) return;",
			"\t\treported = true;",
			`\t\tprocess.stderr.write("EXT_FLAG=" + pi.getFlag(${JSON.stringify(name)}) + "\\n");`,
			"\t};",
			'\tpi.on("session_start", report);',
			'\tprocess.once("exit", report);',
			"}",
		].join("\n"),
	);
	return extensionPath;
}

// Each case cold-starts the CLI graph in a child process; the budget covers that transpile.
describe("launch without a terminal on stdin", () => {
	it("fails a bare launch with a usage error and exit 2", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-bare-");
		const run = await launchWithoutTerminal(tempDir, []);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stdout).toBe("");
	}, 30_000);

	it("runs a prompt argument headless in print mode instead of the TUI", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-prompt-");
		const run = await launchWithoutTerminal(tempDir, ["say ok"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).toContain(NO_API_KEY);
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);

	it("reports an invalid enum value before the terminal requirement", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-bad-mode-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --mode value: "bogus"');
		expect(run.stderr).not.toContain(TTY_ERROR);
	}, 30_000);

	it("delivers an extension-owned --mode before failing on the missing terminal", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-mode-");
		const extensionPath = await writeFlagExtension(tempDir, "mode");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "compact"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).not.toContain("Invalid --mode value");
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stderr).toContain("EXT_FLAG=compact");
	}, 30_000);

	it("treats an extension flag value as a flag value, not a prompt, on a bare launch", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-value-");
		const extensionPath = await writeFlagExtension(tempDir, "spawn-peer");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--spawn-peer", "reviewer"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain(`Error: ${TTY_ERROR}, but stdin is not a TTY.`);
		expect(run.stderr).not.toContain(NO_API_KEY);
		expect(run.stderr).toContain("EXT_FLAG=reviewer");
	}, 30_000);

	it("still runs a real prompt after an extension flag value in print mode", async () => {
		using tempDir = TempDir.createSync("@omp-non-tty-ext-prompt-");
		const extensionPath = await writeFlagExtension(tempDir, "spawn-peer");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--spawn-peer", "reviewer", "say ok"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).toContain(NO_API_KEY);
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);

	it("runs the prompt a boolean extension flag shadowing --mode leaves behind", async () => {
		// Bootstrap reads `--mode compact` as an invalid built-in mode; with the
		// extension's boolean `mode`, `compact` is the prompt.
		using tempDir = TempDir.createSync("@omp-non-tty-ext-bool-");
		const extensionPath = await writeFlagExtension(tempDir, "mode", "boolean");
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "compact"]);

		expect(run.stderr).not.toContain(TTY_ERROR);
		expect(run.stderr).not.toContain("Invalid --mode value");
		expect(run.stderr).toContain(NO_API_KEY);
		expect(run.stderr).toContain("EXT_FLAG=true");
		expect(run.exitCode, run.stderr).toBe(1);
	}, 30_000);
});

describe("mode-dependent guards defer to flag-value errors", () => {
	it("starts rpc-ui with headless extensions instead of rejecting --no-ui", async () => {
		using tempDir = TempDir.createSync("@omp-no-ui-rpc-ui-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "rpc-ui", "--no-ui"]);

		expect(run.stderr).not.toContain("--no-ui requires --mode rpc");
		expect(run.exitCode, run.stderr).toBe(0);
		expect(
			run.stdout
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line)),
		).toContainEqual(expect.objectContaining({ type: "ready" }));
	}, 30_000);

	it("reports an invalid --mode (exit 2) before judging --no-ui against it", async () => {
		using tempDir = TempDir.createSync("@omp-no-ui-bad-mode-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "bogus", "--no-ui"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --mode value: "bogus"');
		expect(run.stderr).not.toContain("--no-ui requires --mode rpc");
	}, 30_000);

	it("still rejects --no-ui outside rpc mode when the flags are otherwise valid", async () => {
		using tempDir = TempDir.createSync("@omp-no-ui-text-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "json", "--no-ui"]);

		expect(run.exitCode, run.stderr).toBe(1);
		expect(run.stderr).toContain("Error: --no-ui requires --mode rpc");
	}, 30_000);
});

describe("ACP launch flag validation", () => {
	it("fails an invalid --thinking before serving when no session can load an extension", async () => {
		using tempDir = TempDir.createSync("@omp-acp-bad-thinking-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "acp", "--thinking", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --thinking value: "bogus"');
		expect(run.stdout).toBe("");
	}, 30_000);

	it("serves without binding an explicit extension that may own the rejected flag", async () => {
		using tempDir = TempDir.createSync("@omp-acp-ext-thinking-");
		const extensionPath = await writeFlagExtension(tempDir, "thinking");
		// Closed stdin ends the ACP transport right after startup, so a served launch exits 0.
		const run = await launchWithoutTerminal(tempDir, ["-e", extensionPath, "--mode", "acp", "--thinking", "bogus"]);

		expect(run.stderr).not.toContain("Invalid --thinking value");
		expect(run.exitCode, run.stderr).toBe(0);
		// The extension reports at exit only if its factory ran: no session opened,
		// so validation must not have bound it either.
		expect(run.stderr).not.toContain("EXT_FLAG=");
	}, 30_000);

	it("leaves the verdict to each session/new when discovery can load per-cwd extensions", async () => {
		// A session cwd's own extension may own `--thinking`; the launch cwd cannot rule it out.
		using tempDir = TempDir.createSync("@omp-acp-discovery-thinking-");
		const run = await launchWithoutTerminal(tempDir, ["--mode", "acp", "--thinking", "bespoke"], {
			extensionDiscovery: true,
		});

		expect(run.stderr).not.toContain("Invalid --thinking value");
		expect(run.exitCode, run.stderr).toBe(0);
	}, 30_000);
});

describe("--export flag validation", () => {
	it("reports an invalid enum value instead of exporting", async () => {
		using tempDir = TempDir.createSync("@omp-export-bad-thinking-");
		const run = await launchWithoutTerminal(tempDir, ["--export", "missing.jsonl", "--thinking", "bogus"]);

		expect(run.exitCode, run.stderr).toBe(2);
		expect(run.stderr).toContain('Error: Invalid --thinking value: "bogus"');
		expect(run.stdout).not.toContain("Exported to:");
	}, 30_000);
});

describe("--export under session.storage: sql", () => {
	it("exports a session the configured SQL storage holds", async () => {
		using tempDir = TempDir.createSync("@omp-export-sql-");
		// What `session.storage: sql` reads: the database named by the connection-string file.
		const database = `sqlite://${tempDir.join("sessions.db")}`;
		const dsnFile = tempDir.join("dsn");
		await Bun.write(dsnFile, `${database}\n`);
		const sessionFile = tempDir.join("sessions/--project--/2026-10-04T00-00-00-000Z_sql-export.jsonl");
		const client = new SQL(database);
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText(
			sessionFile,
			`${[
				{
					type: "session",
					version: 3,
					id: "sql-export",
					timestamp: "2026-10-04T00:00:00.000Z",
					cwd: tempDir.path(),
				},
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-10-04T00:00:01.000Z",
					message: { role: "user", content: "only in the table", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		await client.end();
		const outputPath = tempDir.join("export.html");

		const run = await launchWithoutTerminal(tempDir, ["--export", sessionFile, outputPath], {
			env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
		});

		expect(run.exitCode, run.stderr).toBe(0);
		const html = await Bun.file(outputPath).text();
		const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1] ?? "";
		const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
			header: { id: string };
			entries: { id: string }[];
		};
		expect([data.header.id, data.entries.map(entry => entry.id)]).toEqual(["sql-export", ["u1"]]);
	}, 30_000);
});

describe("--resume under session.storage: sql", () => {
	it("resumes a session the configured SQL storage holds by its id prefix", async () => {
		using tempDir = TempDir.createSync("@omp-resume-sql-");
		const database = `sqlite://${tempDir.join("sessions.db")}`;
		const dsnFile = tempDir.join("dsn");
		await Bun.write(dsnFile, `${database}\n`);
		const sessionDir = tempDir.join("sessions");
		const id = "01a1880d-aaaa-7000-9000-000000000001";
		const sessionFile = path.join(sessionDir, `2026-10-29T00-00-00-000Z_${id}.jsonl`);
		const client = new SQL(database);
		const storage = await SqlSessionStorage.create({ client });
		await storage.writeText(
			sessionFile,
			`${[
				{ type: "session", version: 3, id, timestamp: "2026-10-29T00:00:00.000Z", cwd: tempDir.path() },
				{
					type: "message",
					id: "u1",
					parentId: null,
					timestamp: "2026-10-29T00:00:01.000Z",
					message: { role: "user", content: "only in the table", timestamp: 1 },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		await client.end();

		const run = await launchWithoutTerminal(
			tempDir,
			["--session-dir", sessionDir, "--resume", id.slice(0, 8), "say ok"],
			{ persistSession: true, env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile } },
		);

		// The stored session was found, opened, and carried into the turn: its
		// full id can only come from the row the prefix resolved to.
		expect(run.stderr).not.toContain(`Session "${id.slice(0, 8)}" not found.`);
		expect(run.stderr).toContain(id);
		expect(run.stderr).toContain(NO_API_KEY);
	}, 30_000);
});

// A run that saves no session writes nothing to the store before its first model
// request, so a store that refuses it, or whose table another client holds
// locked, must neither end nor stall it there. The run below has no API key:
// reaching that error is reaching the model request.
describe("--no-session under session.storage: sql", () => {
	const STORE_UNOPENED = "the session database could not be opened";

	it("runs a prompt to its model request when the store refuses the connection", async () => {
		using tempDir = TempDir.createSync("@omp-no-session-sql-refused-");
		const dsnFile = tempDir.join("dsn");
		// Port 1 answers no connection.
		await Bun.write(dsnFile, "postgres://omp@127.0.0.1:1/sessions\n");

		const run = await launchWithoutTerminal(tempDir, ["say ok"], {
			env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
		});

		expect(run.stderr).not.toContain(STORE_UNOPENED);
		expect(run.stderr).toContain(NO_API_KEY);
	}, 30_000);

	it("runs a prompt to its model request while another connection holds the store's write lock", async () => {
		using tempDir = TempDir.createSync("@omp-no-session-sql-locked-");
		const databasePath = tempDir.join("sessions.db");
		const dsnFile = tempDir.join("dsn");
		await Bun.write(dsnFile, `sqlite://${databasePath}\n`);
		// An exclusive transaction keeps every other connection from taking the
		// write lock that making the store's tables needs.
		const holder = new Database(databasePath, { create: true });
		try {
			holder.run("BEGIN EXCLUSIVE");
			const run = await launchWithoutTerminal(tempDir, ["say ok"], {
				env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
			});

			expect(run.stderr).not.toContain(STORE_UNOPENED);
			expect(run.stderr).toContain(NO_API_KEY);
		} finally {
			holder.close();
		}
	}, 30_000);

	it("a run that saves its session still refuses a store that refuses the connection", async () => {
		using tempDir = TempDir.createSync("@omp-session-sql-refused-");
		const dsnFile = tempDir.join("dsn");
		await Bun.write(dsnFile, "postgres://omp@127.0.0.1:1/sessions\n");

		const run = await launchWithoutTerminal(tempDir, ["say ok"], {
			persistSession: true,
			env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
		});

		expect(run.exitCode, run.stderr).toBe(1);
		expect(run.stderr).toContain(STORE_UNOPENED);
		expect(run.stderr).not.toContain(NO_API_KEY);
	}, 30_000);

	it("still refuses a storage kind other than file or sql at start-up", async () => {
		using tempDir = TempDir.createSync("@omp-no-session-bad-kind-");
		const run = await launchWithoutTerminal(tempDir, ["say ok"], { env: { OMP_SESSION_STORAGE: "launch-probe" } });

		expect(run.exitCode, run.stderr).toBe(1);
		expect(run.stderr).toContain('OMP_SESSION_STORAGE is "launch-probe"; expected "file" or "sql"');
		expect(run.stderr).not.toContain(NO_API_KEY);
	}, 30_000);
});

const POSTGRES_URL = process.env.OMP_TEST_SQL_POSTGRES_URL;

// PostgreSQL: another session holds ACCESS EXCLUSIVE on the session table for
// the whole run. The verdict comes from events, not from a clock: the run
// ended, no backend of the store's database waited on a lock while it ran, and
// no backend that was not there before it began connected. The lock is released
// only after the run ends, or as soon as a lock wait is seen (so a run that
// waits ends, and the test reports the wait).
describe.skipIf(!POSTGRES_URL)("--no-session under session.storage: sql on PostgreSQL", () => {
	it("runs a prompt to its model request while another session holds ACCESS EXCLUSIVE on the session table", async () => {
		using tempDir = TempDir.createSync("@omp-no-session-pg-locked-");
		const url = POSTGRES_URL ?? "";
		const dsnFile = tempDir.join("dsn");
		await Bun.write(dsnFile, `${url}\n`);
		// The store's tables exist, as they do in every deployment, so the lock has something to hold.
		const setup = new SQL(url);
		const made = await SqlSessionStorage.create({ client: setup });
		await made.drain();
		await setup.end();

		const holder = new SQL(url, { max: 1 });
		const watcher = new SQL(url, { max: 1 });
		const { promise: lockTaken, resolve: tookLock } = Promise.withResolvers<void>();
		const { promise: release, resolve: releaseLock } = Promise.withResolvers<void>();
		const held = holder.begin(async transaction => {
			await transaction.unsafe("LOCK TABLE omp_session_files IN ACCESS EXCLUSIVE MODE");
			tookLock();
			await release;
		});
		// The client backends of the store's database, other than the watcher's own.
		const backends = async () =>
			(await watcher.unsafe(
				"SELECT pid, wait_event_type FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()",
			)) as Array<{ pid: number; wait_event_type: string | null }>;
		try {
			await lockTaken;
			const before = new Set((await backends()).map(row => row.pid));
			const connected = new Set<number>();
			let sawLockWait = false;
			let ended = false;
			const watch = (async () => {
				while (!ended) {
					for (const row of await backends()) {
						if (!before.has(row.pid)) connected.add(row.pid);
						if (row.wait_event_type === "Lock" && !sawLockWait) {
							sawLockWait = true;
							releaseLock();
						}
					}
					// Another process's backends: no fake clock reaches them, so the watcher paces its reads.
					await Bun.sleep(50);
				}
			})();
			const run = await launchWithoutTerminal(tempDir, ["say ok"], {
				env: { OMP_SESSION_STORAGE: "sql", OMP_SESSION_SQL_DSN_FILE: dsnFile },
			});
			ended = true;
			await watch;

			expect(sawLockWait, "a backend waited on the held lock while the --no-session run ran").toBe(false);
			expect([...connected], "backends that connected while the --no-session run ran").toEqual([]);
			expect(run.stderr).toContain(NO_API_KEY);
		} finally {
			releaseLock();
			await held;
			await holder.end();
			await watcher.end();
		}
	}, 60_000);
});
