/**
 * The CLI gives its session lease back when a signal stops it, in the shape
 * a supervisor runs it: `OMP_SESSION_EXCLUSIVE=1 omp --model @default --resume <id>
 * --mode rpc`, and in print mode. After SIGTERM or SIGINT the lease row is gone,
 * so the next exclusive resume opens the session without waiting on a lease: once
 * the session runs (its `session_shutdown` ran), during a slow `session_start`, and
 * earlier in startup, while an extension's module top level or its async factory
 * is still running, before any mode's teardown exists. After SIGKILL (the
 * control) nothing ran at exit, so the next resume waits on the stopped holder's
 * lease and takes the row over only once it expired (30 s after its last
 * heartbeat, on the database clock). When the database stops answering,
 * postmortem's 10 s cleanup deadline ends the exit, the row stays, and it
 * expires on its own.
 * Every row asserts the cause from the lease itself: the rows the database holds,
 * the resume's own lease-wait line, the row's times on the database clock and the
 * CLI's log; no row times the CLI, which a loaded machine slows.
 * Real processes with the real lease timings, each run on a database of its
 * own under the CLI's default table names. PostgreSQL and MySQL run when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a server;
 * SQLite's claim is an OS lock the kernel drops with the process.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { cliDatabase, cliSession, ROW_LEASE_BACKENDS, TcpProxy } from "./sql-session-lease-fixture";

// These tests wait in real time on purpose: the control waits for the CLI's
// 30 s lease expiry on the database clock, which no fake timer reaches.

const cliEntry = path.resolve(import.meta.dir, "../../src/cli.ts");
const ID = "01a1f500-0000-7000-8000-000000000001";
/**
 * The CLI's lease expiry (`SESSION_LEASE_EXPIRY_MS`): a claim takes over another holder's row only once that
 * row's heartbeat is older than this on the database clock.
 */
const LEASE_EXPIRY_MS = 30_000;
/**
 * How much earlier than the expiry a take-over's `acquired_at` may read. PostgreSQL reads `clock_timestamp()`
 * for the new row's values before it tests the old row's expiry in the same statement, so the value it stores
 * can precede the instant it found the row expired by the time between those two reads.
 */
const TAKE_CLOCK_SLACK_MS = 1000;
/**
 * How long the frozen-database row lets the holder take to exit after SIGTERM before it counts it as hung. It
 * does not time the exit: it only tells an exit that postmortem's 10 s cleanup deadline ended (10.1 to 11.3 s
 * after the signal in the runs, at a load average up to 805 on 288 CPUs) from a holder the deadline never ends,
 * which would stay until the database answers again, and here it never does.
 */
const HUNG_AFTER_MS = 60_000;

/**
 * The holder pid the resume's lease-wait line names, or `undefined` when it printed none. `main.ts`'s
 * `claimOpenedSession` prints the line once, before the first wait, whenever its claim finds another holder's
 * lease live (`SqlSessionStorage`'s `acquire`); a resume that printed none opened without waiting on a lease.
 */
function waitedOnPid(stderr: string): number | undefined {
	const match = /is held by another omp process \(host .*?, pid (\d+)\)/.exec(stderr);
	return match ? Number(match[1]) : undefined;
}

type RpcFrame = { type?: string; id?: string; success?: boolean; data?: Record<string, unknown> };

/** How a marker extension counts the session's lease rows: the DSN file it reads and the statement it runs. */
interface LeaseProbe {
	dsnFile: string;
	statement: string;
}

/**
 * An extension that writes `<markers>.start` when `session_start` runs (then waits `startMs`) and
 * `<markers>.shutdown` when `session_shutdown` runs, so a test sees which of them ran. With `probe`, its
 * `session_shutdown` then waits 1 s and writes `<markers>.rows`, the number of lease rows of {@link ID} it counts
 * on its own connection: 1 while the mode's teardown still runs under the lease, as it must, since the store's own
 * exit release starts only after it.
 */
