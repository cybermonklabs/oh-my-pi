import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllKernelSessions } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { enumeratePythonRuntimes } from "@oh-my-pi/pi-coding-agent/eval/py/runtime";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import * as piUtils from "@oh-my-pi/pi-utils";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

// An activated venv or conda env outranks PATH (docs/environment-variables.md), so it would
// hide the PATH order these tests build.
const ACTIVE_PYTHON_ENV_VARS = ["VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV"] as const;

// A start probes only when it must choose among several interpreters, so every case puts its
// `python` ahead of a working `python3` on PATH. A host without one has nothing to choose
// between, as the gated real-kernel suites skip. `Bun.spawnSync` throws for a name PATH lacks,
// so the name is looked up first.
const PYTHON3 = $which("python3");
const HAS_PYTHON3 =
	PYTHON3 !== null &&
	Bun.spawnSync([PYTHON3, "-c", "import sys"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => `python-start-candidate-${crypto.randomUUID()}`,
	};
}

describe.skipIf(process.platform === "win32" || !HAS_PYTHON3)(
	HAS_PYTHON3
		? "Python kernel start without the availability check"
		: "Python kernel start without the availability check (skipped: no working python3 on PATH)",
	() => {
		const originalPath = process.env.PATH;
		let dir: TempDir;
		let bin: string;
		let restoreActiveEnv: () => void;

		/** Puts an executable `python` first on PATH, in the shell env the kernel reads too. */
		function firstPython(script: string): string {
			const python = path.join(bin, "python");
			fs.writeFileSync(python, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
			process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
			vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
				shell: "/bin/sh",
				args: ["-c"],
				env: { PATH: process.env.PATH, HOME: process.env.HOME ?? "" },
				prefix: undefined,
			});
			return python;
		}

		beforeEach(() => {
			dir = TempDir.createSync("@omp-python-start-candidate-");
			bin = dir.join("bin");
			fs.mkdirSync(bin);
			const previous = new Map(ACTIVE_PYTHON_ENV_VARS.map(name => [name, process.env[name]]));
			for (const name of ACTIVE_PYTHON_ENV_VARS) restoreEnvValue(name, undefined);
			restoreActiveEnv = () => {
				for (const [name, value] of previous) restoreEnvValue(name, value);
			};
			// No managed environment: the candidates are PATH's python, then PATH's python3.
			vi.spyOn(piUtils, "getPythonEnvDir").mockReturnValue(dir.join("no-managed-env"));
		});

		afterEach(async () => {
			process.env.PATH = originalPath;
			restoreActiveEnv();
			vi.restoreAllMocks();
			await disposeAllKernelSessions();
			dir.removeSync();
		});

		// bun test skips the availability check, as PI_PYTHON_SKIP_CHECK does in production. The start
		// must still take the first interpreter that runs, not the first one found: a `python` that
		// cannot start (a version-manager shim with no version selected) ahead of a working `python3`.
		it("starts the first Python candidate that runs, past a broken python first on PATH", async () => {
			const broken = firstPython("echo 'no version is set for this python' >&2\nexit 1");
			expect(enumeratePythonRuntimes(dir.path(), { PATH: process.env.PATH })[0]?.pythonPath).toBe(broken);

			const tool = new EvalTool(makeSession(dir.path()));
			const result = await tool.execute("call-python-start-candidate", {
				language: "py",
				code: "print(6 * 7)",
				timeout: 60,
			});
			const text = result.content.find(block => block.type === "text")?.text ?? "";

			expect(result.details?.isError).not.toBe(true);
			expect(text).toContain("42");
			// A real kernel starts here: the ceiling the test runner gives every test, for a bare run too.
		}, 30_000);

		it("stops probing for a candidate when the caller's signal aborts", async () => {
			const started = dir.join("probe-started");
			firstPython(`: > '${started}'\nexec sleep 600`);
			const appeared = Promise.withResolvers<void>();
			const watcher = fs.watch(dir.path(), () => {
				if (fs.existsSync(started)) appeared.resolve();
			});
			try {
				const controller = new AbortController();
				const cancelled = new Error("cancelled by the test");
				const start = PythonKernel.start({ cwd: dir.path(), signal: controller.signal });

				// Abort once the candidate that never answers has started. A probe that ignored the
				// signal would wait out its own ten-second bound and report no working interpreter.
				await appeared.promise;
				controller.abort(cancelled);

				await expect(start).rejects.toBe(cancelled);
			} finally {
				watcher.close();
			}
		});

		it("stops probing for a candidate at the caller's deadline", async () => {
			firstPython("exec sleep 600");

			const error = await PythonKernel.start({ cwd: dir.path(), deadlineMs: Date.now() + 200 }).catch(e => e);

			// The deadline's own TimeoutError: a probe that ignored it would end at its ten-second
			// bound with "No working Python interpreter found" instead.
			expect(error).toBeInstanceOf(DOMException);
			expect((error as DOMException).name).toBe("TimeoutError");
		});
	},
);
