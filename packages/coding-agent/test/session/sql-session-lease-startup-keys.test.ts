/**
 * An interactive launch (`autoResume` on, under SQL session storage) resumes and claims its directory's most recent
 * session before its extensions load; until InteractiveMode installs its own key handlers, the startup composer owns
 * Ctrl+C and Ctrl+D. A quit then must give the lease back, as a signal at the same point does: the double Ctrl+C
 * exits 130, Ctrl+D on an empty draft exits 0, and the TUI debug socket's `quit` op (`OMP_TUI_DEBUG`) exits 0, each
 * with no lease row left. Each row runs the CLI on a real terminal (`Bun.Terminal`; in raw mode 0x03 and 0x04 are
 * keys, not signals) while a user extension's module top level still runs, so the extension-load guard is open; the
 * extension counts the session's lease rows first, which shows the launch held the row. SIGINT at the same point is
 * the control. Real timers on purpose: the path under test is a key in a real startup. PostgreSQL and MySQL run when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a server; SQLite's claim is an OS lock the kernel drops
 * with the process.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cliDatabase, ROW_LEASE_BACKENDS } from "./sql-session-lease-fixture";

const sourceDir = path.resolve(import.meta.dir, "../../src");
const cliEntry = path.join(sourceDir, "cli.ts");
const ID = "01a1fc00-0000-7000-8000-000000000001";

/**
 * How a row ends the launch (terminal keys, a SIGINT, or the TUI debug socket's `quit`), when (while an extension still
 * loads, or once the session runs), and the exit status.
 */
const QUITS: {
	how: string;
	input: readonly string[] | "SIGINT" | "debug quit";
	when: "loading" | "running";
	exitCode: number;
}[] = [
	{ how: "the double Ctrl+C key", input: ["\x03", "\x03"], when: "loading", exitCode: 130 },
	{ how: "the Ctrl+D key on an empty draft", input: ["\x04"], when: "loading", exitCode: 0 },
	{ how: "the TUI debug socket's quit op", input: "debug quit", when: "loading", exitCode: 0 },
	{ how: "the TUI debug socket's quit op", input: "debug quit", when: "running", exitCode: 0 },
	{ how: "SIGINT (control)", input: "SIGINT", when: "loading", exitCode: 130 },
];

/** Send `{"op":"quit"}` to the TUI debug socket at `socket`, dialling until it binds. */
async function debugQuit(socket: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			const connection = await IpcConnection.connect(socket, { framing: "lines", timeoutMs: 1000 });
			connection.start(
				() => {},
				() => {},
			);
			connection.send(JSON.stringify({ op: "quit" }));
			return;
		} catch {
			await Bun.sleep(25);
		}
	}
	throw new Error(`the TUI debug socket ${socket} never accepted a connection`);
}