async function markerExtension(dir: TempDir, name: string, startMs = 0, probe?: LeaseProbe) {
	const markers = dir.join(name);
	const file = dir.join(`${name}.ts`);
	const count = probe
		? `\t\tawait Bun.sleep(1000);\n` +
			`\t\tconst sql = new SQL((await Bun.file(${JSON.stringify(probe.dsnFile)}).text()).trim());\n` +
			`\t\tconst rows = await sql.unsafe(${JSON.stringify(probe.statement)}, [${JSON.stringify(ID)}]);\n` +
			`\t\tawait Bun.write(${JSON.stringify(`${markers}.rows`)}, String(rows.length));\n` +
			`\t\tawait sql.end();\n`
		: "";
	await Bun.write(
		file,
		`import { SQL } from "bun";\n` +
			`export default function (pi) {\n` +
			`\tpi.on("session_start", async () => {\n` +
			`\t\tawait Bun.write(${JSON.stringify(`${markers}.start`)}, String(Date.now()));\n` +
			`\t\tawait Bun.sleep(${startMs});\n` +
			`\t});\n` +
			`\tpi.on("session_shutdown", async () => {\n` +
			`\t\tawait Bun.write(${JSON.stringify(`${markers}.shutdown`)}, String(Date.now()));\n` +
			count +
			`\t});\n` +
			`}\n`,
	);
	return {
		file,
		started: () => Bun.file(`${markers}.start`).exists(),
		shutDown: () => Bun.file(`${markers}.shutdown`).exists(),
		/** The lease rows the probe counted during `session_shutdown`, or `undefined` when it wrote nothing. */
		rowsDuringShutdown: async () =>
			(await Bun.file(`${markers}.rows`).exists()) ? Number(await Bun.file(`${markers}.rows`).text()) : undefined,
	};
}

/**
 * The CLI in a supervisor's exclusive shape, resuming {@link ID}: `--mode rpc`, or print mode (`-p`) with `print`;
 * its frames, and (RPC only) the time its first `get_state` took.
 */
