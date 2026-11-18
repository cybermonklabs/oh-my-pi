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
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
}

describe("builtin sed: a line that is not UTF-8 passes through", () => {
	cases([
		// Regressed: every such line was refused with "stream did not contain valid UTF-8" and exit 2.
		[String.raw`sed 's/foo/X/' in`, "caf\xe9 X\nx\xc3(y X\nplain X bar\ncafe\nf\xe9o\n", 0],
		// Regressed: the same for standard input.
		[String.raw`cat in | sed 's/foo/X/'`, "caf\xe9 X\nx\xc3(y X\nplain X bar\ncafe\nf\xe9o\n", 0],
		// Regressed: an address on standard input was refused the same way.
		[String.raw`sed -n '/caf/p' <in`, "caf\xe9 foo\ncafe\n", 0],
		// Regressed: a count, `g`, and both together were refused.
		[String.raw`sed 's/o/0/2' in`, "caf\xe9 fo0\nx\xc3(y fo0\nplain fo0 bar\ncafe\nf\xe9o\n", 0],
		[String.raw`sed 's/o/0/g' in`, "caf\xe9 f00\nx\xc3(y f00\nplain f00 bar\ncafe\nf\xe90\n", 0],
		[String.raw`sed 's/o/0/2g' in`, "caf\xe9 fo0\nx\xc3(y fo0\nplain fo0 bar\ncafe\nf\xe9o\n", 0],
	]);
});

describe("builtin sed: each byte of such a line is one character", () => {
	cases([
		// Regressed: `.` did not match the byte, so `caf\xe9` was not replaced.
		[String.raw`sed 's/caf./X/' in`, "X foo\nx\xc3(y foo\nplain foo bar\nX\nf\xe9o\n", 0],
		// Regressed: refused with exit 2.
		[String.raw`sed 's/./-/g' in`, "--------\n--------\n-------------\n----\n---\n", 0],
		// Regressed: refused; a negated bracket expression holds each byte.
		[String.raw`sed 's/[^a-z ]/?/g' in`, "caf? foo\nx??y foo\nplain foo bar\ncafe\nf?o\n", 0],
		// Regressed: refused; an empty match falls on each side of each byte.
		[
			String.raw`sed 's/o*/-/g' in`,
			"-c-a-f-\xe9- -f-\n-x-\xc3-(-y- -f-\n-p-l-a-i-n- -f- -b-a-r-\n-c-a-f-e-\n-f-\xe9-\n",
			0,
		],
		// Regressed: the group did not capture the byte before `(`.
		[String.raw`sed -E 's/(.)\(/[\1]/' in`, "caf\xe9 foo\nx[\xc3]y foo\nplain foo bar\ncafe\nf\xe9o\n", 0],
		// Regressed: a back-reference was refused on such a line.
		[String.raw`sed -E 's/(o)\1/<&>/' in`, "caf\xe9 f<oo>\nx\xc3(y f<oo>\nplain f<oo> bar\ncafe\nf\xe9o\n", 0],
		// Regressed: so was the longest match of an alternation.
		[String.raw`sed -E 's/foo|caf/Z/g' in`, "Z\xe9 Z\nx\xc3(y Z\nplain Z bar\nZe\nf\xe9o\n", 0],
		// Regressed: `\xe9` did not match the byte 0xE9.
		[String.raw`sed 's/\xe9/e/g' in`, "cafe foo\nx\xc3(y foo\nplain foo bar\ncafe\nfeo\n", 0],
		// Regressed: refused; `\xe9` in a replacement writes the byte 0xE9.
		[String.raw`sed 's/(/\xe9/' in`, "caf\xe9 foo\nx\xc3\xe9y foo\nplain foo bar\ncafe\nf\xe9o\n", 0],
		// Regressed: an address with `.` did not match the line.
		[String.raw`sed '/x.(y/d' in`, "caf\xe9 foo\nplain foo bar\ncafe\nf\xe9o\n", 0],
	]);
});

describe("builtin sed: y and l work byte by byte", () => {
	cases([
		// Regressed: refused with exit 2.
		[String.raw`sed 'y/acfo/ACFO/' in`, "CAF\xe9 FOO\nx\xc3(y FOO\nplAin FOO bAr\nCAFe\nF\xe9O\n", 0],
		// Regressed: refused; `\xe9` maps the byte 0xE9.
		[String.raw`sed 'y/\xe9/e/' in`, "cafe foo\nx\xc3(y foo\nplain foo bar\ncafe\nfeo\n", 0],
		// Regressed: refused; each byte from 0x80 up is listed in octal.
		[String.raw`sed -n l in`, "caf\\351 foo$\nx\\303(y foo$\nplain foo bar$\ncafe$\nf\\351o$\n", 0],
		// Regressed: the same, folded at the width.
		[
			String.raw`sed -n 'l 5' in`,
			"caf\\\n\\351\\\n foo$\nx\\\n\\303\\\n(y f\\\noo$\nplai\\\nn fo\\\no ba\\\nr$\ncafe$\nf\\\n\\351\\\no$\n",
			0,
		],
	]);
});

describe("builtin sed: the bytes are kept in the hold space, N and w", () => {
	cases([
		// Regressed: each was refused with exit 2.
		[String.raw`sed 'N;s/\n/+/' in`, "caf\xe9 foo+x\xc3(y foo\nplain foo bar+cafe\nf\xe9o\n", 0],
		[String.raw`sed '1h;2G' in`, "caf\xe9 foo\nx\xc3(y foo\ncaf\xe9 foo\nplain foo bar\ncafe\nf\xe9o\n", 0],
		[String.raw`sed '1!G;h;$!d' in`, "f\xe9o\ncafe\nplain foo bar\nx\xc3(y foo\ncaf\xe9 foo\n", 0],
		[String.raw`sed 'x' in`, "\ncaf\xe9 foo\nx\xc3(y foo\nplain foo bar\ncafe\n", 0],
		[String.raw`sed 's/ /\n/;P;D' in`, "caf\xe9\nfoo\nx\xc3(y\nfoo\nplain\nfoo\nbar\ncafe\nf\xe9o\n", 0],
		// Regressed: refused with exit 2.
		["sed -n 'H;${x;p;}' in", "\ncaf\xe9 foo\nx\xc3(y foo\nplain foo bar\ncafe\nf\xe9o\n", 0],
		// Regressed: `w` wrote no line.
		[String.raw`sed -n '/foo/w w.txt' in; cat w.txt`, "caf\xe9 foo\nx\xc3(y foo\nplain foo bar\n", 0],
		// Regressed: nor did `s///w`.
		[String.raw`sed 's/foo/X/w w.txt' in >/dev/null; cat w.txt`, "caf\xe9 X\nx\xc3(y X\nplain X bar\n", 0],
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
