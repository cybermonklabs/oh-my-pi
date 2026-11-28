import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts, executeInVmContext } from "../../src/eval/js/context-manager";
import { runBoundedProbe } from "../../src/eval/probe";
import { checkPythonKernelAvailability, PythonKernel, toolPythonCode } from "../../src/eval/py/kernel";
import { consoleAttached, shouldDetachKernel, shouldHideKernelWindow } from "../../src/eval/py/spawn-options";
import { BELOW_TOOL_SCORE, BELOW_TOOL_SCORE_TIMEOUT_MS, belowToolScore } from "../helpers/oom-score";

describe("shouldDetachKernel", () => {
	it("starts POSIX kernels in a new session", () => {
		expect(shouldDetachKernel("darwin")).toBe(true);
		expect(shouldDetachKernel("linux")).toBe(true);
	});

	it("leaves Windows console inheritance to windowsHide", () => {
		expect(shouldDetachKernel("win32")).toBe(false);
	});
});

/**
 * `shouldHideKernelWindow` decides whether the long-lived Python kernel
 * subprocess is spawned with `windowsHide: true`. On Windows, Bun maps that
 * option to `CREATE_NO_WINDOW`, which detaches the child from any inherited
 * console — breaking both (a) `LoadLibraryExW` for NumPy/pandas native
 * extensions and (b) SIGINT delivery via `GenerateConsoleCtrlEvent`. See
 * issue #1960. The tests below pin the two layered concerns:
 *
 * 1. `shouldHideKernelWindow` — pure predicate over the combined detection.
 * 2. `consoleAttached` — native HWND and stdio TTY evidence; either wins.
 */
describe("shouldHideKernelWindow", () => {
	it("inherits the host console on Windows when one is attached", () => {
		// Reporter's repro: omp launched in Windows Terminal, host has a
		// console, kernel must inherit so `import pandas` doesn't deadlock in
		// `_multiarray_umath` and SIGINT can recover the cell.
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: true })).toBe(false);
	});

	it("hides on Windows only when the host has no console at all (true service / daemon)", () => {
		// CREATE_NO_WINDOW here suppresses the console window Windows would
		// otherwise auto-allocate for the console-app Python kernel.
		expect(shouldHideKernelWindow({ platform: "win32", hostHasInheritableConsole: false })).toBe(true);
	});

	it("never sets windowsHide off-Windows (the option is a Win32-only flag)", () => {
		// On POSIX `windowsHide` is a no-op; the predicate must return false
		// everywhere off-Windows so the spawn site matches pre-fix behavior.
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "linux", hostHasInheritableConsole: false })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: true })).toBe(false);
		expect(shouldHideKernelWindow({ platform: "darwin", hostHasInheritableConsole: false })).toBe(false);
	});
});

describe("consoleAttached", () => {
	it("treats a ConPTY TTY as attached when GetConsoleWindow returns null", () => {
		expect(
			consoleAttached({
				nativeConsole: false,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				stderrIsTTY: true,
			}),
		).toBe(true);
	});

	it("trusts the native console for fully redirected stdio", () => {
		expect(
			consoleAttached({
				nativeConsole: true,
				stdinIsTTY: false,
				stdoutIsTTY: false,
				stderrIsTTY: false,
			}),
		).toBe(true);
	});

	it("treats `omp -p '...' > out.txt` (stdout-only redirect) as console-attached", () => {
		expect(consoleAttached({ stdinIsTTY: true, stdoutIsTTY: false, stderrIsTTY: true })).toBe(true);
	});

	it("returns false without native-console or TTY evidence", () => {
		expect(
			consoleAttached({
				nativeConsole: false,
				stdinIsTTY: false,
				stdoutIsTTY: false,
				stderrIsTTY: false,
			}),
		).toBe(false);
	});
});

const interpreter = Bun.which("python3");
const SCORE = "/proc/self/oom_score_adj";

