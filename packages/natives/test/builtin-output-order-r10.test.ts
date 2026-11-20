import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `find` as a builtin. Each expectation below is
// the bytes GNU findutils 4.10 writes, with stderr sent to stdout (`2>&1`) and
// both into a regular file, and the status it exits with, for the same command
// under the locale the case names. GNU prints a diagnostic where it was written
// among the output: glibc's `error` flushes stdout first.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-order-r10-"));
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
		// Regressed: every path find printed came first and each refusal of its `-delete` (in a directory it cannot
		// write) last.
		[
			"mkdir -p ro; touch ro/a ro/b; chmod 555 ro; LC_ALL=C find ro -type f -print -delete 2>&1; echo $?; chmod 755 ro",
			"ro/a\nfind: cannot delete 'ro/a': Permission denied\nro/b\nfind: cannot delete 'ro/b': Permission denied\n1\n",
			0,
		],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
