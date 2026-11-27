import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts, executeInVmContext } from "../../src/eval/js/context-manager";
import { PythonKernel } from "../../src/eval/py/kernel";
import { consoleAttached, shouldDetachKernel, shouldHideKernelWindow } from "../../src/eval/py/spawn-options";

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
it.skipIf(process.platform !== "linux" || !interpreter)(
	"starts the Python kernel and its child with OOM score 1000 without changing the host",
	async () => {
		using temp = TempDir.createSync("@python-oom-score-");
		const score = "/proc/self/oom_score_adj";
		// A tool process of this build runs this test at 1000 already: start below it, so a 1000 is this spawn's.
		if ((await Bun.file(score).text()).trim() === "1000") await Bun.write(score, "999").catch(() => 0);
		const before = await Bun.file(score).text();
		const kernel = await PythonKernel.start({ cwd: temp.path(), interpreter: interpreter ?? undefined });
		try {
			let output = "";
			const result = await kernel.execute(
				[
					"import os, subprocess",
					"assert os.getpid() == os.getsid(0)",
					`print(open("${score}").read().strip())`,
					`print(subprocess.check_output(["/bin/cat", "${score}"], text=True).strip())`,
				].join("\n"),
				{
					onChunk: chunk => {
						output += chunk;
					},
				},
			);
			expect(await Bun.file(score).text()).toBe(before);
			expect(result.status).toBe("ok");
			expect(output).toBe("1000\n1000\n");
		} finally {
			await kernel.shutdown();
		}
	},
	20_000,
);

it.skipIf(process.platform !== "linux")(
	"starts the JS kernel subprocess and the processes its cells start with OOM score 1000 without changing the host",
	async () => {
		using temp = TempDir.createSync("@js-oom-score-");
		const score = "/proc/self/oom_score_adj";
		// A tool process of this build runs this test at 1000 already: start below it, so a 1000 is this spawn's.
		if ((await Bun.file(score).text()).trim() === "1000") await Bun.write(score, "999").catch(() => 0);
		const before = await Bun.file(score).text();
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
					`const score = ${JSON.stringify(score)};`,
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
		expect(await Bun.file(score).text()).toBe(before);
		const { pid, ...scores } = JSON.parse(output);
		// Another pid: the cell ran in the kernel subprocess, not in a Worker of this process.
		expect(pid).not.toBe(process.pid);
		expect(scores).toEqual({ kernel: "1000", spawn: "1000", shell: "1000", childProcess: "1000" });
	},
	30_000,
);
