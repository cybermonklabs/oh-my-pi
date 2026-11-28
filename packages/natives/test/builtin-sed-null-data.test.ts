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

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part S6): builtin sed -z: N, G, H, D and P join and split lines at a NUL > sed -z 'H;$!d;x' in
// Deleted (part S6): builtin sed -z: N, G, H, D and P join and split lines at a NUL > sed -z 'N;D' in
// Deleted (part S6): builtin sed -z: N, G, H, D and P join and split lines at a NUL > sed -z 'N;s/\n/-/g' in
// Deleted (part S6): builtin sed -z: N, G, H, D and P join and split lines at a NUL > sed -z -n 'N;P' in
// Deleted (part S6): builtin sed -z: N, G, H, D and P join and split lines at a NUL > sed -z G in
// Deleted (part S6): builtin sed -z: l > sed -z -n '1l 3' in
// Deleted (part S6): builtin sed -z: l > sed -z -n 'N;l' in
// Deleted (part S6): builtin sed -z: lines end at a NUL > cp in f; sed -z -i 's/^/X/' f; cat f
// Deleted (part S6): builtin sed -z: lines end at a NUL > printf 'a\0b' | sed -z 's/^/X/'
// Deleted (part S6): builtin sed -z: lines end at a NUL > sed -z 's/^/X/' <in
// Deleted (part S6): builtin sed -z: lines end at a NUL > sed -z 's/^/X/' in
// Deleted (part S6): builtin sed -z: lines end at a NUL > sed -z -n '$=' in
// Deleted (part S6): builtin sed -z: lines end at a NUL > sed -z -n '$p' in
// Deleted (part S6): builtin sed -z: lines end at a NUL > sed -z -n 'w w.txt' in; cat w.txt
// Deleted (part S6): builtin sed -z: the text of a, i and c > sed -z '1a foo' in
// Deleted (part S6): builtin sed -z: the text of a, i and c > sed -z '1c foo' in
// Deleted (part S6): builtin sed -z: the text of a, i and c > sed -z '1i foo' in

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
