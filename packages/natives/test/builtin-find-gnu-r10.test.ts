import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";
import { runInChild } from "./builtin-child";

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

describe("builtin find: parentheses nested 10,000 deep", () => {
	const depth = 10_000;

	it("are read, and the process lives on", async () => {
		// Regressed: reading the expression recursed once a `(`, so the stack overflowed (from 1,000 deep), which aborts the whole process, the bash tool's host with it.
		const command = `find . ${"\\( ".repeat(depth)}-name f${" \\)".repeat(depth)}`;
		expect(await runInChild(dir, command)).toEqual({ child: 0, exitCode: 0, output: Buffer.from("./f\n") });
	}, 60_000);

	it("left unclosed are refused with exit 1, and the process lives on", async () => {
		// Regressed: the same before the missing `)` is reported.
		const command = `find . ${"\\( ".repeat(depth)}-name f`;
		expect(await runInChild(dir, command)).toEqual({ child: 0, exitCode: 1, output: Buffer.alloc(0) });
	}, 60_000);
});

describe("builtin find: an expression that keeps a level for each of 100,000 parentheses", () => {
	// GNU find 4.10 reads such a nest 10,000 deep, and does not finish one
	// 50,000 deep within 120 seconds. Evaluating the tree recurses once a
	// level, so the builtin refuses one deeper than 1,000 levels: its own
	// message, which names `find`, and exit 1.
	const depth = 100_000;

	it.each(["! \\( ", "-true \\( "])(
		"opened by `%s` is refused with exit 1, and the process lives on",
		async open => {
			// Regressed: the tree was read, then evaluating it overflowed the stack, which aborts the whole process.
			const command = `find . ${open.repeat(depth)}-name f${" \\)".repeat(depth)}`;
			const { child, exitCode, stderr } = await runInChild(dir, command, { stderr: true });
			expect({ child, exitCode }).toEqual({ child: 0, exitCode: 1 });
			expect(stderr.toString()).toMatch(/^find: /);
		},
		60_000,
	);
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
		// Regressed: a script whose interpreter is missing ran in the shell, which wrote its own "bad interpreter" message; GNU's execvp fails with ENOENT.
		[
			`printf '#!/nonexistent/sh\\n' >badint; chmod +x badint; ${exec("-exec ./badint {} \\;")}`,
			"find: ‘./badint’: No such file or directory\n",
			0,
		],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});

/**
 * Runs `-execdir` on the start point `start`, with a command that prints its
 * `{}` only where it runs in the directory `start` names: `.` here, or `sub`
 * with `inside`.
 */
const execdir = (start: string, end = "\\;", inside = "") =>
	`mkdir -p sub/inner; find ${start} -maxdepth 0 -execdir sh -c '[ "$PWD" = "$0" ] && echo "$@"' "$PWD${inside}" {} ${end} 2>&1`;

describe("builtin find: -execdir on a start point", () => {
	it.each([
		// Regressed: a start point ran in the parent of the directory its operand names; GNU splits the operand as written.
		[execdir("."), "./.\n", 0],
		[execdir("./"), "././\n", 0],
		[execdir("sub/"), "./sub/\n", 0],
		[execdir(".", "+"), "./.\n", 0],
		[execdir("sub/.", "\\;", "/sub"), "./.\n", 0],
		// A start point with a directory before its name already ran there.
		[execdir("sub/inner", "\\;", "/sub"), "./inner\n", 0],
		// Regressed: `./noexec` was looked for in the parent, "No such file or directory".
		[exec("-execdir ./noexec {} \\;"), "find: ‘./noexec’: Permission denied\n", 0],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});

describe("builtin find: a start point that is missing", () => {
	it.each([
		// Regressed: `Error: /abs/path/nosuch: No such file or directory (os error 2)`; GNU names the operand as given, in the locale's quotes.
		["find nosuch 2>&1", "find: ‘nosuch’: No such file or directory\n", 1],
		["LC_ALL=C find nosuch 2>&1", "find: 'nosuch': No such file or directory\n", 1],
		// The walk goes on to the next start point, and the status is 1. Its stderr goes to a file of its own, read
		// after the status.
		["find nosuch . -maxdepth 0 2>err; echo $?; cat err", ".\n1\nfind: ‘nosuch’: No such file or directory\n", 0],
	])("%s", async (command, output, exitCode) => {
		expect(await run(`export LC_ALL=C.UTF-8; ${command}`)).toEqual({ output, exitCode });
	});
});
