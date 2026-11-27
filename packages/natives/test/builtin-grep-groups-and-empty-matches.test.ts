import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// what GNU grep 3.11 prints and exits with for the same command, so a script
// an agent writes means the same thing in the tool as in a terminal.

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part G1): builtin grep: -e or -f ending a cluster that starts with a context count > grep -2f -1 in
// Deleted (part G1): builtin grep: -e or -f ending a cluster that starts with a context count > grep -5e mid ctx
// Deleted (part G1): builtin grep: -e or -f ending a cluster that starts with a context count > grep -n2e mid ctx

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-groups-"));
	await fs.writeFile(path.join(dir, "in"), "-5\n-1\nx\nzz\nb\n");
	await fs.writeFile(path.join(dir, "ab"), "abc\nzz\nxxzz\nZZ\naab\n");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** Runs `command` in the builtin shell; `output` holds stdout and stderr as the shell streams them. */
async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	let output = "";
	const result = await executeShell({ command, cwd: dir }, (_error, chunk) => {
		output += chunk;
	});
	return { output, exitCode: result.exitCode };
}

describe("builtin grep: -o beside a pattern whose every match is empty", () => {
	// GNU prints, at each position, the longest match of any pattern; a
	// pattern that matches only the empty string there does not hide a longer
	// match of another pattern.
	it.each([
		// Regressed: `-o` prints nothing although `zz` matches two lines.
		["-o -e 'q\\?' -e zz ab", "zz\nzz\n"],
		// Regressed: `-o` prints nothing although `zz` matches two lines.
		["-oE -e '()' -e zz ab", "zz\nzz\n"],
		// Regressed: `-o` prints only `xx` and drops the `zz` matches.
		["-o -e 'x*' -e zz ab", "zz\nxx\nzz\n"],
	])("grep %s prints the other pattern's matches", async (args, stdout) => {
		expect(await run(`grep ${args} 2>/dev/null`)).toEqual({ output: stdout, exitCode: 0 });
	});
});

describe("builtin grep: -m0 selects no line", () => {
	// GNU answers `-m0` without opening any input: exit 1, nothing printed.
	it("grep -m0 -q with a missing file exits 1 with no message", async () => {
		// Regressed: grep reports the missing file and exits 2, so a caller sees an error.
		expect(await run("grep -m0 -q x nosuchfile")).toEqual({ output: "", exitCode: 1 });
	});

	it("grep -m0 -c prints no count", async () => {
		// Regressed: grep prints a count line `0` that GNU grep does not print.
		expect(await run("grep -m0 -c x in 2>/dev/null")).toEqual({ output: "", exitCode: 1 });
	});
});