const KERNEL_SCORE = "starts the Python kernel and its child with OOM score 1000 without changing the host";
it.skipIf(!BELOW_TOOL_SCORE || !interpreter)(
	KERNEL_SCORE,
	async () => {
		await belowToolScore(import.meta.path, KERNEL_SCORE, async before => {
			using temp = TempDir.createSync("@python-oom-score-");
			const kernel = await PythonKernel.start({ cwd: temp.path(), interpreter: interpreter ?? undefined });
			try {
				let output = "";
				const result = await kernel.execute(
					[
						"import os, subprocess",
						"assert os.getpid() == os.getsid(0)",
						`print(open("${SCORE}").read().strip())`,
						`print(subprocess.check_output(["/bin/cat", "${SCORE}"], text=True).strip())`,
					].join("\n"),
					{
						onChunk: chunk => {
							output += chunk;
						},
					},
				);
				expect(await Bun.file(SCORE).text()).toBe(before);
				expect(result.status).toBe("ok");
				expect(output).toBe("1000\n1000\n");
			} finally {
				await kernel.shutdown();
			}
		});
	},
	BELOW_TOOL_SCORE_TIMEOUT_MS,
);

/**
 * A `sitecustomize.py` in `dir`, which Python's startup (`site`) runs before any code of the program: it appends
 * the OOM adjustment its child reads to `record`.
 */
function siteRecordingChildScore(dir: string, record: string): void {
	fs.writeFileSync(
		`${dir}/sitecustomize.py`,
		[
			"import subprocess",
			`with open(${JSON.stringify(record)}, "a") as record:`,
			`    subprocess.run(["/bin/cat", "${SCORE}"], stdout=record, check=True)`,
			"",
		].join("\n"),
	);
}

// Failure mode: the interpreter starts with the host's OOM adjustment and sets its own only in its first code:
// Python's startup runs `sitecustomize` before that, and a process it starts keeps the host's value.
const KERNEL_SITE_SCORE = "starts the Python kernel with OOM score 1000 before its sitecustomize runs";
it.skipIf(!BELOW_TOOL_SCORE || !interpreter)(
	KERNEL_SITE_SCORE,
	async () => {
		await belowToolScore(import.meta.path, KERNEL_SITE_SCORE, async before => {
			using temp = TempDir.createSync("@python-site-score-");
			const site = temp.join("site");
			fs.mkdirSync(site);
			const record = temp.join("child-scores");
			siteRecordingChildScore(site, record);
			const kernel = await PythonKernel.start({
				cwd: temp.path(),
				interpreter: interpreter ?? undefined,
				env: { PYTHONPATH: site },
			});
			await kernel.shutdown();
			expect(await Bun.file(SCORE).text()).toBe(before);
			expect(fs.readFileSync(record, "utf8")).toBe("1000\n");
		});
	},
	BELOW_TOOL_SCORE_TIMEOUT_MS,
);

// Failure mode: the kernel gets the environment a shell imports instead of the one it was given: `dash` drops
// names that are not shell identifiers (an exported Bash function) and resets `IFS` and `OPTIND`.
it.skipIf(process.platform !== "linux" || !interpreter)(
	"starts the Python kernel with its environment unchanged",
	async () => {
		using temp = TempDir.createSync("@python-env-");
		const vars: Record<string, string> = { "BASH_FUNC_f%%": "() { echo f; }", "a.b": "1", IFS: ":", OPTIND: "5" };
		const kernel = await PythonKernel.start({ cwd: temp.path(), interpreter: interpreter ?? undefined, env: vars });
		try {
			let output = "";
			// The environment the interpreter was started with: the kernel's init sets `os.environ` again.
			const result = await kernel.execute(
				[
					"import json",
					'started = dict(var.split("=", 1) for var in open("/proc/self/environ").read().split("\\0") if var)',
					`print(json.dumps({name: started.get(name) for name in ${JSON.stringify(Object.keys(vars))}}))`,
				].join("\n"),
				{
					onChunk: chunk => {
						output += chunk;
					},
				},
			);
			expect(result.status).toBe("ok");
			expect(JSON.parse(output)).toEqual(vars);
		} finally {
			await kernel.shutdown();
		}
	},
	20_000,
);

