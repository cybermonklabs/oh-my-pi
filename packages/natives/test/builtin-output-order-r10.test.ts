import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `cat`, `grep` and `du` as builtins. Each
// expectation below is the bytes GNU coreutils 9.7 and grep 3.11 write, with
// stderr sent to stdout (`2>&1`) and both into a regular file, and the status
// they exit with, for the same command under LC_ALL=C.UTF-8. GNU prints a
// diagnostic where it was written among the output: glibc's `error` flushes
// stdout first.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-order-r10-"));
	await fs.writeFile(path.join(dir, "abc"), "a\nb\nc\n");
	await fs.mkdir(path.join(dir, "d"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell with stdout sent to a file, whose bytes
 * are returned with the shell's exit status.
 */
async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	const result = await executeShell(
		{ command: `{ export LC_ALL=C.UTF-8; ${command}\n} >out 2>/dev/null`, cwd: dir },
		() => {},
	);
	return { output: await fs.readFile(path.join(dir, "out"), "utf8"), exitCode: result.exitCode };
}

describe("builtin output and diagnostics sent to one file with 2>&1", () => {
	it.each([
		// Regressed: every line of output came first and the diagnostic last.
		["cat abc nosuch abc 2>&1", "a\nb\nc\ncat: nosuch: No such file or directory\na\nb\nc\n", 1],
		["cat nosuch abc 2>&1", "cat: nosuch: No such file or directory\na\nb\nc\n", 1],
		// Regressed: the same for grep.
		["grep -H a abc d abc 2>&1", "abc:a\ngrep: d: Is a directory\nabc:a\n", 2],
		// Regressed: the same for du, which writes its output to the descriptor unbuffered.
		["du -sb nosuch abc 2>&1", "du: cannot access 'nosuch': No such file or directory\n6\tabc\n", 1],
		// A pipe already kept the order.
		["cat abc nosuch abc 2>&1 | cat", "a\nb\nc\ncat: nosuch: No such file or directory\na\nb\nc\n", 0],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
