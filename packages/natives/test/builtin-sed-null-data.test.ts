import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command, in the C locale and in C.UTF-8 alike; each comment gives
// GNU's output as `od -c` prints it. Under `-z` (`--null-data`) a line ends
// at a NUL instead of a newline. stderr is dropped. The outputs are Latin-1
// strings, one character to a byte.

// Two lines ended by a NUL, each holding a newline.
const INPUT = Buffer.from("a\nb\0c\nd\0", "latin1");

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-null-data-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell beside a fresh copy of the input file
 * `in`. stdout goes to a file, whose bytes are returned: the shell streams
 * its output to the callback as text.
 */
async function run(command: string): Promise<{ output: Buffer; exitCode: number | undefined }> {
	await fs.writeFile(path.join(dir, "in"), INPUT);
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
}

describe("builtin sed -z: lines end at a NUL", () => {
	cases([
		// `X a \n b \0 X c \n d \0`. Regressed: -z was ignored, and each newline ended a line.
		[String.raw`sed -z 's/^/X/' in`, "Xa\nb\0Xc\nd\0", 0],
		// The same for standard input: `X a \n b \0 X c \n d \0`.
		[String.raw`sed -z 's/^/X/' <in`, "Xa\nb\0Xc\nd\0", 0],
		// A last line without its NUL is written without one: `X a \0 X b`.
		[String.raw`printf 'a\0b' | sed -z 's/^/X/'`, "Xa\0Xb", 0],
		// `$` is the last of those lines: `c \n d \0`.
		[String.raw`sed -z -n '$p' in`, "c\nd\0", 0],
		// `=` ends the number with a NUL: `2 \0`.
		[String.raw`sed -z -n '$=' in`, "2\0", 0],
		// -i writes the file so: `X a \n b \0 X c \n d \0`.
		[String.raw`cp in f; sed -z -i 's/^/X/' f; cat f`, "Xa\nb\0Xc\nd\0", 0],
		// So does w: `a \n b \0 c \n d \0`.
		[String.raw`sed -z -n 'w w.txt' in; cat w.txt`, "a\nb\0c\nd\0", 0],
	]);
});

describe("builtin sed -z: N, G, H, D and P join and split lines at a NUL", () => {
	cases([
		// `a - b \0 c - d \0`: N joined the two lines, which keep their newlines.
		[String.raw`sed -z 'N;s/\n/-/g' in`, "a-b\0c-d\0", 0],
		// `a \n b \0 \0 c \n d \0 \0`.
		[String.raw`sed -z G in`, "a\nb\0\0c\nd\0\0", 0],
		// `\0 a \n b \0 c \n d \0`.
		[String.raw`sed -z 'H;$!d;x' in`, "\0a\nb\0c\nd\0", 0],
		// D deletes up to the first NUL: `c \n d \0`.
		[String.raw`sed -z 'N;D' in`, "c\nd\0", 0],
		// P prints up to the first NUL: `a \n b \0`.
		[String.raw`sed -z -n 'N;P' in`, "a\nb\0", 0],
	]);
});

describe("builtin sed -z: the text of a, i and c", () => {
	cases([
		// a writes its text as it is, ended by a newline: `a \n b \0 f o o \n c \n d \0`.
		[String.raw`sed -z '1a foo' in`, "a\nb\0foo\nc\nd\0", 0],
		// i and c end it with a NUL: `f o o \0 a \n b \0 c \n d \0` and `f o o \0 c \n d \0`.
		[String.raw`sed -z '1i foo' in`, "foo\0a\nb\0c\nd\0", 0],
		[String.raw`sed -z '1c foo' in`, "foo\0c\nd\0", 0],
	]);
});

describe("builtin sed -z: l", () => {
	cases([
		// A newline and a NUL of the pattern space are escapes, and a NUL ends
		// each line listed: `a \ n b \ 0 0 0 c \ n d $ \0`.
		[String.raw`sed -z -n 'N;l' in`, "a\\nb\\000c\\nd$\0", 0],
		// Folded at the width: `a \ \0 \ n \ \0 b $ \0`.
		[String.raw`sed -z -n '1l 3' in`, "a\\\0\\n\\\0b$\0", 0],
	]);
});

describe("builtin sed -z: ^ and $ under the M flag", () => {
	cases([
		// `^` matches after a NUL, not after a newline: `X a \n b \0 X c \n d \0`.
		[String.raw`sed -z 'N;s/^/X/Mg' in`, "Xa\nb\0Xc\nd\0", 0],
		// `$` matches before a NUL: `a \n b X \0 c \n d X \0`.
		[String.raw`sed -z 'N;s/$/X/Mg' in`, "a\nbX\0c\ndX\0", 0],
		// No match holds the NUL: `a \n b \0 c \n d \0`.
		[String.raw`sed -z 'N;s/b.c/X/M' in`, "a\nb\0c\nd\0", 0],
	]);
});