const PROBE_SCORE = "runs the Python availability probe and its child with OOM score 1000 without changing the host";
it.skipIf(!BELOW_TOOL_SCORE || !interpreter)(
	PROBE_SCORE,
	async () => {
		await belowToolScore(import.meta.path, PROBE_SCORE, async before => {
			// The probe's code starts as `toolPythonCode` starts it; this one checks its own score and its child's.
			const code = [
				"import subprocess, sys",
				`own = open("${SCORE}").read().strip()`,
				`child = subprocess.check_output(["/bin/cat", "${SCORE}"], text=True).strip()`,
				'sys.exit(0 if (own, child) == ("1000", "1000") else 1)',
			].join("\n");
			const result = await runBoundedProbe([interpreter ?? "python3", "-c", toolPythonCode(code)], {
				cwd: process.cwd(),
				env: { ...process.env },
			});
			expect(await Bun.file(SCORE).text()).toBe(before);
			expect(result).toEqual({ exitCode: 0, timedOut: false, aborted: false });
		});
	},
	BELOW_TOOL_SCORE_TIMEOUT_MS,
);

// Failure mode: as for the kernel, the probed interpreter's `sitecustomize` starts a process with the host's value.
const PROBE_SITE_SCORE = "runs the Python availability probe with OOM score 1000 before its sitecustomize runs";
it.skipIf(!BELOW_TOOL_SCORE || !interpreter)(
	PROBE_SITE_SCORE,
	async () => {
		await belowToolScore(import.meta.path, PROBE_SITE_SCORE, async before => {
			using temp = TempDir.createSync("@python-probe-site-score-");
			const record = temp.join("child-scores");
			siteRecordingChildScore(temp.path(), record);
			const result = await runBoundedProbe([interpreter ?? "python3", "-c", "pass"], {
				cwd: temp.path(),
				env: { ...process.env, PYTHONPATH: temp.path() },
			});
			expect(result).toEqual({ exitCode: 0, timedOut: false, aborted: false });
			expect(await Bun.file(SCORE).text()).toBe(before);
			expect(fs.readFileSync(record, "utf8")).toBe("1000\n");
		});
	},
	BELOW_TOOL_SCORE_TIMEOUT_MS,
);

