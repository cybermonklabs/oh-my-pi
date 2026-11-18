import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// the bytes GNU grep 3.11 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C, on input holding lines that are not valid
// UTF-8: there each byte is one character. The builtin reads no locale for
// this, so it answers so in every locale, where GNU in C.UTF-8 takes such a
// line for binary data. stderr is dropped. The outputs are Latin-1 strings,
// one character to a byte: `"caf\xe9"` is c, a, f and 0xE9.

// Two lines that are not UTF-8 - a Latin-1 0xE9 and a 0xC3 no continuation
// byte follows - beside plain ASCII ones.
const INPUT = Buffer.from("caf\xe9 foo\nx\xc3(y foo\nplain foo bar\ncafe\nf\xe9o\n", "latin1");

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-bytes-"));
	await fs.writeFile(path.join(dir, "in"), INPUT);
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell beside the input file `in`. stdout
 * goes to a file, whose bytes are returned: the shell streams its output to
 * the callback as text.
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

describe("builtin grep: each byte of a line that is not UTF-8 is one character", () => {
	cases([
		// The count reads the bytes alone, and already did.
		[String.raw`grep -c caf in`, "2\n", 0],
		// Regressed: `.` did not match the byte, so `f\xe9o` was not printed.
		[String.raw`grep -o 'f.o' in`, "foo\nfoo\nfoo\nf\xe9o\n", 0],
		// Regressed: nor was the line `caf\xe9 foo`.
		[String.raw`grep 'caf.' in`, "caf\xe9 foo\ncafe\n", 0],
		// Regressed: no line matched, exit 1.
		[String.raw`grep -n 'x.(' in`, "2:x\xc3(y foo\n", 0],
		// Regressed: a negated bracket expression did not hold the bytes.
		[String.raw`grep -v '[^a-z ]' in`, "plain foo bar\ncafe\n", 0],
		// Regressed: the rows below selected nothing.
		[String.raw`grep -x 'caf. foo' in`, "caf\xe9 foo\n", 0],
		[String.raw`grep -i 'X.(Y' in`, "x\xc3(y foo\n", 0],
		[String.raw`grep -o '\(.\)(' in`, "\xc3(\n", 0],
		[String.raw`cat in | grep -o 'x.('`, "x\xc3(\n", 0],
		// Regressed: the alternative `x.` matched nothing.
		[String.raw`grep -oE 'caf|x.' in`, "caf\nx\xc3\ncaf\n", 0],
		// Regressed: counted 0.
		[String.raw`grep -c '^.\{8\}$' in`, "2\n", 0],
	]);
});

describe("builtin grep: word edges and PCRE read such a line a byte to a character", () => {
	cases([
		// Regressed: the byte after `caf` was read as part of a word.
		[String.raw`grep -w caf in`, "caf\xe9 foo\n", 0],
		// Regressed: `f\xe9o` was not printed.
		[String.raw`grep -ow 'f.o' in`, "foo\nfoo\nfoo\nf\xe9o\n", 0],
		// Regressed: PCRE's `.` did not match the byte.
		[String.raw`grep -P 'caf.' in`, "caf\xe9 foo\ncafe\n", 0],
		[String.raw`grep -cP 'x.\(' in`, "1\n", 0],
	]);
});

describe("builtin grep: a match past the end of such a line is not the next line's", () => {
	cases([
		// GNU grep 3.11, LC_ALL=C: nothing, exit 1; `\B` matches nowhere in `a\351b` or `z`.
		// Regressed: `z` and exit 0, the empty match past the first line's newline taken for the second line's.
		[String.raw`printf 'a\351b\nz\n' | grep '\B'`, "", 1],
		// The same: nothing, exit 1. Regressed: `zz` and exit 0.
		[String.raw`printf 'a\351b\nzz\n' | grep -w 'x*'`, "", 1],
	]);
});
