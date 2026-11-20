import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `cat`, `rm`, `seq` and `sleep` as builtins. Each
// expectation below is the bytes GNU coreutils 9.7 writes, with stderr sent to
// stdout (`2>&1`), and the status it exits with, for the same command under
// LC_ALL=C.UTF-8, or else the builtin's own refusal where a case says so.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-quote-r10-"));
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

describe("builtin arguments that are not UTF-8", () => {
	it.each([
		// Regressed: the shell handed cat U+FFFD for the byte, so it opened no such file.
		[String.raw`printf 'x\n' >$'\xff'; cat $'\xff' 2>&1`, "x\n", 0],
		// Regressed: the same for rm, which aimed at a file named U+FFFD.
		[String.raw`printf 'x\n' >$'\xff'; rm $'\xff' 2>&1 && test ! -e $'\xff' && echo removed`, "removed\n", 0],
		// The builtin's own refusal: its parser reads these as text. GNU reads the byte (`seq: invalid floating
		// point argument: ‘\377’`, `sleep: invalid time interval ‘\377’`, exit 1). Regressed: the builtin read
		// U+FFFD in its place.
		[String.raw`seq $'\xff' 2>&1`, "seq: invalid UTF-8 was detected in one or more arguments\n", 1],
		[String.raw`sleep $'\xff' 2>&1`, "sleep: invalid UTF-8 was detected in one or more arguments\n", 2],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