/** `body` as an executable `python3` in `dir`, for a kernel or probe to start. */
function fakePython(dir: TempDir, body: string): string {
	const file = dir.join("python3");
	fs.writeFileSync(file, body, { mode: 0o755 });
	return file;
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

/** Interpreters that cannot start: a script whose `#!` interpreter is missing, a file the kernel cannot load. */
const CANNOT_EXEC = ["#!/nonexistent/interpreter\n", "exit 0\n"];

describe.skipIf(process.platform !== "linux")("Python interpreters that cannot start", () => {
	// Failure mode: an interpreter that cannot start is reported as a kernel that ran and exited 127, or runs as
	// shell code. The start fails with the errno of the interpreter's exec, the one its own spawn fails with.
	it("fail the kernel's start with the error of their exec", async () => {
		for (const body of CANNOT_EXEC) {
			using temp = TempDir.createSync("@python-no-exec-");
			const python = fakePython(temp, body);
			const failure = await PythonKernel.start({ cwd: temp.path(), interpreter: python }).then(
				kernel => kernel.shutdown().then(() => "started"),
				(error: NodeJS.ErrnoException) => ({
					code: error.code,
					errno: error.errno === undefined ? undefined : Math.abs(error.errno),
					names: error.message.includes(python),
				}),
			);
			expect(failure).toEqual({ ...spawnFailure(python), names: true });
		}
	});

	// Failure mode: an interpreter that starts and exits 127 is taken for one that could not start.
	it("leave a kernel that started and exited 127 reported by its exit", async () => {
		using temp = TempDir.createSync("@python-exit-127-");
		const python = fakePython(temp, "#!/bin/sh\nread -r request\nexit 127\n");
		await expect(PythonKernel.start({ cwd: temp.path(), interpreter: python })).rejects.toThrow(
			"exited with code 127",
		);
	});

	// Failure mode: the availability probe reports an interpreter that cannot start as one that exited 127, or
	// accepts one that runs as shell code and exits 0.
	it("fail the availability probe with the error of their exec", async () => {
		for (const body of CANNOT_EXEC) {
			using temp = TempDir.createSync("@python-probe-no-exec-");
			const python = fakePython(temp, body);
			const availability = await checkPythonKernelAvailability(temp.path(), python, { forceProbe: true });
			const { code } = spawnFailure(python);
			expect(availability.reason).toStartWith(`No working Python interpreter found. Tried: ${python} (${code}`);
			expect(availability.reason).toContain(`'${python}')`);
		}
	});

	// Failure mode: a probed interpreter that starts and exits 127 is taken for one that could not start.
	it("leave a probed interpreter that exited 127 reported by its exit", async () => {
		using temp = TempDir.createSync("@python-probe-exit-127-");
		const python = fakePython(temp, "#!/bin/sh\nexit 127\n");
		const availability = await checkPythonKernelAvailability(temp.path(), python, { forceProbe: true });
		expect(availability.reason).toBe(`No working Python interpreter found. Tried: ${python} (exit code 127)`);
	});
});

const JS_KERNEL_SCORE =
	"starts the JS kernel subprocess and the processes its cells start with OOM score 1000 without changing the host";
it.skipIf(!BELOW_TOOL_SCORE)(
	JS_KERNEL_SCORE,
	async () => {
		await belowToolScore(import.meta.path, JS_KERNEL_SCORE, async before => {
			using temp = TempDir.createSync("@js-oom-score-");
			const sessionKey = `js-oom-score:${crypto.randomUUID()}`;
			let output = "";
			try {
				await executeInVmContext({
					sessionKey,
					sessionId: sessionKey,
					cwd: temp.path(),
					session: {
						cwd: temp.path(),
						hasUI: false,
						getSessionFile: () => null,
						getSessionSpawns: () => null,
						settings: Settings.isolated(),
					},
					code: [
						// The cell's own module loader in the kernel subprocess, not imports of this test.
						'const fs = await import("node:fs");',
						'const { execFileSync } = await import("node:child_process");',
						`const score = ${JSON.stringify(SCORE)};`,
						'const spawned = Bun.spawn(["/bin/cat", score], { stdout: "pipe" });',
						"console.log(JSON.stringify({",
						"\tpid: process.pid,",
						'\tkernel: fs.readFileSync(score, "utf8").trim(),',
						"\tspawn: (await spawned.stdout.text()).trim(),",
						"\tshell: (await Bun.$`/bin/cat /proc/self/oom_score_adj`.text()).trim(),",
						'\tchildProcess: execFileSync("/bin/cat", [score], { encoding: "utf8" }).trim(),',
						"}));",
					].join("\n"),
					filename: "oom-score.js",
					timeoutMs: 30_000,
					runState: {
						onText: chunk => {
							output += chunk;
						},
					},
				});
			} finally {
				await disposeAllVmContexts();
			}
			expect(await Bun.file(SCORE).text()).toBe(before);
			const { pid, ...scores } = JSON.parse(output);
			// Another pid: the cell ran in the kernel subprocess, not in a Worker of this process.
			expect(pid).not.toBe(process.pid);
			expect(scores).toEqual({ kernel: "1000", spawn: "1000", shell: "1000", childProcess: "1000" });
		});
	},
	BELOW_TOOL_SCORE_TIMEOUT_MS,
);
