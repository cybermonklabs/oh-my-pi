import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `env`, `timeout` and `nohup` as builtins. Each
// expectation below is the bytes GNU coreutils 9.7 writes, with stderr sent to
// stdout (`2>&1`), and the status it exits with, for the same command under
// LC_ALL=C.UTF-8 unless a case names another locale.

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

describe("builtin env, timeout and nohup: a command name they cannot run, quoted as GNU quotes it", () => {
	it.each([
		// Regressed: the name was quoted from a lossy copy, so the byte printed as `�`; GNU prints its octal escape.
		[String.raw`env $'\xff' 2>&1`, "env: ‘\\377’: No such file or directory\n", 127],
		[String.raw`LC_ALL=C env $'\xff' 2>&1`, "env: '\\377': No such file or directory\n", 127],
		[String.raw`timeout 5 $'\xff' 2>&1`, "timeout: failed to run command ‘\\377’: No such file or directory\n", 127],
		[
			String.raw`nohup $'\xff' </dev/null 2>&1`,
			"nohup: failed to run command ''$'\\377': No such file or directory\n",
			127,
		],
		// Regressed: U+2028 printed as itself; glibc does not print it.
		[String.raw`env $'x\u2028y' 2>&1`, "env: ‘x\\342\\200\\250y’: No such file or directory\n", 127],
		// Regressed: a `’` in the name was not escaped, so it read as the closing quote.
		["env 'a’b' 2>&1", "env: ‘a\\’b’: No such file or directory\n", 127],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
