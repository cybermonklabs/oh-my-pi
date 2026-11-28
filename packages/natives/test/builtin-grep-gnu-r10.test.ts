import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` and `nl` as builtins. Each expectation
// below is the bytes GNU grep 3.11 (or GNU nl, coreutils 9) writes on stdout,
// and the status it exits with, for the same command under LC_ALL=C.UTF-8.
// The outputs are Latin-1 strings, one character to a byte: `"\xc3\x9f"` is
// the two bytes of `ß`. stderr is dropped, unless a command sends it to
// stdout itself (`2>&1`).

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part G9): builtin grep: a long option's abbreviation > grep -r --inc '*.x' foo tree
// Deleted (part G9): builtin grep: a long option's abbreviation > grep -r --inc='*.x' foo tree
// Deleted (part G9): builtin grep: a long option's abbreviation > printf 'a\na\n' | grep --m 1 a
// Deleted (part G9): builtin grep: a long option's abbreviation > printf 'a\na\n' | grep --m=1 a

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part G6): builtin grep: a brace that makes no interval after an anchor > printf 'a{1,2,3}\n' | grep -cE 'a${1,2,3}'
// Deleted (part G6): builtin grep: a brace that makes no interval after an anchor > printf 'x{1,2,3}\n' | grep -cE '\b{1,2,3}'
// Deleted (part G6): builtin grep: a brace that makes no interval after an anchor > printf '{1,2,3}\n' | grep -cE '^{1,2,3}'
// Deleted (part G6): builtin grep: a malformed interval > printf 'a\n' | grep 'a\{1,2,3\}' 2>&1
// Deleted (part G6): builtin grep: a malformed interval > printf 'a\n' | grep 'a\{\}' 2>&1
// Deleted (part G6): builtin grep: a malformed interval > printf 'a\n' | grep -E 'a{2,1}' 2>&1
// Deleted (part G6): builtin grep: a malformed interval > printf 'a\n' | nl -bp'a\{1,2,3\}' 2>&1
// Deleted (part G6): builtin grep: a malformed interval > printf 'a{1\n' | grep -cE 'a{1'
// Deleted (part G6): builtin grep: a malformed interval > printf 'a{1x}\n' | grep -cE 'a{1x}'
// Deleted (part G6): builtin grep: a malformed interval > printf 'a{}\n' | grep -cE 'a{}'
// Deleted (part G6): builtin grep: an interval count above 32767 > printf 'a\n' | grep -c 'a\{1,32768\}'
// Deleted (part G6): builtin grep: an interval count above 32767 > printf 'a\n' | grep -c 'a\{32768\}'
// Deleted (part G6): builtin grep: an interval count above 32767 > printf 'a\n' | grep -cE 'a{32768,}'
// Deleted (part G6): builtin grep: an interval count above 32767 > printf 'a\n' | nl -bp'a\{1,32768\}'

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-r10-"));
	await fs.writeFile(path.join(dir, "abc"), "a\nb\nc\n");
	// Seventy patterns that are not plain strings, one past the other's text.
	await fs.writeFile(path.join(dir, "many"), Array.from({ length: 70 }, (_, n) => `q${n}x.\n`).join(""));
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

describe("builtin grep: a malformed interval", () => {
	cases([
		// Regressed: `-E` reads `a{1,2,3}` as text, counts the line and exits 0; GNU refuses a second comma with "Invalid content of \{\}" and exits 2.
		[String.raw`printf 'a{1,2,3}\n' | grep -cE 'a{1,2,3}'`, "", 2],
		// Regressed: the same where the pattern ends after the second comma.
		[String.raw`printf 'a{1,2,\n' | grep -cE 'a{1,2,'`, "", 2],
		// Regressed: the same for an empty maximum before it.
		[String.raw`printf 'a{1,,}\n' | grep -cE 'a{1,,}'`, "", 2],
	]);
});

describe("builtin grep: a brace that makes no interval after an anchor", () => {
	cases([
		// Regressed: an interval with no count is refused with "Invalid content of \{\}" and exit 2; GNU parses no repetition after `^` and reads the brace as text.
		[String.raw`printf '{}\n' | grep -cE '^{}'`, "1\n", 0],
		// Regressed: the same at the start of a later branch.
		[String.raw`printf '{}\n' | grep -cE 'x|^{}'`, "1\n", 0],
		// Regressed: the same after a repeated `^`.
		[String.raw`printf '{1,2,3}\n' | grep -cE '^*{1,2,3}'`, "1\n", 0],
		// Regressed: the same after `\B`.
		[String.raw`printf '{}\n' | grep -cE '\B{}'`, "1\n", 0],
		// The same in a BRE.
		[String.raw`printf '{}\n' | grep -c '\B\{\}'`, "1\n", 0],
		// After any other atom GNU refuses it, a group that holds an anchor included.
		[String.raw`printf 'x{1,2,3}\n' | grep -cE '\w{1,2,3}'`, "", 2],
		[String.raw`printf 'x\n' | grep -cE '(^){1,2,3}'`, "", 2],
	]);
});

describe("builtin grep: an interval count above 32767", () => {
	cases([
		// Regressed: after an anchor GNU's ERE still reads the count, prints "Regular expression too big" and exits 2.
		[String.raw`printf 'a\n' | grep -cE '^{32768}'`, "", 2],
		// 32767 is the most GNU allows.
		[String.raw`printf 'a\n' | grep -c 'a\{32767\}'`, "0\n", 1],
		// A BRE's `\{` with nothing to repeat is text, whatever its count.
		[String.raw`printf '{32768}\n' | grep -c '\{32768\}'`, "1\n", 0],
		// So is a brace that makes no interval in an ERE.
		[String.raw`printf '{x\n' | grep -cE '{x'`, "1\n", 0],
		[String.raw`printf '{1\n' | grep -c '\{1'`, "1\n", 0],
	]);
});

describe("builtin grep: `^` after an assertion in a BRE", () => {
	cases([
		// Regressed: `^` after `\<` anchors, so the line `a` is selected; GNU reads it as a caret and selects nothing.
		[String.raw`printf 'a\n^a\n' | grep -n '\<^a'`, "", 1],
		// Regressed: after `` \` `` the caret is text, which GNU finds in the line `^a`.
		[String.raw`printf 'a\n^a\n' | grep -n '\`^a'`, "2:^a\n", 0],
		// Regressed: the same at the start of a later branch.
		[String.raw`printf 'a\n^a\n' | grep -n 'x\|\<^a'`, "", 1],
		// Regressed: GNU nl numbers the line holding the caret, not the line `a`.
		[String.raw`printf 'a\n^a\n' | nl -bp'\`^a'`, "       a\n     1\t^a\n", 0],
	]);
});

describe("builtin grep: the classes of a pattern list holding a back-reference", () => {
	cases([
		// Regressed: `[[:digit:]]` matches `٠` once a back-reference sends the patterns to PCRE2; GNU's digits are ASCII.
		[String.raw`printf '\331\240\331\240\n' | grep -c '\([[:digit:]]\)\1'`, "0\n", 1],
		// Regressed: a back-reference in another pattern changes what `[[:digit:]]` matches.
		[String.raw`printf 'x\331\240\n' | grep -c -e '[[:digit:]]$' -e '\(y\)\1'`, "0\n", 1],
		// Regressed: the same for a fullwidth `Ａ` and `[[:xdigit:]]`.
		[String.raw`printf '\357\274\241\n' | grep -c -e '[[:xdigit:]]' -e '\(y\)\1'`, "0\n", 1],
		// Regressed: `Ⅻ` is a letter to GNU, and no letter to PCRE2's `[[:alpha:]]`.
		[String.raw`printf '\342\205\253\n' | grep -c -e '^[[:alpha:]]$' -e '\(y\)\1'`, "1\n", 0],
		// Regressed: `ª` is lower case to GNU, and no lower-case letter to PCRE2.
		[String.raw`printf '\302\252\n' | grep -c -e '^[[:lower:]]$' -e '\(y\)\1'`, "1\n", 0],
		// Without case `[[:lower:]]` is `[[:alpha:]]` to GNU, with a back-reference or not.
		[String.raw`printf 'A\n' | grep -ci -e '^[[:lower:]]$' -e '\(y\)\1'`, "1\n", 0],
		// Regressed: `中` has no case, and GNU counts it all the same.
		[String.raw`printf '\344\270\255\n' | grep -ci '^[[:lower:]]$'`, "1\n", 0],
		// Regressed: a no-break space is a space to PCRE2, which a back-reference sends the patterns to, and not to GNU.
		[String.raw`printf 'x\302\240\n' | grep -c -e '[[:space:]]$' -e '\(y\)\1'`, "0\n", 1],
		// Regressed: the same for a list that negates it.
		[String.raw`printf 'x\302\240\n' | grep -c -e 'x[^[:space:]]$' -e '\(y\)\1'`, "1\n", 0],
		// A tab is a space either way.
		[String.raw`printf 'x\t\n' | grep -c -e 'x[[:space:]]$' -e '\(y\)\1'`, "1\n", 0],
	]);
});

describe("builtin grep: a range read without case", () => {
	cases([
		// Regressed: `[a-Z]` is written unchanged, which the engine refuses, and grep exits 2; GNU's range under -i runs from `A` to `Z`.
		[String.raw`printf 'b\n' | grep -ic '[a-Z]'`, "1\n", 0],
		// Regressed: `[A-z]` holds `_` between `Z` and `a`; GNU's range under -i runs from `A` to `Z`.
		[String.raw`printf '_\n' | grep -ic '[A-z]'`, "0\n", 1],
		// Regressed: the same with a back-reference, which PCRE2 refuses.
		[String.raw`printf 'b\n' | grep -ic '\(x\)\1\|[a-Z]'`, "1\n", 0],
	]);
});

describe("builtin grep: a long option's abbreviation", () => {
	cases([
		// Ambiguous among GNU's own options.
		["grep --in a abc", "", 2],
	]);
});

describe("builtin grep: the group separator under -z", () => {
	cases([
		// Regressed: `--` ends with a NUL; GNU ends it with a newline.
		[String.raw`printf 'a\0x\0y\0a\0' | grep -z -C0 a`, "a\0--\na\0", 0],
		// Regressed: the same between context groups.
		[String.raw`printf 'a\0x\0y\0a\0' | grep -z -A1 a`, "a\0x\0--\na\0", 0],
		// Regressed: the same under -o.
		[String.raw`printf 'a\0x\0y\0z\0a\0' | grep -z -o -C0 a`, "a\0--\na\0", 0],
		// Regressed: the same for a separator of one's own.
		[String.raw`printf 'a\0x\0y\0z\0a\0' | grep -z --group-separator=XX -C0 a`, "a\0XX\na\0", 0],
	]);
});

describe("builtin grep: count and file-name records under -z", () => {
	const files = String.raw`printf 'a\0a\0' >in1; printf 'b\0' >in2;`;
	cases([
		// Regressed: each count ends with a NUL; GNU ends it with a newline.
		[`${files} grep -zc a in1 in2`, "in1:2\nin2:0\n", 0],
		// Regressed: the same for a count of standard input.
		[String.raw`printf 'a\0a\0' | grep -zc a`, "2\n", 0],
		// Regressed: a file name -l prints ends with a NUL; GNU ends it with a newline.
		[`${files} grep -zl a in1 in2`, "in1\n", 0],
		// Regressed: the same for -L.
		[`${files} grep -zL a in1 in2`, "in2\n", 0],
		// Regressed: under -Z the name ends with a NUL, and the count after it with a newline.
		[`${files} grep -zcZ a in1 in2`, "in1\x002\nin2\x000\n", 0],
		// -Z ends a file name -l prints with a NUL.
		[`${files} grep -zlZ a in1 in2`, "in1\0", 0],
		// A selected record still ends with a NUL.
		[String.raw`printf 'a\0b\0' | grep -z a`, "a\0", 0],
	]);
});

describe("builtin grep: -o with several patterns", () => {
	cases([
		// The longest of several plain strings at each position.
		[String.raw`printf 'abcd ab\n' | grep -o -e ab -e abc -e a`, "abc\nab\n", 0],
		// The same without case.
		[String.raw`printf 'abcd ab\n' | grep -oi -e AB -e abc -e a`, "abc\nab\n", 0],
		// The same as whole words: no string ends a word in `abcd`.
		[String.raw`printf 'abcd ab\n' | grep -ow -e ab -e abc -e a`, "ab\n", 0],
		// Fixed strings without case.
		[String.raw`printf 'x ab ABC\n' | grep -oiF -e A -e ABC -e b`, "a\nb\nABC\n", 0],
		// A few patterns that are not plain strings, beside plain ones.
		[String.raw`printf 'abcd ab\n' | grep -oE -e 'a|abc' -e 'b+c' -e x`, "abc\na\n", 0],
		[String.raw`printf 'aaa bab\n' | grep -o -e 'a\+' -e ba -e bab -e b`, "aaa\nbab\n", 0],
		// Past the patterns searched one by one, the matches are still printed.
		[String.raw`printf 'q0xa q69xb\n' | grep -o -f many`, "q0xa\nq69xb\n", 0],
	]);
});

describe("builtin grep: --help", () => {
	cases([
		// Regressed: a source comment on the `-e` option, "Read as its bytes, as every argument is: see
		// [`bre::pattern_text`].", was printed as two lines of the help.
		["grep --help | grep -c 'Read as its bytes'", "0\n", 1],
	]);
});
