import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `find` as a builtin. Each expectation below is
// the bytes GNU find 4.10 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C.UTF-8 unless a case names another locale.
// stderr is dropped, unless a command sends it to stdout itself (`2>&1`).

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-find-r10-"));
	await fs.writeFile(path.join(dir, "f"), "x\n");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell of a child process, which a crash of
 * the builtin ends alone, with stdout sent to `out`. Returns the child's own
 * exit status (0 when it lived to report), the builtin's, and the output.
 */
async function runInChild(command: string): Promise<{ child: number; exitCode: number; output: Buffer }> {
	const addon = path.join(import.meta.dir, "../native/index.js");
	const script = path.join(dir, "child.mjs");
	await fs.writeFile(
		script,
		[
			`import { executeShell } from ${JSON.stringify(addon)};`,
			`const command = ${JSON.stringify(`{ ${command}\n} >out 2>/dev/null`)};`,
			`const result = await executeShell({ command, cwd: ${JSON.stringify(dir)} }, () => {});`,
			"console.log(result.exitCode);",
		].join("\n"),
	);
	await fs.rm(path.join(dir, "out"), { force: true });
	const shell = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" });
	const [stdout, child] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
	const output = await fs.readFile(path.join(dir, "out")).catch(() => Buffer.alloc(0));
	return { child, exitCode: Number(stdout), output };
}

describe("builtin find: parentheses nested 10,000 deep", () => {
	const depth = 10_000;

	it("are read, and the process lives on", async () => {
		// Regressed: reading the expression recursed once a `(`, so the stack overflowed (from 1,000 deep), which aborts the whole process, the bash tool's host with it.
		const command = `find . ${"\\( ".repeat(depth)}-name f${" \\)".repeat(depth)}`;
		expect(await runInChild(command)).toEqual({ child: 0, exitCode: 0, output: Buffer.from("./f\n") });
	}, 60_000);

	it("left unclosed are refused with exit 1, and the process lives on", async () => {
		// Regressed: the same before the missing `)` is reported.
		const command = `find . ${"\\( ".repeat(depth)}-name f`;
		expect(await runInChild(command)).toEqual({ child: 0, exitCode: 1, output: Buffer.alloc(0) });
	}, 60_000);
});

/**
 * Runs `command` in the builtin shell with stdout sent to a file, whose bytes
 * are returned with the shell's exit status.
 */
async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out"), "utf8"), exitCode: result.exitCode };
}

/** Makes `noexec` (not executable), `d`, and `xkill`, which kills itself, then runs `find . -maxdepth 0 ARGS`. */
const exec = (args: string, locale = "C.UTF-8") =>
	`printf '#!/bin/sh\\necho hi\\n' >noexec; mkdir -p d; printf '#!/bin/sh\\nkill -9 $$\\n' >xkill; chmod +x xkill; LC_ALL=${locale} find . -maxdepth 0 ${args} 2>&1`;

describe("builtin find: a command -exec cannot run, or a signal kills", () => {
	it.each([
		// Regressed: each was `Failed to run NAME: entity not found` (or `permission denied`); GNU names the command in the locale's quotes, with strerror's text.
		[exec("-exec nosuch {} \\;"), "find: ‘nosuch’: No such file or directory\n", 0],
		[exec("-exec ./noexec {} \\;"), "find: ‘./noexec’: Permission denied\n", 0],
		// Regressed: a directory was "entity not found"; it cannot be executed.
		[exec("-exec ./d {} \\;"), "find: ‘./d’: Permission denied\n", 0],
		[exec("-exec nosuch {} +"), "find: ‘nosuch’: No such file or directory\n", 1],
		[exec("-exec ./noexec {} +"), "find: ‘./noexec’: Permission denied\n", 1],
		[exec("-exec nosuch {} \\;", "C"), "find: 'nosuch': No such file or directory\n", 0],
		// Regressed: a command killed by a signal was not reported.
		[exec("-exec ./xkill {} \\;"), "find: ‘./xkill’ terminated by signal 9\n", 0],
		[exec("-exec ./xkill {} +"), "find: ‘./xkill’ terminated by signal 9\n", 1],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
