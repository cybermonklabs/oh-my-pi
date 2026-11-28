import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C, on input holding lines that are not valid
// UTF-8: there each byte is one character. The builtin reads such a line so
// in every locale. stderr is dropped. The outputs are Latin-1 strings, one
// character to a byte: `"caf\xe9"` is c, a, f and 0xE9.

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part S8): builtin sed: a line that is not UTF-8 passes through > cat in | sed 's/foo/X/'
// Deleted (part S8): builtin sed: a line that is not UTF-8 passes through > sed 's/foo/X/' in
// Deleted (part S8): builtin sed: a line that is not UTF-8 passes through > sed 's/o/0/2' in
// Deleted (part S8): builtin sed: a line that is not UTF-8 passes through > sed 's/o/0/g' in
// Deleted (part S8): builtin sed: a line that is not UTF-8 passes through > sed -n '/caf/p' <in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed '/x.(y/d' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed 's/./-/g' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed 's/[^a-z ]/?/g' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed 's/caf./X/' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed 's/o*/-/g' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed -E 's/(.)\(/[\1]/' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed -E 's/(o)\1/<&>/' in
// Deleted (part S8): builtin sed: each byte of such a line is one character > sed -E 's/foo|caf/Z/g' in
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed '1!G;h;$!d' in
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed '1h;2G' in
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed 'N;s/\n/+/' in
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed 's/ /\n/;P;D' in
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed 's/foo/X/w w.txt' in >/dev/null; cat w.txt
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed 'x' in
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed -n '/foo/w w.txt' in; cat w.txt
// Deleted (part S8): builtin sed: the bytes are kept in the hold space, N and w > sed -n 'H;${x;p;}' in
// Deleted (part S8): builtin sed: the output of s///e keeps its bytes > echo x | sed 's/x/printf "\\377a"/e'
// Deleted (part S8): builtin sed: the output of s///e keeps its bytes > printf 'x\n' | sed 's/.*/printf "a\\351b"/e'
// Deleted (part S8): builtin sed: y and l work byte by byte > sed 'y/acfo/ACFO/' in
// Deleted (part S8): builtin sed: y and l work byte by byte > sed -n 'l 5' in
// Deleted (part S8): builtin sed: y and l work byte by byte > sed -n l in

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part S9): builtin sed: a line that is not UTF-8 passes through > sed 's/o/0/2g' in

// Two lines that are not UTF-8 - a Latin-1 0xE9 and a 0xC3 no continuation
// byte follows - beside plain ASCII ones.
const INPUT = Buffer.from("caf\xe9 foo\nx\xc3(y foo\nplain foo bar\ncafe\nf\xe9o\n", "latin1");

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-bytes-"));
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
	const result = await executeShell(
		{ command: `{ export LC_ALL=C; ${command}\n} >out 2>/dev/null`, cwd: dir },
		() => {},
	);
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
}

describe("builtin sed: each byte of such a line is one character", () => {
	cases([
		// Regressed: `\xe9` did not match the byte 0xE9.
		[String.raw`sed 's/\xe9/e/g' in`, "cafe foo\nx\xc3(y foo\nplain foo bar\ncafe\nfeo\n", 0],
		// Regressed: refused; `\xe9` in a replacement writes the byte 0xE9.
		[String.raw`sed 's/(/\xe9/' in`, "caf\xe9 foo\nx\xc3\xe9y foo\nplain foo bar\ncafe\nf\xe9o\n", 0],
	]);
});

describe("builtin sed: y and l work byte by byte", () => {
	cases([
		// Regressed: refused; `\xe9` maps the byte 0xE9.
		[String.raw`sed 'y/\xe9/e/' in`, "cafe foo\nx\xc3(y foo\nplain foo bar\ncafe\nfeo\n", 0],
	]);
});

describe("builtin sed: an empty match inside a character of a line that is UTF-8", () => {
	cases([
		// GNU, in the C and the C.UTF-8 locale alike: `printf 'caf\303\251\n' | sed 's/x*/-/g' | od -c`
		// is `- c - a - f - 303 - 251 - \n`, an empty match at each byte, inside the `é` too.
		// Regressed: "internal error" and exit 1.
		[String.raw`printf 'caf\303\251\n' | sed 's/x*/-/g'`, "-c-a-f-\xc3-\xa9-\n", 0],
		// `od -c` of GNU's output, in both locales: `- 303 - 251 - 303 - 251 - \n`.
		[String.raw`printf '\303\251\303\251\n' | sed 's/x*/-/g'`, "-\xc3-\xa9-\xc3-\xa9-\n", 0],
		// The same for the longest match of an alternation.
		[String.raw`printf '\303\251\303\251\n' | sed -E 's/a*|b/-/g'`, "-\xc3-\xa9-\xc3-\xa9-\n", 0],
	]);
});

describe("builtin sed: an empty match inside a character, beside a back-reference", () => {
	cases([
		// GNU, in the C and the C.UTF-8 locale alike: `printf 'caf\303\251\n' | sed 's/\(x\)*\1*/-/g' | od -c`
		// is `- c - a - f - 303 - 251 - \n`. Regressed: `-c-a-f-\303\251-`, no match inside the `é`.
		[String.raw`printf 'caf\303\251\n' | sed 's/\(x\)*\1*/-/g'`, "-c-a-f-\xc3-\xa9-\n", 0],
		// The same with -E: `- c - a - f - 303 - 251 - \n`.
		[String.raw`printf 'caf\303\251\n' | sed -E 's/(x)*\1*/-/g'`, "-c-a-f-\xc3-\xa9-\n", 0],
		// The fifth match is the one inside the `é`: `c a f 303 - 251 \n`.
		// Regressed: `caf\303\251-`.
		[String.raw`printf 'caf\303\251\n' | sed 's/\(x\)*\1*/-/5'`, "caf\xc3-\xa9\n", 0],
		// The same for the longest match of an alternation: `- c - a - f - 303 - 251 - \n`.
		[String.raw`printf 'caf\303\251\n' | sed 's/y\|\(x\)*\1*/-/g'`, "-c-a-f-\xc3-\xa9-\n", 0],
		// A character of three bytes: `- 346 - 227 - 245 - \n`.
		[String.raw`printf '\346\227\245\n' | sed 's/\(x\)*\1*/-/g'`, "-\xe6-\x97-\xa5-\n", 0],
	]);
});

describe("builtin sed: the output of s///e keeps its bytes", () => {
	cases([
		// `Z Z Z \n`: the output is a line that is not UTF-8, each byte one character. Already
		// GNU's answer, kept.
		[String.raw`printf 'x\n' | sed 's/.*/printf "a\\351b"/e;s/./Z/g'`, "ZZZ\n", 0],
	]);
});