for (const { adapter, url } of ROW_LEASE_BACKENDS) {
	describe.skipIf(!url || process.platform === "win32")(
		`quitting an interactive startup that auto-resumed its session (${adapter})`,
		() => {
			const LEASE_ROWS = `SELECT holder FROM omp_session_leases WHERE session_id = ${adapter === "postgres" ? "$1" : "?"}`;
			for (const { how, input, when, exitCode: expectedExit } of QUITS) {
				const at = when === "loading" ? "while an extension still loads" : "once the session runs";
				it(`gives the lease back when ${how} quits it ${at}`, async () => {
					using dir = TempDir.createSync("@omp-lease-startup-keys-");
					await using db = await cliDatabase(adapter, url ?? "");
					const cwd = dir.join("project");
					fs.mkdirSync(cwd, { recursive: true });
					const home = dir.join("home");
					const agentDir = path.join(home, ".omp", "agent");
					fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
					await Bun.write(
						path.join(agentDir, "models.yml"),
						JSON.stringify({
							providers: {
								loopback: {
									baseUrl: "http://127.0.0.1:9/v1",
									api: "openai-completions",
									auth: "none",
									models: [
										{
											id: "default-model",
											name: "Default Model",
											reasoning: false,
											input: ["text"],
											cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
											contextWindow: 131072,
											maxTokens: 1024,
										},
									],
								},
							},
						}),
					);
					await Bun.write(
						path.join(agentDir, "config.yml"),
						JSON.stringify({
							modelRoles: { default: "loopback/default-model" },
							retry: { enabled: false },
							autoResume: true,
						}),
					);
					const dsnFile = dir.join("dsn");
					await Bun.write(dsnFile, `${db.dsn}\n`);
					const debugSocket =
						input === "debug quit"
							? ipcEndpoint(os.tmpdir(), `omp-lease-keys-${process.pid}-${Bun.randomUUIDv7().slice(-8)}`)
							: undefined;
					const env = {
						PATH: process.env.PATH ?? "",
						HOME: home,
						USERPROFILE: home,
						TMPDIR: process.env.TMPDIR ?? "/tmp",
						TERM: "xterm-256color",
						NO_COLOR: "1",
						PI_NO_TITLE: "1",
						OMP_SESSION_STORAGE: "sql",
						OMP_SESSION_SQL_DSN_FILE: dsnFile,
						...(debugSocket ? { OMP_TUI_DEBUG: debugSocket } : {}),
					};
					// The stored session, in the default session directory of `cwd` as the CLI's home resolves it.
					const setup = Bun.spawnSync(
						[
							process.execPath,
							"--eval",
							`import { SQL } from "bun";
							import { SessionManager } from ${JSON.stringify(path.join(sourceDir, "session/session-manager.ts"))};
							import { installConfiguredSessionStorage } from ${JSON.stringify(path.join(sourceDir, "session/session-storage-config.ts"))};
							import { SqlSessionStorage } from ${JSON.stringify(path.join(sourceDir, "session/sql-session-storage.ts"))};
							const cwd = process.cwd();
							await installConfiguredSessionStorage(cwd);
							const file = SessionManager.getDefaultSessionDir(cwd) + "/2026-11-19T00-00-00-000Z_${ID}.jsonl";
							const writer = await SqlSessionStorage.create({ client: new SQL(${JSON.stringify(db.dsn)}), claims: false });
							await writer.writeText(file, [
								{ type: "session", version: 3, id: "${ID}", timestamp: "2026-11-19T00:00:00.000Z", cwd },
								{ type: "message", id: "m1", parentId: null, timestamp: "2026-11-19T00:00:00.000Z", message: { role: "user", content: "hi", timestamp: 1 } },
							].map(row => JSON.stringify(row)).join("\\n") + "\\n");
							await writer.drain();
							console.log("FILE " + file);
							process.exit(0);`,
						],
						{ cwd, env },
					);
					if (!setup.stdout.toString().includes("FILE "))
						throw new Error(`setup failed: ${setup.stderr.toString()}`);
					// Counts the lease rows and writes the marker: at its module top level, then sleeps 15 s, so the
					// extension-load guard is open (`loading`); or when `session_start` runs, after the guard (`running`).
					const marker = dir.join("loaded");
					const count =
						`const sql = new SQL(${JSON.stringify(db.dsn)});\n` +
						`const rows = await sql.unsafe(${JSON.stringify(LEASE_ROWS)}, [${JSON.stringify(ID)}]);\n` +
						`await sql.end();\n` +
						`await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, rows: rows.length }));\n`;
					await Bun.write(
						path.join(agentDir, "extensions", "probe.ts"),
						when === "loading"
							? `import { SQL } from "bun";\n${count}await Bun.sleep(15000);\nexport default function (pi) {}\n`
							: `import { SQL } from "bun";\nexport default function (pi) {\n\tpi.on("session_start", async () => {\n${count}\t});\n}\n`,
					);
					const closed = Promise.withResolvers<void>();
					const decoder = new TextDecoder();
					let output = "";
					await using terminal = new Bun.Terminal({
						cols: 120,
						rows: 40,
						data(_terminal, data) {
							output += decoder.decode(data, { stream: true });
						},
						exit() {
							closed.resolve();
						},
					});
					const proc = Bun.spawn([process.execPath, cliEntry, "--no-title", "--no-lsp"], {
						cwd,
						env,
						terminal,
						signal: AbortSignal.timeout(80_000),
					});
					try {
						while (!fs.existsSync(marker) && proc.exitCode === null) await Bun.sleep(50);
						const loaded = fs.existsSync(marker)
							? (JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number; rows: number })
							: undefined;
						// The composer's keys are live before the extensions load; leave the launch a moment to read them.
						await Bun.sleep(300);
						if (input === "SIGINT") {
							if (loaded) process.kill(loaded.pid, "SIGINT");
						} else if (input === "debug quit") {
							await debugQuit(debugSocket ?? "");
						} else {
							for (const [index, key] of input.entries()) {
								if (index > 0) await Bun.sleep(120);
								terminal.write(key);
							}
						}
						const exitCode = await proc.exited;
						const rowsAfterExit = ((await db.sql.unsafe(LEASE_ROWS, [ID])) as unknown[]).length;
						console.log(
							`${adapter} ${how} ${at}: lease rows ${loaded?.rows ?? "none counted"} at the marker, exit ${exitCode}, ${rowsAfterExit} after the exit`,
						);
						expect({ rowsAtExtensionLoad: loaded?.rows, exitCode, rowsAfterExit }).toEqual({
							rowsAtExtensionLoad: 1,
							exitCode: expectedExit,
							rowsAfterExit: 0,
						});
					} catch (error) {
						throw new Error(
							`${error instanceof Error ? error.message : String(error)}\nterminal: ${output.slice(-400)}`,
						);
					} finally {
						if (proc.exitCode === null) proc.kill("SIGKILL");
						await proc.exited;
						terminal.close();
						await closed.promise;
					}
				}, 120_000);
			}
		},
	);
}
