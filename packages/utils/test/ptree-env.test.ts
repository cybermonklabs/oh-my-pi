import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type ExecOptions, exec } from "@oh-my-pi/pi-utils/ptree";

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
 * Whether this process can hold an OOM adjustment below 1000, a tool process's value (Linux): a child of it
 * tries, so this process keeps its own. A test that a tool process of this build runs starts at 1000, and a
 * 1000 a tool process reads shows its spawn set it only below that; such tests skip where it cannot be.
 */
const BELOW_TOOL_SCORE =
	process.platform === "linux" &&
	Bun.spawnSync([
		"/bin/sh",
		"-c",
		`{ read -r s < ${SCORE}; [ "$s" -lt 1000 ] || printf 999 > ${SCORE}; read -r s < ${SCORE}; [ "$s" -lt 1000 ]; } 2>/dev/null`,
	]).exitCode === 0;

/** Run `test` with this process's OOM adjustment below 1000, `baseline`, then restore the value it had. */
async function withBelowToolScore(test: (baseline: string) => Promise<void>): Promise<void> {
	const original = await Bun.file(SCORE).text();
	const lowered = original.trim() === "1000";
	if (lowered) await Bun.write(SCORE, "999");
	try {
		const baseline = await Bun.file(SCORE).text();
		if (baseline.trim() === "1000") throw new Error("this process's OOM adjustment stayed at 1000");
		await test(baseline);
	} finally {
		if (lowered) await Bun.write(SCORE, original);
	}
}

/** What `exec` of `command` throws, as the code and message a caller sees. */
async function execFailure(command: string[], options: ExecOptions): Promise<unknown> {
	return await exec(command, options).then(
		() => "started",
		(error: Error & { code?: string }) => ({ code: error.code, message: error.message }),
	);
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

	// Failure mode: the program gets the environment a shell imports instead of the caller's: `dash` drops names
	// that are not shell identifiers (an exported Bash function) and resets `IFS` and `OPTIND`.
	it("runs the program with the caller's environment unchanged", async () => {
		const env = { "BASH_FUNC_f%%": "() { echo f; }", "a.b": "1", IFS: ":", OPTIND: "5" };
		const result = await exec(["/usr/bin/env"], { env, toolOomScore: true });
		const expected = Object.entries(env).map(([name, value]) => `${name}=${value}`);
		expect(result.stdout.trimEnd().split("\n").sort()).toEqual(expected.sort());
	});

	it.skipIf(!BELOW_TOOL_SCORE)("sets 1000 in the tool and its child without changing the caller", async () => {
		await withBelowToolScore(async before => {
			const result = await exec(["/bin/sh", "-c", `read -r score < ${SCORE}; echo "$score"; /bin/cat ${SCORE}`], {
				toolOomScore: true,
			});
			expect(await Bun.file(SCORE).text()).toBe(before);
			expect(result.stdout).toBe("1000\n1000\n");
		});
	});

	it.skipIf(!BELOW_TOOL_SCORE)(
		"looks a bare program up on the child's PATH, and fails a missing one as its own spawn does",
		async () => {
			using dir = TempDir.createSync("@omp-oom-path-");
			fs.writeFileSync(dir.join("omp-oom-tool"), `#!/bin/sh\n/bin/cat ${SCORE}\n`, { mode: 0o755 });
			const env = { PATH: dir.path() };
			await withBelowToolScore(async () => {
				const result = await exec(["omp-oom-tool"], { env, toolOomScore: true });
				expect(result.stdout).toBe("1000\n");
			});
			const missing = ["omp-oom-missing-tool"];
			expect(await execFailure(missing, { env, toolOomScore: true })).toEqual(await execFailure(missing, { env }));
			// An empty PATH: Bun's spawn does not search the working directory, so neither does the launcher.
			const empty = { env: { PATH: "" }, cwd: dir.path() };
			const tool = ["omp-oom-tool"];
			expect(await execFailure(tool, { ...empty, toolOomScore: true })).toEqual(await execFailure(tool, empty));
		},
	);

	it.skipIf(!BELOW_TOOL_SCORE)("runs this process's image for /proc/self/exe", async () => {
		await withBelowToolScore(async () => {
			const result = await exec(
				["/proc/self/exe", "-e", `process.stdout.write(require("node:fs").readFileSync("${SCORE}", "utf8"))`],
				{ toolOomScore: true },
			);
			expect(result.stdout).toBe("1000\n");
		});
	});

	// Failure mode: a program that cannot start is reported as one that ran and exited 127, or runs as shell code.
	it("fails a program that cannot exec as its own spawn does", async () => {
		using dir = TempDir.createSync("@omp-oom-exec-");
		// A script whose `#!` interpreter is missing; a file without `#!` that the kernel cannot load.
		for (const [name, body, code] of [
			["no-interpreter", "#!/nonexistent/interpreter\n", "ENOENT"],
			["no-shebang", "echo ran as shell code\n", "ENOEXEC"],
		]) {
			const script = dir.join(name);
			fs.writeFileSync(script, body, { mode: 0o755 });
			const failure = await execFailure([script], { toolOomScore: true });
			expect(failure).toEqual(await execFailure([script], {}));
			expect(failure).toMatchObject({ code });
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
