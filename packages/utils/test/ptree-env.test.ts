import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type ExecOptions, exec, spawnToolProcess } from "@oh-my-pi/pi-utils/ptree";

const NAME = "OMP_PTREE_ENV_PROBE";

describe("ptree child environment", () => {
	afterEach(() => {
		delete Bun.env[NAME];
	});

	// omp loads `~/.env` and the agent `.env` into `Bun.env` after startup; Bun.spawn's
	// own default environment predates those writes, so `!command` config values
	// reading such a variable resolved to an empty credential.
	it("inherits values written into Bun.env after startup", async () => {
		Bun.env[NAME] = "loaded-from-dotenv";
		const result = await exec([process.execPath, "-e", `process.stdout.write(process.env.${NAME} ?? "")`]);
		expect(result.stdout).toBe("loaded-from-dotenv");
	});
});

const SCORE = "/proc/self/oom_score_adj";

/**
 * Whether a process can hold an OOM adjustment below 1000, a tool process's value (Linux): a child of this one
 * tries, so this process keeps its own. A test that a tool process of this build runs starts at 1000, and a 1000 a
 * tool process reads shows its spawn set it only below that; such tests skip where it cannot be.
 */
const BELOW_TOOL_SCORE =
	process.platform === "linux" &&
	Bun.spawnSync([
		"/bin/sh",
		"-c",
		`{ read -r s < ${SCORE}; [ "$s" -lt 1000 ] || printf 999 > ${SCORE}; read -r s < ${SCORE}; [ "$s" -lt 1000 ]; } 2>/dev/null`,
	]).exitCode === 0;

/** Set in the test process {@link belowToolScore} starts: the name of the test it runs there. */
const ALONE = "OMP_TEST_BELOW_TOOL_SCORE";
/** How long that process may run before it is killed. */
const ALONE_DEADLINE_MS = 60_000;
/** The timeout of a test that calls {@link belowToolScore}: past that deadline and the reading of the output. */
const ALONE_TIMEOUT_MS = ALONE_DEADLINE_MS + 15_000;

/**
 * Run test `name` of this file again, alone, in a `bun test` process of its own whose OOM adjustment is below 1000,
 * and fail where it fails there; in that process, run `test` with that value, `baseline`. The value of this test
 * runner never changes. The process leads a group of its own, is killed where it outlasts
 * {@link ALONE_DEADLINE_MS}, and whatever it left in its group is killed once it ended.
 */