function startRpc(home: string, cwd: string, sessionDir: string, dsnFile: string, extension?: string, print = false) {
	const started = performance.now();
	const proc = Bun.spawn(
		[
			process.execPath,
			cliEntry,
			"--no-title",
			"--no-lsp",
			...(extension ? ["--extension", extension] : ["--no-extensions"]),
			"--no-tools",
			"--model",
			"@default",
			"--session-dir",
			sessionDir,
			"--resume",
			ID,
			...(print ? ["-p", "hello"] : ["--mode", "rpc"]),
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: process.env.TMPDIR,
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
				OMP_SESSION_STORAGE: "sql",
				OMP_SESSION_SQL_DSN_FILE: dsnFile,
				OMP_SESSION_EXCLUSIVE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (print) proc.stdin.end();
	const frames = readJsonl<RpcFrame>(proc.stdout);
	const stderr = new Response(proc.stderr).text();
	/** The first `get_state` answer, and the milliseconds from the spawn to it. */
	const state = (async () => {
		for (;;) {
			const next = await frames.next();
			if (next.done) throw new Error(`RPC output ended: ${await stderr}`);
			if (next.value.type === "ready") {
				proc.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
				proc.stdin.flush();
			}
			if (next.value.type === "response" && next.value.id === "state") {
				return { data: next.value.data ?? {}, ms: Math.round(performance.now() - started) };
			}
		}
	})();
	return { proc, state, stderr };
}

/** The lines of the CLI's log files under `home` that match `pattern`. */
async function logLines(home: string, pattern: RegExp): Promise<string[]> {
	const lines: string[] = [];
	for (const name of new Bun.Glob("**/*.log").scanSync({ cwd: home, dot: true })) {
		for (const line of (await Bun.file(path.join(home, name)).text()).split("\n")) {
			if (pattern.test(line)) lines.push(line);
		}
	}
	return lines;
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url)(`omp --mode rpc under OMP_SESSION_EXCLUSIVE=1, stopped by a signal (${adapter})`, () => {
		/** A stored session {@link ID}, a home whose default model is a loopback that fails any request, and the DSN file. */
		const setUp = (dir: TempDir, dsn: string) => cliSession(dir, dsn, ID);

		/** The placeholder for {@link ID} in this server's statements. */
		const SID = adapter === "postgres" ? "$1" : "?";
		/** The statement that counts the lease rows of {@link ID}, with its placeholder for `ID`. */
		const LEASE_ROWS = `SELECT holder FROM omp_session_leases WHERE session_id = ${SID}`;
		const leaseRows = async (sql: SQL): Promise<number> => {
			const rows = (await sql.unsafe(LEASE_ROWS, [ID])) as unknown[];
			return rows.length;
		};
		/** The lease row of {@link ID}: its holder's pid and its times in ms on the database clock, or `undefined`. */
		const leaseRow = async (sql: SQL) => {
			const [row] = (await sql.unsafe(
				`SELECT pid, acquired_at, heartbeat_at FROM omp_session_leases WHERE session_id = ${SID}`,
				[ID],
			)) as { pid: unknown; acquired_at: unknown; heartbeat_at: unknown }[];
			return (
				row && { pid: Number(row.pid), acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at) }
			);
		};
		/**
		 * How long after the stopped holder's last heartbeat the resume took its row over, on the database clock: at
		 * least {@link LEASE_EXPIRY_MS} (less {@link TAKE_CLOCK_SLACK_MS}) when it waited for the row to expire.
		 */
		const takenAfterMs = (
			stopped: { heartbeatAt: number } | undefined,
			taken: { acquiredAt: number } | undefined,
		): number | undefined => (stopped && taken ? taken.acquiredAt - stopped.heartbeatAt : undefined);

		/** The exit status postmortem gives each signal it handles: 128 and the signal's number. */
		const HANDLED = { SIGTERM: 143, SIGINT: 130 } as const;
		for (const signal of ["SIGTERM", "SIGINT", "SIGKILL"] as const) {
			it(
				signal === "SIGKILL"
					? "after SIGKILL (nothing runs at exit), the next exclusive resume waits for the lease to expire"
					: `runs session_shutdown and gives the lease back on ${signal}, so the next exclusive resume opens the session without waiting on a lease`,
				async () => {
					using dir = TempDir.createSync("@omp-lease-signal-");
					await using db = await cliDatabase(adapter, url ?? "");
					const { cwd, home, sessionDir, file, dsnFile } = await setUp(dir, db.dsn);
					// The holder's session_shutdown counts the lease row 1 s in: the store's exit release must not
					// have deleted it under the mode's teardown.
					const markers = await markerExtension(dir, "holder", 0, { dsnFile, statement: LEASE_ROWS });

					const holder = startRpc(home, cwd, sessionDir, dsnFile, markers.file);
					const held = await holder.state;
					const rowsWhileHeld = await leaseRows(db.sql);
					holder.proc.kill(signal);
					const exitCode = await holder.proc.exited;
					// Read before the next resume starts: only a release deletes a lease row, so 0 here is the
					// release and not an expiry (an expired row stays until a claimant takes it over).
					const rowsAfterStop = await leaseRows(db.sql);
					const stopped = await leaseRow(db.sql);
					const shutDown = await markers.shutDown();
					const rowsDuringShutdown = await markers.rowsDuringShutdown();

					const next = startRpc(home, cwd, sessionDir, dsnFile);
					const resumed = await next.state;
					const taken = await leaseRow(db.sql);
					next.proc.kill("SIGTERM");
					await next.proc.exited;
					const resumeWaitedOnPid = waitedOnPid(await next.stderr);
					const takenAfter = takenAfterMs(stopped, taken);
					console.log(
						`${adapter} ${signal}: holder exit ${exitCode}, session_shutdown ${shutDown ? "ran" : "did not run"}, lease rows ${rowsWhileHeld} while held, ${rowsDuringShutdown ?? "none counted"} during session_shutdown and ${rowsAfterStop} after the stop; the next resume ${resumeWaitedOnPid === undefined ? "printed no lease wait" : `waited on pid ${resumeWaitedOnPid}`}${takenAfter === undefined ? "" : `, took the row ${takenAfter} ms after its last heartbeat`} and answered get_state after ${resumed.ms} ms`,
					);

					expect({ heldId: held.data.sessionId, rowsWhileHeld }).toEqual({ heldId: ID, rowsWhileHeld: 1 });
					expect({ resumedId: resumed.data.sessionId, resumedFile: resumed.data.sessionFile }).toEqual({
						resumedId: ID,
						resumedFile: file,
					});
					if (signal !== "SIGKILL") {
						expect({ exitCode, shutDown, rowsDuringShutdown, rowsAfterStop, resumeWaitedOnPid }).toEqual({
							exitCode: HANDLED[signal],
							shutDown: true,
							rowsDuringShutdown: 1,
							rowsAfterStop: 0,
							resumeWaitedOnPid: undefined,
						});
					} else {
						expect({
							shutDown,
							rowsAfterStop,
							resumeWaitedOnPid,
							takenAfterExpiry: (takenAfter ?? 0) >= LEASE_EXPIRY_MS - TAKE_CLOCK_SLACK_MS,
						}).toEqual({
							shutDown: false,
							rowsAfterStop: 1,
							resumeWaitedOnPid: stopped?.pid,
							takenAfterExpiry: true,
						});
					}
				},
				120_000,
			);
		}

		it("gives the lease back on SIGTERM during a slow session_start, before the RPC loop is ready", async () => {
			using dir = TempDir.createSync("@omp-lease-signal-");
			await using db = await cliDatabase(adapter, url ?? "");
			const { cwd, home, sessionDir, dsnFile } = await setUp(dir, db.dsn);
			// `session_start` writes its marker and then waits 15 s; the signal comes once the marker exists.
			const markers = await markerExtension(dir, "starting", 15_000);
			const holder = startRpc(home, cwd, sessionDir, dsnFile, markers.file);
			// The holder is stopped before it answers get_state, so its output ends first.
			holder.state.catch(() => undefined);
			const deadline = Date.now() + 60_000;
			while (!(await markers.started()) && Date.now() < deadline) await Bun.sleep(50);
			const began = await markers.started();
			const rowsWhileStarting = await leaseRows(db.sql);
			holder.proc.kill("SIGTERM");
			const exitCode = await holder.proc.exited;
			const rowsAfterStop = await leaseRows(db.sql);
			console.log(
				`${adapter} SIGTERM during session_start: began ${began}, holder exit ${exitCode}, lease rows ${rowsWhileStarting} while starting and ${rowsAfterStop} after the stop`,
			);
			expect({ began, rowsWhileStarting, exitCode, rowsAfterStop }).toEqual({
				began: true,
				rowsWhileStarting: 1,
				exitCode: 143,
				rowsAfterStop: 0,
			});
		}, 120_000);

		/** An extension module whose top level writes `<name>.load` and then waits `ms` before it exports its factory. */
		async function slowModuleExtension(dir: TempDir, name: string, ms: number) {
			const marker = dir.join(`${name}.load`);
			const file = dir.join(`${name}.ts`);
			await Bun.write(
				file,
				`await Bun.write(${JSON.stringify(marker)}, String(Date.now()));\n` +
					`await Bun.sleep(${ms});\n` +
					`export default function (pi) {}\n`,
			);
			return { file, began: () => Bun.file(marker).exists() };
		}

		/** An extension whose async factory writes `<name>.factory` and then waits `ms`. */
		async function slowFactoryExtension(dir: TempDir, name: string, ms: number) {
			const marker = dir.join(`${name}.factory`);
			const file = dir.join(`${name}.ts`);
			await Bun.write(
				file,
				`export default async function (pi) {\n` +
					`\tawait Bun.write(${JSON.stringify(marker)}, String(Date.now()));\n` +
					`\tawait Bun.sleep(${ms});\n` +
					`}\n`,
			);
			return { file, began: () => Bun.file(marker).exists() };
		}

		// Earlier in startup than session_start: the lease is taken before extensions load, and no mode's teardown
		// exists yet. The release comes from the store that took the lease.
		const EXITS = { SIGTERM: 143, SIGINT: 130 } as const;
		for (const window of ["module top level", "async factory"] as const) {
			for (const print of [false, true]) {
				for (const signal of ["SIGTERM", "SIGINT"] as const) {
					it(`${print ? "print mode" : "rpc"}: gives the lease back on ${signal} while an extension's ${window} is still running`, async () => {
						using dir = TempDir.createSync("@omp-lease-signal-");
						await using db = await cliDatabase(adapter, url ?? "");
						const { cwd, home, sessionDir, dsnFile } = await setUp(dir, db.dsn);
						const extension =
							window === "module top level"
								? await slowModuleExtension(dir, "slow", 15_000)
								: await slowFactoryExtension(dir, "slow", 15_000);
						const holder = startRpc(home, cwd, sessionDir, dsnFile, extension.file, print);
						// The holder is stopped before it answers anything, so its output ends first.
						holder.state.catch(() => undefined);
						const deadline = Date.now() + 60_000;
						while (!(await extension.began()) && Date.now() < deadline) await Bun.sleep(50);
						const began = await extension.began();
						const rowsWhileStarting = await leaseRows(db.sql);
						holder.proc.kill(signal);
						const exitCode = await holder.proc.exited;
						// Read before the next resume starts, so 0 is the release, not an expiry.
						const rowsAfterStop = await leaseRows(db.sql);
						const next = startRpc(home, cwd, sessionDir, dsnFile);
						const resumed = await next.state;
						next.proc.kill("SIGTERM");
						await next.proc.exited;
						const resumeWaitedOnPid = waitedOnPid(await next.stderr);
						console.log(
							`${adapter} ${print ? "print" : "rpc"} ${signal} during ${window}: began ${began}, holder exit ${exitCode}, lease rows ${rowsWhileStarting} while starting and ${rowsAfterStop} after the stop; the next resume ${resumeWaitedOnPid === undefined ? "printed no lease wait" : `waited on pid ${resumeWaitedOnPid}`} and answered get_state after ${resumed.ms} ms`,
						);
						expect({ began, rowsWhileStarting, exitCode, rowsAfterStop, resumeWaitedOnPid }).toEqual({
							began: true,
							rowsWhileStarting: 1,
							exitCode: EXITS[signal],
							rowsAfterStop: 0,
							resumeWaitedOnPid: undefined,
						});
					}, 120_000);
				}
			}
		}

		// The database stops answering at the signal: postmortem's cleanup deadline ends the exit (its log line says
		// so, or the store's release logs that it gave up after its bound; runs measured both), the row stays, and
		// the next resume waits on it and takes it over once it expired, 30 s after its last heartbeat. Through the
		// same proxy, not frozen, the row is gone at the exit and neither line is logged: the control.
		for (const freeze of [true, false]) {
			it(
				freeze
					? "exits within the cleanup deadline on SIGTERM while the database does not answer, leaving the row to expire"
					: "gives the lease back on SIGTERM through the same proxy when the database answers (control)",
				async () => {
					using dir = TempDir.createSync("@omp-lease-signal-");
					await using db = await cliDatabase(adapter, url ?? "");
					const { cwd, home, sessionDir, dsnFile } = await setUp(dir, db.dsn);
					const proxy = TcpProxy.for(db.dsn);
					try {
						await Bun.write(dsnFile, `${proxy.urlFor(db.dsn)}\n`);
						const holder = startRpc(home, cwd, sessionDir, dsnFile);
						await holder.state;
						const rowsWhileHeld = await leaseRows(db.sql);
						if (freeze) proxy.freeze();
						const signalled = performance.now();
						holder.proc.kill("SIGTERM");
						let hung: Timer | undefined;
						const exitedBeforeHung = await Promise.race([
							holder.proc.exited.then(() => true),
							new Promise<boolean>(resolve => {
								hung = setTimeout(() => resolve(false), HUNG_AFTER_MS);
							}),
						]);
						clearTimeout(hung);
						if (!exitedBeforeHung) holder.proc.kill("SIGKILL");
						const exitCode = await holder.proc.exited;
						const exitMs = Math.round(performance.now() - signalled);
						const rowsAfterStop = await leaseRows(db.sql);
						const stopped = await leaseRow(db.sql);
						const deadlineLogged = (await logLines(home, /Cleanup deadline exceeded/)).length > 0;
						const releaseLogged = (await logLines(home, /release a session lease/)).length > 0;
						proxy.thaw();
						let resumeWaitedOnPid: number | undefined;
						let takenAfter: number | undefined;
						if (freeze) {
							const next = startRpc(home, cwd, sessionDir, dsnFile);
							await next.state;
							takenAfter = takenAfterMs(stopped, await leaseRow(db.sql));
							next.proc.kill("SIGTERM");
							await next.proc.exited;
							resumeWaitedOnPid = waitedOnPid(await next.stderr);
						}
						console.log(
							`${adapter} SIGTERM ${freeze ? "with the database frozen" : "through the proxy"}: exit ${exitCode} after ${exitMs} ms, lease rows ${rowsWhileHeld} while held and ${rowsAfterStop} after, cleanup deadline logged ${deadlineLogged}, release logged ${releaseLogged}${freeze ? `; the next resume ${resumeWaitedOnPid === undefined ? "printed no lease wait" : `waited on pid ${resumeWaitedOnPid}`}${takenAfter === undefined ? "" : ` and took the row ${takenAfter} ms after its last heartbeat`}` : ""}`,
						);
						expect({ exitedBeforeHung, exitCode, rowsWhileHeld }).toEqual({
							exitedBeforeHung: true,
							exitCode: 143,
							rowsWhileHeld: 1,
						});
						if (freeze) {
							expect({
								rowsAfterStop,
								logged: deadlineLogged || releaseLogged,
								resumeWaitedOnPid,
								takenAfterExpiry: (takenAfter ?? 0) >= LEASE_EXPIRY_MS - TAKE_CLOCK_SLACK_MS,
							}).toEqual({
								rowsAfterStop: 1,
								logged: true,
								resumeWaitedOnPid: stopped?.pid,
								takenAfterExpiry: true,
							});
						} else {
							expect({ rowsAfterStop, deadlineLogged, releaseLogged }).toEqual({
								rowsAfterStop: 0,
								deadlineLogged: false,
								releaseLogged: false,
							});
						}
					} finally {
						proxy.thaw();
						proxy.stop();
					}
				},
				120_000,
			);
		}
	});
}
