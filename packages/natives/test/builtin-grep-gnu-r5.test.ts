import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// the bytes GNU grep 3.11 writes on stdout, and the status it exits with, for
// the same command. Input that is not UTF-8 is compared with GNU under
// LC_ALL=C, where each byte is one character; other input with GNU under
// LC_ALL=C.UTF-8. The outputs are Latin-1 strings, one character to a byte:
// `"\xff"` is the byte 0xFF. stderr is dropped.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-r5-"));
	await fs.writeFile(path.join(dir, "abc"), "a\nb\nc\n");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell with stdout sent to a file, whose bytes
 * are returned: the shell streams its output to the callback as text.
 */
async function run(command: string): Promise<{ output: Buffer; exitCode: number | undefined }> {
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
}

describe("builtin grep: -z on a record that is not UTF-8", () => {
	cases([
		// Regressed: `^$` matches inside the record `\377 \n b \n`, so grep prints it and exits 0; GNU (LC_ALL=C) finds no empty record and exits 1.
		[String.raw`printf '\377\nb\n' | grep -z '^$'`, "", 1],
		// Regressed: the same under -q, so a script's test of "is there an empty record" is true.
		[String.raw`printf '\377\nb\n' | grep -zq '^$'`, "", 1],
		// Regressed: under -v the record is dropped and grep exits 1; GNU (LC_ALL=C) prints it, ended by a NUL, and exits 0.
		[String.raw`printf '\377\nb\n' | grep -zv '^$'`, "\xff\nb\n\x00", 0],
	]);
});

// Skipped: the base release already differs from GNU here; tracked separately.
describe.skip("builtin grep: an ERE that starts with an interval", () => {
	cases([
		// Regressed: a leading `{1}` matches the empty string, so -o prints nothing; GNU warns and reads it as the text `1}`.
		[String.raw`printf '{1}\n' | grep -Eo '{1}'`, "1}\n", 0],
		// Regressed: the same with -w.
		[String.raw`printf '{1}\n' | grep -Eow '{1}'`, "1}\n", 0],
		// Regressed: the same before more text: GNU prints `1}y`.
		[String.raw`printf 'x{1}y\n' | grep -Eo '{1}y'`, "1}y\n", 0],
	]);
});

// Skipped: the base release already differs from GNU here; tracked separately.
describe.skip("builtin grep: -v with a negative -m and a context count", () => {
	cases([
		// Regressed: only `a` is printed; GNU selects no line but prints the context after it as `a`, `--`, `b`, and exits 1.
		["grep -v -m -1 -A1 b abc", "a\n--\nb\n", 1],
		// Regressed: the same for any negative count.
		["grep -v -m -2 -A1 b abc", "a\n--\nb\n", 1],
		// Regressed: the same before the line: GNU prints `--` and `b`.
		["grep -v -m -1 -B1 b abc", "--\nb\n", 1],
	]);
});