async function belowToolScore(name: string, test: (baseline: string) => Promise<void>): Promise<void> {
	if (Bun.env[ALONE] === name) {
		if ((await Bun.file(SCORE).text()).trim() === "1000") await Bun.write(SCORE, "999");
		const baseline = await Bun.file(SCORE).text();
		if (baseline.trim() === "1000") throw new Error("this process's OOM adjustment stayed at 1000");
		await test(baseline);
		return;
	}
	const pattern = `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", pattern], {
		cwd: process.cwd(),
		env: { ...Bun.env, [ALONE]: name },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
		timeout: ALONE_DEADLINE_MS,
		killSignal: "SIGKILL",
	});
	const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
		([stdout, stderr]) => stdout + stderr,
	);
	let exitCode: number;
	try {
		exitCode = await child.exited;
	} finally {
		try {
			// What the test left in the process's group.
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The group is empty.
		}
	}
	// A wall-clock bound on purpose: a process the test left may hold the pipes.
	const said = await Promise.race([output, Bun.sleep(5_000).then(() => "<the test process's output stayed open>")]);
	if (child.signalCode === "SIGKILL") throw new Error(`the test ran past ${ALONE_DEADLINE_MS} ms: ${said}`);
	expect(exitCode, said).toBe(0);
	expect(said, "the test process ran no test").toMatch(/^\s*1 pass$/m);
}

/** What `exec` of `command` throws, as the code and message a caller sees. */
async function execFailure(command: string[], options: ExecOptions): Promise<unknown> {
	return await exec(command, options).then(
		() => "started",
		(error: Error & { code?: string }) => ({ code: error.code, message: error.message }),
	);
}

/** The errno a direct spawn of `program` fails with: its code, and its number, positive. */
function spawnFailure(program: string): { code: string | undefined; errno: number | undefined } {
	try {
		Bun.spawn([program], { stdout: "ignore", stderr: "ignore" }).kill();
	} catch (error) {
		const { code, errno } = error as NodeJS.ErrnoException;
		return { code, errno: errno === undefined ? undefined : Math.abs(errno) };
	}
	throw new Error(`${program} started`);
}

/** The launcher of a tool process, as `Bun.spawn` gets it: this process's image. */
const LAUNCHER = `/proc/${process.pid}/exe`;

/** Wait, blocking, until process `pid` ended: a zombie, or gone. */
function waitUntilEnded(pid: number): void {
	const deadline = Date.now() + 10_000;
	for (;;) {
		let state: string;
		try {
			state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0];
		} catch {
			return;
		}
		if (state === "Z") return;
		if (Date.now() > deadline) throw new Error(`process ${pid} still runs`);
		Bun.sleepSync(5);
	}
}

describe.skipIf(process.platform !== "linux")("exec of a tool process", () => {
	it("runs the program in place of its launcher with literal arguments", async () => {
		const args = ["a b", "", '$HOME; "quoted"', "--"];
		const result = await exec(
			["/bin/sh", "-c", `printf '%s\\n' "$PPID" "\${BUN_BE_BUN-unset}" "$@"`, "sh", ...args],
			{ toolOomScore: true },
		);
		// Its parent is this process: the launcher became the program instead of starting it.
		expect(result.stdout).toBe([String(process.pid), Bun.env.BUN_BE_BUN ?? "unset", ...args, ""].join("\n"));
	});

	// Failure mode: the program gets another environment than the caller's: one a shell imports (`dash` drops names
	// that are not shell identifiers, an exported Bash function, and resets `IFS` and `OPTIND`), one without the keys
	// a launcher kept for itself, or one with what the launcher's runtime loads from the working directory (`.env`).
	// A `bunfig.toml` there would run its preload in the launcher.
	it("runs the program with the caller's environment exactly, whatever the working directory holds", async () => {
		using dir = TempDir.createSync("@omp-oom-env-");
		fs.writeFileSync(dir.join(".env"), "OMP_FROM_DOTENV=loaded\n");
		const preloaded = dir.join("preloaded");
		fs.writeFileSync(dir.join("preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "");\n`);
		fs.writeFileSync(dir.join("bunfig.toml"), 'preload = ["./preload.ts"]\n');
		const env = {
			"BASH_FUNC_f%%": "() { echo f; }",
			"a.b": "1",
			IFS: ":",
			OPTIND: "5",
			OMP_TOOL_EXEC_FAILED: "the caller's",
			OMP_TOOL_EXEC_BUN_BE_BUN: "the caller's too",
			BUN_BE_BUN: "0",
		};
		const result = await exec(["/usr/bin/env"], { env, cwd: dir.path(), toolOomScore: true });
		const expected = Object.entries(env).map(([name, value]) => `${name}=${value}`);
		expect(result.stdout.trimEnd().split("\n").sort()).toEqual(expected.sort());
		expect(fs.existsSync(preloaded)).toBe(false);
	});

	// Failure mode: the launcher's payload and report descriptors reach the program.
	it("leaves the program no descriptor of its launcher", async () => {
		const result = await exec(
			["/bin/sh", "-c", 'for fd in 3 4; do [ -e "/proc/$$/fd/$fd" ] && echo "$fd"; done; :'],
			{
				toolOomScore: true,
			},
		);
		expect(result.stdout).toBe("");
	});

	const TOOL_SCORE = "sets 1000 in the tool and its child without changing the caller";
	it.skipIf(!BELOW_TOOL_SCORE)(
		TOOL_SCORE,
		async () => {
			await belowToolScore(TOOL_SCORE, async before => {
				const result = await exec(["/bin/sh", "-c", `read -r score < ${SCORE}; echo "$score"; /bin/cat ${SCORE}`], {
					toolOomScore: true,
				});
				expect(await Bun.file(SCORE).text()).toBe(before);
				expect(result.stdout).toBe("1000\n1000\n");
			});
		},
		ALONE_TIMEOUT_MS,
	);

	const SPAWN_SCORE = "spawns the tool itself with 1000 for spawnToolProcess";
	it.skipIf(!BELOW_TOOL_SCORE)(
		SPAWN_SCORE,
		async () => {
			await belowToolScore(SPAWN_SCORE, async before => {
				const proc = await spawnToolProcess(["/bin/sh", "-c", `echo "$$"; /bin/cat ${SCORE}`], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
				expect(await Bun.file(SCORE).text()).toBe(before);
				expect(exitCode).toBe(0);
				// The handle is the program's: the launcher became it.
				expect(stdout).toBe(`${proc.pid}\n1000\n`);
			});
		},
		ALONE_TIMEOUT_MS,
	);

	const PATH_SCORE = "looks a bare program up on the child's PATH, and fails a missing one as its own spawn does";
	it.skipIf(!BELOW_TOOL_SCORE)(
		PATH_SCORE,
		async () => {
			await belowToolScore(PATH_SCORE, async () => {
				using dir = TempDir.createSync("@omp-oom-path-");
				fs.writeFileSync(dir.join("omp-oom-tool"), `#!/bin/sh\n/bin/cat ${SCORE}\n`, { mode: 0o755 });
				const env = { PATH: dir.path() };
				const result = await exec(["omp-oom-tool"], { env, toolOomScore: true });
				expect(result.stdout).toBe("1000\n");
				const missing = ["omp-oom-missing-tool"];
				expect(await execFailure(missing, { env, toolOomScore: true })).toEqual(
					await execFailure(missing, { env }),
				);
				// An empty PATH: Bun's spawn does not search the working directory, so neither does the launcher.
				const empty = { env: { PATH: "" }, cwd: dir.path() };
				const tool = ["omp-oom-tool"];
				expect(await execFailure(tool, { ...empty, toolOomScore: true })).toEqual(await execFailure(tool, empty));
			});
		},
		ALONE_TIMEOUT_MS,
	);

	const IMAGE_SCORE = "runs this process's image for /proc/self/exe";
	it.skipIf(!BELOW_TOOL_SCORE)(
		IMAGE_SCORE,
		async () => {
			await belowToolScore(IMAGE_SCORE, async () => {
				const result = await exec(
					["/proc/self/exe", "-e", `process.stdout.write(require("node:fs").readFileSync("${SCORE}", "utf8"))`],
					{ toolOomScore: true },
				);
				expect(result.stdout).toBe("1000\n");
			});
		},
		ALONE_TIMEOUT_MS,
	);

	// Failure mode: a program that cannot start is reported as one that ran and exited 127, or runs as shell code.
	// The exec fails with the errno of the program's exec, the one its own spawn fails with.
	it("fails a program that cannot exec with the error of its exec", async () => {
		using dir = TempDir.createSync("@omp-oom-exec-");
		// A script whose `#!` interpreter is missing; a file without `#!` that the kernel cannot load.
		for (const [name, body, code] of [
			["no-interpreter", "#!/nonexistent/interpreter\n", "ENOENT"],
			["no-shebang", "echo ran as shell code\n", "ENOEXEC"],
		]) {
			const script = dir.join(name);
			fs.writeFileSync(script, body, { mode: 0o755 });
			const failure = await exec([script], { toolOomScore: true }).then(
				() => "started",
				(error: NodeJS.ErrnoException) => ({
					code: error.code,
					errno: error.errno === undefined ? undefined : Math.abs(error.errno),
					names: error.message.includes(script),
				}),
			);
			expect(failure).toEqual({ ...spawnFailure(script), names: true });
			expect(failure).toMatchObject({ code });
		}
	});

	// Failure mode: a program whose exec failed is spawned again, so it runs where it has become runnable since, and
	// runs twice where it starts both times. Here its interpreter appears once the launcher's exec failed and the
	// launcher ended.
	it("never spawns a program whose exec failed again", async () => {
		using dir = TempDir.createSync("@omp-oom-once-");
		const interpreter = dir.join("interpreter");
		const ran = dir.join("ran");
		const script = dir.join("tool");
		fs.writeFileSync(script, `#!${interpreter}\n`, { mode: 0o755 });
		const spawn = Bun.spawn.bind(Bun);
		const spawned: string[] = [];
		const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: object) => {
			spawned.push(cmd[0]);
			const proc = spawn(cmd, options as never);
			// The launcher's exec has failed: the program could run from here on.
			waitUntilEnded(proc.pid);
			fs.writeFileSync(interpreter, `#!/bin/sh\necho ran >> ${ran}\n`, { mode: 0o755 });
			return proc;
		}) as unknown as typeof Bun.spawn);
		try {
			const failure = await execFailure([script], { toolOomScore: true });
			expect(failure).toMatchObject({ code: "ENOENT" });
		} finally {
			spy.mockRestore();
		}
		expect(spawned).toEqual([LAUNCHER]);
		expect(fs.existsSync(ran)).toBe(false);
	});

	// Failure mode: a launcher that cannot start (no `/proc`, a runtime that cannot run there) fails the program's
	// spawn, or runs the program twice. The program then runs, once, without it.
	it("runs the program itself where its launcher cannot start or run", async () => {
		using dir = TempDir.createSync("@omp-oom-fallback-");
		const runs = dir.join("runs");
		const command = ["/bin/sh", "-c", `echo ran >> ${runs}; echo out`];
		const spawn = Bun.spawn.bind(Bun);
		for (const [what, launcher] of [
			["no launcher image", [dir.join("no-such-exe")]],
			["a launcher that ends before its exec", ["/bin/sh", "-c", "exit 3"]],
		] as const) {
			fs.rmSync(runs, { force: true });
			const spawned: string[] = [];
			const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: object) => {
				spawned.push(cmd[0]);
				return spawn(cmd[0] === LAUNCHER ? [...launcher] : cmd, options as never);
			}) as unknown as typeof Bun.spawn);
			try {
				const result = await exec(command, { toolOomScore: true });
				expect(result.stdout, what).toBe("out\n");
			} finally {
				spy.mockRestore();
			}
			expect(spawned, what).toEqual([LAUNCHER, "/bin/sh"]);
			expect(fs.readFileSync(runs, "utf8"), what).toBe("ran\n");
		}
	});

	// Failure mode: a program that starts and exits 127 is taken for one that could not start.
	it("reports a program that exits 127 as one that ran", async () => {
		using dir = TempDir.createSync("@omp-oom-exit-");
		const script = dir.join("exits-127");
		fs.writeFileSync(script, "#!/bin/sh\necho ran >&2\nexit 127\n", { mode: 0o755 });
		const result = await exec([script], { toolOomScore: true, allowNonZero: true });
		expect([result.exitCode, result.stderr]).toEqual([127, "ran\n"]);
	});
});
