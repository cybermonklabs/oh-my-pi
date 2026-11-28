import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";
import { runInChild } from "./builtin-child";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// the bytes GNU grep 3.11 writes on stdout, and the status it exits with, for
// the same command in the locale the case names, where a pattern, a file name
// or another argument holds a byte that is not UTF-8. stderr is dropped. The
// outputs are Latin-1 strings, one character to a byte: `"caf\xe9"` is c, a,
// f and 0xE9.

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part G4b): builtin grep: a back-reference beside a pattern byte that is not UTF-8, in the C.UTF-8 locale > printf 'caf\303\251\n' | LC_ALL=C.UTF-8 grep -c -e $'\303' -e '\(x\)\1' -e '[a' 2>&1
// Deleted (part G4b): builtin grep: a back-reference beside a pattern byte that is not UTF-8, in the C.UTF-8 locale > printf 'caf\303\251\n' | LC_ALL=C.UTF-8 grep -c -e $'\303' -e '\(x\)\1' -e 'a\{2,1\}' 2>&1
// Deleted (part G4b): builtin grep: a back-reference beside a pattern byte that is not UTF-8, in the C.UTF-8 locale > printf 'caf\303\251\n' | LC_ALL=C.UTF-8 grep -c -e $'\303' -e '\(x\)\2' 2>&1

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-pattern-bytes-"));
	// `inv` holds lines that are not UTF-8, `u8` UTF-8 ones (`café`, `naïve`).
	await fs.writeFile(path.join(dir, "inv"), Buffer.from("caf\xe9\nab\xffc\nok\nx\xc3(y\n\xff\xfe\n", "latin1"));
	await fs.writeFile(path.join(dir, "u8"), "café\nabc\nnaïve\n");
	await fs.writeFile(path.join(dir, "g"), "a\nb\nc\na\n");
	await fs.writeFile(path.join(dir, "pf"), Buffer.from("\xe9\n", "latin1"));
	// `ctl` holds the control character 0x1C, which `\c\` is, before 0xE9 and before the text `x{E9}`.
	await fs.writeFile(path.join(dir, "ctl"), Buffer.from("a\x1c\xe9b\nx\x1cx{E9}\n", "latin1"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell beside the input files. stdout goes to
 * a file, whose bytes are returned: the shell streams its output to the
 * callback as text.
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

describe("builtin grep: a pattern byte that is not UTF-8, in the C locale", () => {
	cases([
		// Regressed: `-e` refused the argument ("invalid UTF-8 was detected in one or more arguments", exit 2).
		[String.raw`LC_ALL=C grep -e $'\351' inv`, "caf\xe9\n", 0],
		[String.raw`LC_ALL=C grep -w -e $'\351' inv`, "", 1],
		[String.raw`LC_ALL=C grep -x -e $'\377' inv`, "", 1],
		[String.raw`LC_ALL=C grep -F -e $'.\377' inv`, "", 1],
		// Regressed: the pattern was read as U+FFFD, so no line matched (exit 1).
		[String.raw`LC_ALL=C grep $'\351' inv`, "caf\xe9\n", 0],
		[String.raw`LC_ALL=C grep -E $'a|\377\376' inv`, "caf\xe9\nab\xffc\n\xff\xfe\n", 0],
		[String.raw`LC_ALL=C grep -P $'.\377' inv`, "ab\xffc\n", 0],
		// The byte after `\c` is its operand, taken as it is, which PCRE2 refuses ("\c must be followed by a
		// printable ASCII character"); in `\c\` the backslash is that operand, and the byte after it is itself.
		[String.raw`LC_ALL=C grep -P $'\\c\351' inv`, "", 2],
		[String.raw`LC_ALL=C grep -P $'\\c\\\351' ctl`, "a\x1c\xe9b\n", 0],
		[String.raw`LC_ALL=C grep -P $'\\c\\\\\351' ctl`, "a\x1c\xe9b\n", 0],
		// Already so: a negated list of U+FFFD held every byte of these lines too.
		[String.raw`LC_ALL=C grep -c $'[^\351]' inv`, "5\n", 0],
		// Regressed: the same for a pattern file.
		[String.raw`LC_ALL=C grep -f pf inv`, "caf\xe9\n", 0],
		// Regressed: in the C locale each byte of `é` is a character, which the
		// line `café` was not read as.
		[String.raw`LC_ALL=C grep -o $'[\303]' u8`, "\xc3\n\xc3\n", 0],
		[String.raw`LC_ALL=C grep -o $'f.\251' u8`, "f\xc3\xa9\n", 0],
		[String.raw`LC_ALL=C grep -i -e $'\303' u8`, "caf\xc3\xa9\nna\xc3\xafve\n", 0],
		// Regressed: a range's ends were checked as characters (the byte 0xC3 as one above `é`), "Invalid range end",
		// exit 2; GNU reads the bytes C3 - C3 A9 as the range C3-C3 and the byte A9.
		[String.raw`printf 'caf\303\251\n' | LC_ALL=C grep -c $'[\303-\303\251]'`, "1\n", 0],
		[String.raw`printf 'caf\303\251\n' | LC_ALL=C grep -o $'[\303-\303\251]'`, "\xc3\n\xa9\n", 0],
	]);
});

describe("builtin grep: a pattern byte that is not UTF-8, in the C.UTF-8 locale", () => {
	cases([
		// Regressed: refused, exit 2.
		[String.raw`LC_ALL=C.UTF-8 grep -a -e $'\351' inv`, "caf\xe9\n", 0],
		// Regressed: read as U+FFFD; GNU matches the byte, in a character too.
		[String.raw`LC_ALL=C.UTF-8 grep -c $'\303' u8`, "2\n", 0],
		[String.raw`LC_ALL=C.UTF-8 grep -c -F $'\303' u8`, "2\n", 0],
		// No character is such a byte: no member of a bracket expression (already
		// so, as U+FFFD), and a range's end is the character of its value (U+00E9
		// to U+00FF; regressed: no line matched).
		[String.raw`LC_ALL=C.UTF-8 grep -o $'[\303]' u8`, "", 1],
		[String.raw`LC_ALL=C.UTF-8 grep -c $'[^\303]' u8`, "3\n", 0],
		[String.raw`LC_ALL=C.UTF-8 grep -o $'[\351-\377]' u8`, "\xc3\xa9\n\xc3\xaf\n", 0],
		// PCRE2 refuses a pattern that is not UTF-8 ("UTF-8 error: 2 bytes missing at end").
		[String.raw`LC_ALL=C.UTF-8 grep -P $'\351' u8`, "", 2],
		// Regressed: a line that is not UTF-8 was read with the C locale's rule, where the byte is a member.
		[String.raw`printf 'caf\351\nab\377c\n' | LC_ALL=C.UTF-8 grep -c $'[\351]'`, "0\n", 1],
		[String.raw`printf 'caf\351\nab\377c\n' | LC_ALL=C.UTF-8 grep -c $'f[\351]'`, "0\n", 1],
		[String.raw`printf 'caf\351\n' | LC_ALL=C.UTF-8 grep -c $'[\300-\377]'`, "0\n", 1],
	]);
});

describe("builtin grep: a pattern with a pattern byte, on a line that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 matches a member of a bracket expression outside ASCII,
	// and `.`, only as the whole UTF-8 sequence of a character, and nothing
	// of an encoding error, in a line that is not UTF-8 as in one that is.
	cases([
		// Regressed: `[À-ÿ]` was written as bytes, {0xC3, 0x80-0xC3, 0xBF}, so the bytes 0xA9 and 0x90 matched.
		[String.raw`printf 'x\251\nq\220z\n' | LC_ALL=C.UTF-8 grep -c $'[\300-\377]'`, "0\n", 1],
		// Regressed: the two bytes of `é` matched one by one.
		[String.raw`printf '\377\303\251\n' | LC_ALL=C.UTF-8 grep -o $'[\300-\377]'`, "\xc3\xa9\n", 0],
		[
			String.raw`printf '\377\303\251\303\251\n' | LC_ALL=C.UTF-8 grep -o $'[\300-\377]\\{2\\}'`,
			"\xc3\xa9\xc3\xa9\n",
			0,
		],
		// Regressed: a byte of `中` matched.
		[String.raw`printf '\377\344\270\255\n' | LC_ALL=C.UTF-8 grep -o $'[\300-\377]'`, "", 1],
		// Regressed: under `-i`, the first byte of `É` matched.
		[String.raw`printf '\377\303\211\n' | LC_ALL=C.UTF-8 grep -io $'[\303\251\351]'`, "\xc3\x89\n", 0],
		// Regressed: a list that negates matched the byte 0xFF and each byte of `é`.
		[String.raw`printf '\303\251\377x\n' | LC_ALL=C.UTF-8 grep -o $'[^\300-\377]'`, "x\n", 0],
		[String.raw`printf '\377\303\251b\n' | LC_ALL=C.UTF-8 grep -o $'[^a\351]'`, "\xc3\xa9\nb\n", 0],
		// Regressed: the same for the engine a back-reference among the patterns uses.
		[String.raw`printf 'x\251\nq\220z\n' | LC_ALL=C.UTF-8 grep -c -e $'[\300-\377]' -e '\(k\)\1'`, "0\n", 1],
		[String.raw`printf '\377\303\251\n' | LC_ALL=C.UTF-8 grep -o -e $'[\300-\377]' -e '\(k\)\1'`, "\xc3\xa9\n", 0],
		// Regressed: `.` matched one byte, so it matched the byte 0xFF, a lone 0xC3, and half of `é`.
		[String.raw`printf 'x\377y\n' | LC_ALL=C.UTF-8 grep -c $'x.y\\|\351'`, "0\n", 1],
		[String.raw`printf 'x\303(\n' | LC_ALL=C.UTF-8 grep -o $'x.(\\|\351'`, "", 1],
		[String.raw`printf 'x\303\251y\377\n' | LC_ALL=C.UTF-8 grep -o $'x.y\\|\351'`, "x\xc3\xa9y\n", 0],
		[
			String.raw`printf 'a\303\251\303\251b\377\n' | LC_ALL=C.UTF-8 grep -o $'a.[\300-\377]b'`,
			"a\xc3\xa9\xc3\xa9b\n",
			0,
		],
	]);
});

describe("builtin grep: a pattern that is UTF-8, on a line that is not UTF-8, in the C.UTF-8 locale", () => {
	// The same as for a pattern with a pattern byte: GNU grep 3.11 reads a
	// bracket member outside ASCII, and `.`, as a whole character.
	cases([
		// Regressed: `[é]` was written as its two bytes, each a member, so 0xA9 matched.
		// `é` is written `\303\251` here: bun writes a raw template's `é` as the text `\u00E9`.
		[String.raw`printf 'x\251\n' | LC_ALL=C.UTF-8 grep -c $'[\303\251]'`, "0\n", 1],
		[String.raw`printf '\377\303\251\n' | LC_ALL=C.UTF-8 grep -o $'[\303\251]'`, "\xc3\xa9\n", 0],
		[String.raw`printf '\303\251\377x\n' | LC_ALL=C.UTF-8 grep -o $'[^\303\251]'`, "x\n", 0],
		// Regressed: `.` matched the byte 0xFF and a lone 0xC3, and not `é`.
		[String.raw`printf 'x\377y\n' | LC_ALL=C.UTF-8 grep -c 'x.y'`, "0\n", 1],
		[String.raw`printf 'x\303(\n' | LC_ALL=C.UTF-8 grep -o 'x.('`, "", 1],
		[String.raw`printf 'x\303\251y\377\n' | LC_ALL=C.UTF-8 grep -o 'x.y'`, "x\xc3\xa9y\n", 0],
	]);
});

describe("builtin grep: without case, on a line that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 matches the other case of a member outside ASCII, and
	// the lower-case letters with no upper case of their own (`ς`, `ſ`,
	// `ı`) for their upper case's other forms.
	cases([
		// Regressed: each counted 0, the other case dropped where Rust's case mapping is not one
		// character or is ASCII.
		[String.raw`printf '\317\202\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\316\243\351]'`, "1\n", 0],
		[String.raw`printf '\317\203\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\317\202\351]'`, "1\n", 0],
		[String.raw`printf '\316\274\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\302\265\351]'`, "1\n", 0],
		[String.raw`printf 's\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\305\277\351]'`, "1\n", 0],
		[String.raw`printf 'I\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\304\261\351]'`, "1\n", 0],
		[String.raw`printf '\305\277\377\n' | LC_ALL=C.UTF-8 grep -ic $'[s\351]'`, "1\n", 0],
		[String.raw`printf '\341\276\210\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\341\276\200\351]'`, "1\n", 0],
		// Regressed: a list that negates matched `ς`, the other case of `Σ`.
		[String.raw`printf '\317\202\377\n' | LC_ALL=C.UTF-8 grep -ic $'[^\316\243\351]'`, "0\n", 1],
	]);
});

describe("builtin grep: a pattern that is UTF-8, on a line that is not UTF-8, without case or at word edges", () => {
	// GNU grep 3.11 reads the characters of such a line in the C.UTF-8
	// locale: their other case, and whether they are word characters.
	cases([
		// Regressed: a character outside ASCII outside a bracket expression matched its own case alone.
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -ic $'\303\251'`, "1\n", 0],
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -c -i -e $'\303\251' -e zz`, "1\n", 0],
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -iFc $'\303\251'`, "1\n", 0],
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -io $'\303\251'`, "\xc3\x89\n", 0],
		[String.raw`printf '\317\203\377\n' | LC_ALL=C.UTF-8 grep -ic $'\316\243'`, "1\n", 0],
		[String.raw`printf '\305\277\377\n' | LC_ALL=C.UTF-8 grep -ic s`, "1\n", 0],
		[String.raw`printf 'S\377\n' | LC_ALL=C.UTF-8 grep -ic $'\305\277'`, "1\n", 0],
		// Regressed: `é` was no word character.
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c '^\w'`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c '^\W'`, "0\n", 1],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -cw a`, "0\n", 1],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -c 'a\b'`, "0\n", 1],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[String.raw`printf '\303\251a\377\n' | LC_ALL=C.UTF-8 grep -c '\<a'`, "0\n", 1],
	]);
});

describe("builtin grep: without case, a range whose ends are pattern bytes, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 matches a character whose upper case is in the range:
	// `[\300-\301]` matches `á`, and `[\340-\341]` neither `á` nor `Á`.
	cases([
		// Regressed: the range's characters matched in either case.
		[String.raw`printf '\303\201\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\340-\341]'`, "0\n", 1],
		[String.raw`printf '\303\241\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\340-\341]'`, "0\n", 1],
		[String.raw`printf '\303\201\n' | LC_ALL=C.UTF-8 grep -ic $'[\340-\341]'`, "0\n", 1],
		[String.raw`printf '\303\241\n' | LC_ALL=C.UTF-8 grep -ic $'[\340-\341]'`, "0\n", 1],
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\341-\351]'`, "0\n", 1],
		[String.raw`printf '\303\211\n' | LC_ALL=C.UTF-8 grep -ic $'[\341-\351]'`, "0\n", 1],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -ic $'[\341-\351]'`, "0\n", 1],
		[String.raw`printf '\303\241\n' | LC_ALL=C.UTF-8 grep -ic $'[^\340-\341]'`, "1\n", 0],
		[String.raw`printf '\303\241\n' | LC_ALL=C.UTF-8 grep -ic $'[a\340-\341]'`, "0\n", 1],
		// So with one end a pattern byte, the other end's upper case the range's start: `[z-\351]` is
		// `Z` to `é`. Regressed: `a` and `z`, whose upper cases are before the start, were in the range.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -ic $'[z-\351]'`, "0\n", 1],
		[String.raw`printf 'a\n' | LC_ALL=C.UTF-8 grep -ic $'[z-\351]'`, "0\n", 1],
		[String.raw`printf 'z\n' | LC_ALL=C.UTF-8 grep -ic $'[_-\351]'`, "0\n", 1],
		// Already GNU's answer, kept: `Z`, and `ý`, whose upper case `Ý` is in the range.
		[String.raw`printf 'Z\377\n' | LC_ALL=C.UTF-8 grep -ic $'[z-\351]'`, "1\n", 0],
		[String.raw`printf '\303\275\n' | LC_ALL=C.UTF-8 grep -ic $'[_-\351]'`, "1\n", 0],
		// Regressed: `µ` and the Kelvin sign, whose upper cases are past `é`, were in the range.
		[String.raw`printf '\302\265\377\n' | LC_ALL=C.UTF-8 grep -ic $'[a-\351]'`, "0\n", 1],
		[String.raw`printf '\302\265\n' | LC_ALL=C.UTF-8 grep -ic $'[a-\351]'`, "0\n", 1],
		[String.raw`printf '\342\204\252\n' | LC_ALL=C.UTF-8 grep -ic $'[a-\351]'`, "0\n", 1],
	]);
});

describe("builtin grep: a pattern byte among the patterns, on a line that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 reads the line's characters as it reads them where no
	// pattern holds a pattern byte: their other case, whether they are word
	// characters, and the letters of `[[:alpha:]]`.
	cases([
		// Regressed: each read as ASCII alone, `é` no letter and no case of `É`.
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -ic -e $'\303\251' -e $'\351x'`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c -e '^\w' -e $'\351x'`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c -e '^\W' -e $'\351x'`, "0\n", 1],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -cw -e a -e $'\351x'`, "0\n", 1],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -c -e 'a\b' -e $'\351x'`, "0\n", 1],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c -e '^[[:alpha:]]' -e $'\351x'`, "1\n", 0],
		[String.raw`printf '\317\203\377\n' | LC_ALL=C.UTF-8 grep -ic -e $'\316\243' -e $'\351x'`, "1\n", 0],
		[String.raw`printf 'I\377\n' | LC_ALL=C.UTF-8 grep -ic -e $'\304\261' -e $'\351x'`, "1\n", 0],
	]);
});

describe("builtin grep: -w beside a byte that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 takes a byte that is not UTF-8 for no word character
	// under `-w`.
	cases([
		// Regressed: nothing matched next to such a byte.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cw a`, "1\n", 0],
		[String.raw`printf '\377a\n' | LC_ALL=C.UTF-8 grep -cw a`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -Fcw a`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -Ecw a`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -cw $'\303\251'`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -ic -w $'\303\211'`, "1\n", 0],
		[String.raw`printf 'a\377b\n' | LC_ALL=C.UTF-8 grep -ow b`, "b\n", 0],
		[String.raw`printf 'x\377ab\n' | LC_ALL=C.UTF-8 grep -bow ab`, "2:ab\n", 0],
		[String.raw`printf 'ab\377c\n' | LC_ALL=C.UTF-8 grep -ow 'ab\|c'`, "ab\nc\n", 0],
		// Regressed: the second `a` alone was printed.
		[String.raw`printf 'a\377 a\n' | LC_ALL=C.UTF-8 grep -ow a`, "a\na\n", 0],
		// Regressed: a match that crossed the byte was refused, and the shorter one GNU takes,
		// which ends at the byte, was not tried.
		[String.raw`printf 'ab\377cd\n' | LC_ALL=C.UTF-8 grep -ow 'a.*'`, "ab\n", 0],
		[String.raw`printf 'a\377a\377\n' | LC_ALL=C.UTF-8 grep -cw 'a.*'`, "1\n", 0],
		[String.raw`printf '\377ab\377\n' | LC_ALL=C.UTF-8 grep -ow '[^x]*'`, "ab\n", 0],
		// Regressed: `-o` printed `a`, as the longest alternative was searched without the byte
		// as an edge.
		[String.raw`printf 'a b\377\n' | LC_ALL=C.UTF-8 grep -ow 'a\|a b'`, "a b\n", 0],
		// Already GNU's answer, kept: `$` holds at the end of the line alone, `é` is a word
		// character, and the byte 0x7F is a character.
		[String.raw`printf 'ab\377cd\n' | LC_ALL=C.UTF-8 grep -cw 'a.*$'`, "0\n", 1],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -cw a`, "0\n", 1],
		[String.raw`printf 'ab\377cd\n' | LC_ALL=C.UTF-8 grep -ow '[a-z]*'`, "ab\ncd\n", 0],
		[String.raw`printf 'ab\377cd\n' | LC_ALL=C.UTF-8 grep -bow cd`, "3:cd\n", 0],
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -ow 'a\|ab'`, "ab\n", 0],
		[String.raw`printf 'a\177b\377\n' | LC_ALL=C.UTF-8 grep -cw 'a.b'`, "1\n", 0],
		[String.raw`printf 'a\377\0' | LC_ALL=C.UTF-8 grep -zcw a`, "1\n", 0],
		// Regressed: the alternative holding a pattern byte, which matches the byte in the line
		// alone, was not printed, the shorter one in its stead.
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -aow $'a\\|a\377'`, "a\xff\n", 0],
		[String.raw`printf 'ab\377 c\n' | LC_ALL=C.UTF-8 grep -aow $'ab\\|ab\377'`, "ab\xff\n", 0],
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -aow $'a\377\\|a'`, "a\xff\n", 0],
		// Already GNU's answer, kept.
		[String.raw`printf 'x \377a b\n' | LC_ALL=C.UTF-8 grep -aow $'\377a'`, "\xffa\n", 0],
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -acw $'a\377\\|zz'`, "1\n", 0],
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -ao $'a\\|a\377'`, "a\xff\n", 0],
	]);
});

describe("builtin grep: a word assertion beside a byte that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 reads `\<`, `\>`, `\b` and `\B` with its regex matcher,
	// which takes such a byte for the character of its value: a word
	// character where that is a letter (0xFF is `ÿ`, 0xAA `ª`), else not
	// (0x80, 0xB2 `²`). Nothing else matches the byte.
	cases([
		// Regressed: the byte was no word character to the assertions.
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -c 'b\>\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -c 'b\B\|\(x\)\1'`, "1\n", 0],
		[String.raw`printf '\377ab\n' | LC_ALL=C.UTF-8 grep -c '\<a\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -cE 'b\>|(x)\1'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[String.raw`printf '\377ab\n' | LC_ALL=C.UTF-8 grep -c '\<a'`, "0\n", 1],
		[String.raw`printf 'a\252 b\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[String.raw`printf 'a\377_\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[String.raw`printf 'a\377\0' | LC_ALL=C.UTF-8 grep -zc 'a\>'`, "0\n", 1],
		[String.raw`printf 'A\377\n' | LC_ALL=C.UTF-8 grep -ic 'a\>'`, "0\n", 1],
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -cE 'b\b'`, "0\n", 1],
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -c 'b\w*\>'`, "0\n", 1],
		[String.raw`printf '\377\n' | LC_ALL=C.UTF-8 grep -c '\<'`, "1\n", 0],
		[String.raw`printf 'a\377b c\n' | LC_ALL=C.UTF-8 grep -ao '\<[a-z]\>'`, "c\n", 0],
		// Regressed: the `regex` crate read 0x80 as part of the `a` before it.
		[String.raw`printf 'a\200b c\n' | LC_ALL=C.UTF-8 grep -ao '\<[a-z]\>'`, "a\nb\nc\n", 0],
		// Regressed: `\B` held beside no byte whose character is no letter.
		[String.raw`printf '\200\n' | LC_ALL=C.UTF-8 grep -c '^\B'`, "1\n", 0],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -c '\B$'`, "1\n", 0],
		[String.raw`printf ' \200\n' | LC_ALL=C.UTF-8 grep -c ' \B'`, "1\n", 0],
		[String.raw`printf ' \200 \n' | LC_ALL=C.UTF-8 grep -o '\B.'`, " \n \n", 0],
		// Regressed: a line holding `_` and every digit was read as text.
		[String.raw`printf 'a\377 _0123456789\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[String.raw`printf 'a\377 _0123456789\n' | LC_ALL=C.UTF-8 grep -c 'a\>\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\377 _0123456789ZQXJ\n' | LC_ALL=C.UTF-8 grep -ic 'A\>'`, "0\n", 1],
		// Regressed: with a back-reference, `\B` did not hold at the end after such a byte.
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -c '\B$\|\(x\)\1'`, "1\n", 0],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -c '\(x\)\1\|\B'`, "1\n", 0],
		[String.raw`printf '\200\n' | LC_ALL=C.UTF-8 grep -c '\(x\)\1\|\B$'`, "1\n", 0],
		[String.raw`printf 'a\200\0' | LC_ALL=C.UTF-8 grep -zc '\B$\|\(x\)\1'`, "1\n", 0],
		// Regressed: a literal `ı` matched the byte without case, as `i`.
		[String.raw`printf 'zqxjvbpygfwmucldrhn \377\n' | LC_ALL=C.UTF-8 grep -ic $'\\<\304\261'`, "0\n", 1],
		[String.raw`printf 'zqxjvbpygfwmucldrhn \377\n' | LC_ALL=C.UTF-8 grep -ic $'\304\261\\|\\<q'`, "0\n", 1],
		// Regressed: a line holding every other stand-in was read as text, `i` left free.
		[String.raw`printf 'a\377 zqxjvbpygfwmucldrhnoate_0123456789\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[
			String.raw`printf 'a\377 zqxjvbpygfwmucldrhnoate_0123456789\n' | LC_ALL=C.UTF-8 grep -c 'a\>\|\(x\)\1'`,
			"0\n",
			1,
		],
		[String.raw`printf 'a\377 ZQXJVBPYGFWMUCLDRHNOATE_0123456789\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "0\n", 1],
		[
			String.raw`printf 'a\377 zqxjvbpygfwmucldrhnoate_0123456789 ab\n' | LC_ALL=C.UTF-8 grep -ow 'ab\>\|a'`,
			"a\nab\n",
			0,
		],
		// Already GNU's answer, kept: a byte whose character is no letter, `.`, `\B` beside a
		// word character, and `K` (U+212A), which is `k` without case.
		[String.raw`printf 'ab\200\n' | LC_ALL=C.UTF-8 grep -c 'b\>\|\(x\)\1'`, "1\n", 0],
		[String.raw`printf 'ab\377\n' | LC_ALL=C.UTF-8 grep -c 'b.\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf '\200ab\n' | LC_ALL=C.UTF-8 grep -c '\<a'`, "1\n", 0],
		[String.raw`printf 'a\262 b\n' | LC_ALL=C.UTF-8 grep -c 'a\>'`, "1\n", 0],
		[String.raw`printf '\200\n' | LC_ALL=C.UTF-8 grep -c '\<'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -c 'a\B'`, "0\n", 1],
		[String.raw`printf '\200a\n' | LC_ALL=C.UTF-8 grep -c '\Ba'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -c 'a$\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\200b\n' | LC_ALL=C.UTF-8 grep -c 'a.b\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\200b\n' | LC_ALL=C.UTF-8 grep -c 'a\Wb\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a \200\n' | LC_ALL=C.UTF-8 grep -c 'a\s*$\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\200b\0' | LC_ALL=C.UTF-8 grep -zc 'a.b\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'zqxjvbpygfwmucldrhno \377 I\n' | LC_ALL=C.UTF-8 grep -aio $'\\<\304\261'`, "I\n", 0],
		[String.raw`printf 'zqxjvbpygfwmucldrhn \377\n' | LC_ALL=C.UTF-8 grep -ic $'\\<\304\260'`, "0\n", 1],
		[String.raw`printf 'zqxjvbpygfwmucldrhn \377\n' | LC_ALL=C.UTF-8 grep -c $'\\<\304\261'`, "0\n", 1],
		[String.raw`printf 'a\377 k\342\204\252\n' | LC_ALL=C.UTF-8 grep -ic 'a\>\|\(x\)\1'`, "0\n", 1],
		[
			String.raw`printf 'a\377 z_0123456789 \342\204\252\n' | LC_ALL=C.UTF-8 grep -io '\(\w\)\1\|\<.'`,
			"a\nz\n\xe2\x84\xaa\n",
			0,
		],
	]);
});

describe("builtin grep: -x with a word assertion beside a byte that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 matches such a byte with nothing but a pattern byte, so
	// no such pattern matches a line holding one whole.
	cases([
		// Regressed: a piece of the line between such bytes was matched whole.
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cx 'a\>'`, "0\n", 1],
		[String.raw`printf '\200a\n' | LC_ALL=C.UTF-8 grep -cx '\<a'`, "0\n", 1],
		[String.raw`printf 'a\200b\n' | LC_ALL=C.UTF-8 grep -cx 'a\>\|b'`, "0\n", 1],
		[String.raw`printf 'x\200foo\n' | LC_ALL=C.UTF-8 grep -cx '\<foo\>'`, "0\n", 1],
		[String.raw`printf 'ab\200cd\n' | LC_ALL=C.UTF-8 grep -cx 'cd\>'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cx 'a\b.*'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cxw 'a\>'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cxE 'a\>.*|b'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -vcx 'a\>'`, "1\n", 0],
		// Already GNU's answer, kept.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx 'a\>.*'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cx 'a\>\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cx '.*'`, "0\n", 1],
	]);
});

describe("builtin grep: -x with a pattern byte and a word assertion, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 matches such a byte with a pattern byte alone, and reads
	// it as the character of its value for the word assertions, a word
	// character where that is a letter (0xFF is `ÿ`).
	cases([
		// Regressed: the assertions read the byte as no word character.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx $'a\\>\377'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx $'a\\B\377'`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cxi $'A\\B\377'`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -vcx $'a\\>\377'`, "1\n", 0],
		[String.raw`printf 'a\377b\n' | LC_ALL=C.UTF-8 grep -cx $'a\377\\Bb'`, "1\n", 0],
		[String.raw`printf 'a\377\351\n' | LC_ALL=C.UTF-8 grep -cx $'a\\B\377\\B\351'`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx $'a\\w*\\>\377'`, "0\n", 1],
		[String.raw`printf 'a\377 \n' | LC_ALL=C.UTF-8 grep -cxE $'a\377\\> |zz\\>'`, "1\n", 0],
		[String.raw`printf 'a\377\0' | LC_ALL=C.UTF-8 grep -zcx $'a\\B\377'`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -aox $'a\\B\377'`, "a\xff\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -ax $'a\\>\377'`, "", 1],
		[String.raw`printf 'a\377\nb\n' | LC_ALL=C.UTF-8 grep -ax $'a\\B\377\\|b'`, "a\xff\nb\n", 0],
		// Regressed: under `-i` the guard made a class read with case into a class of other members.
		[String.raw`printf 'b\377\n' | LC_ALL=C.UTF-8 grep -cxi $'[a]\\B\377'`, "0\n", 1],
		[String.raw`printf 'Z\377\n' | LC_ALL=C.UTF-8 grep -cxi $'[a]\\B\377'`, "0\n", 1],
		[String.raw`printf '_\377\n' | LC_ALL=C.UTF-8 grep -cxi $'[a]\\B\377'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cxi $'[^a]\\B\377'`, "0\n", 1],
		[String.raw`printf 'a\377c\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\B\377[b]'`, "0\n", 1],
		[String.raw`printf 'a\377b\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\B\377[^b]'`, "0\n", 1],
		[String.raw`printf 'a\377d\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\B\377[a-c]'`, "0\n", 1],
		[String.raw`printf 'a\377c\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\B\377[\303\251]'`, "0\n", 1],
		[String.raw`printf 'a\377c\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\B\377[b[:digit:]]'`, "0\n", 1],
		[String.raw`printf 'a\377c\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\>\377[b]\\|a\\B\377[b]'`, "0\n", 1],
		// Regressed: PCRE2, which runs a back-reference, matched the byte with `.`, `[^x]` and `\w`.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'[\351]' -e '\<a.\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'[\351]' -e '\<a[^x]\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'[\351]' -e '\<a\w\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx $'\\(a\\)\\1*.\\|\\<[\377]'`, "0\n", 1],
		// Regressed: a pattern's own U+A0FF matched the byte 0xFF.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'a\352\203\277' -e $'\\<\377'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx $'a\352\203\277\\|\\<\377'`, "0\n", 1],
		// Regressed: a line holding U+A080 was read as text, where the assertions read 0xFF as no word character.
		[String.raw`printf 'a\377 \352\202\200\n' | LC_ALL=C.UTF-8 grep -cx $'a\\>\377 \352\202\200'`, "0\n", 1],
		// Not GNU's answer before: the same line as text matched no pattern byte beside `\B`, `.` or `-i`.
		[String.raw`printf 'a\377 \352\202\200\n' | LC_ALL=C.UTF-8 grep -cx $'a\\B\377 \352\202\200'`, "1\n", 0],
		[String.raw`printf 'A\377 \352\202\200\n' | LC_ALL=C.UTF-8 grep -cxi $'a\\B\377 \352\202\200'`, "1\n", 0],
		[String.raw`printf 'a\377\352\202\277\n' | LC_ALL=C.UTF-8 grep -cx $'a\\B\377.'`, "1\n", 0],
		// Already GNU's answer, kept: another byte, a byte whose character is no letter, and `.`.
		[String.raw`printf 'a\351\n' | LC_ALL=C.UTF-8 grep -cx $'a\\B\377'`, "0\n", 1],
		[String.raw`printf 'a\200\n' | LC_ALL=C.UTF-8 grep -cx $'a\\>\200'`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx $'a.\\>'`, "0\n", 1],
		// Already GNU's answer, kept: a class with case under `-i`, and patterns holding U+A080, U+A100, U+A180 or U+A0FF.
		[String.raw`printf 'A\377\n' | LC_ALL=C.UTF-8 grep -cxi $'[a]\\B\377'`, "1\n", 0],
		[String.raw`printf 'b\377\n' | LC_ALL=C.UTF-8 grep -cxi $'[^a]\\B\377'`, "1\n", 0],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'a\\>\377' -e $'\352\202\200'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'a\\B\377' -e $'\352\202\200'`, "1\n", 0],
		[
			String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'a\\>\377' -e $'\352\202\200\352\204\200\352\206\200'`,
			"0\n",
			1,
		],
		[
			String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cx -e $'a\\B\377' -e $'\352\202\200\352\204\200\352\206\200'`,
			"1\n",
			0,
		],
		[String.raw`printf 'a\352\203\277\n' | LC_ALL=C.UTF-8 grep -cx -e $'a\352\203\277' -e $'\\<\377'`, "1\n", 0],
	]);
});

describe("builtin grep: -w with a word assertion beside a byte that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 reads such a byte whose character is a letter as a word
	// character for the assertions, and as none for `-w`'s edges.
	cases([
		// Regressed: the assertions read the byte as no word character.
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -cw 'a\>'`, "0\n", 1],
		[String.raw`printf '\377b c\n' | LC_ALL=C.UTF-8 grep -cw '\<b'`, "0\n", 1],
		[String.raw`printf 'x\377a b\n' | LC_ALL=C.UTF-8 grep -cw '\ba'`, "0\n", 1],
		[String.raw`printf 'A\377 b\n' | LC_ALL=C.UTF-8 grep -ciw 'a\>'`, "0\n", 1],
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -cwE 'a\>|zz'`, "0\n", 1],
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -ow 'a\>\|b'`, "b\n", 0],
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -cw 'a\>\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf '\377b c\n' | LC_ALL=C.UTF-8 grep -cw '\<b\|\(x\)\1'`, "0\n", 1],
		[String.raw`printf 'a\377b c\n' | LC_ALL=C.UTF-8 grep -ow 'a\B'`, "a\n", 0],
		// Regressed: a shorter alternative was printed, not the longest whose edges hold.
		[String.raw`printf '\200a b cd\n' | LC_ALL=C.UTF-8 grep -aow '\<a\|a b\|a b c'`, "a b\n", 0],
		// Regressed: beside a back-reference the alternatives were not searched apart.
		[String.raw`printf '\200a b cd\n' | LC_ALL=C.UTF-8 grep -aow '\<a\|a b\|\(x\)\1'`, "a b\n", 0],
		[String.raw`printf '\200a b cd\n' | LC_ALL=C.UTF-8 grep -aow '\<a\|a b\|a b c\(\)\1'`, "a b\n", 0],
		[String.raw`printf 'a b cd\n' | LC_ALL=C.UTF-8 grep -ow '\<a\|a b\|\(x\)\1'`, "a b\n", 0],
		[String.raw`printf 'ab ab\n' | LC_ALL=C.UTF-8 grep -o 'a\|ab\|\(x\)\1'`, "ab\nab\n", 0],
		// Already GNU's answer, kept: `-w`'s edges beside the byte, and the longest match at a
		// start whose edges hold.
		[String.raw`printf 'a\377 b\n' | LC_ALL=C.UTF-8 grep -cw a`, "1\n", 0],
		[String.raw`printf '\377b c\n' | LC_ALL=C.UTF-8 grep -cw 'b\>'`, "1\n", 0],
		[String.raw`printf '\377b c\n' | LC_ALL=C.UTF-8 grep -cw 'b\>\|\(x\)\1'`, "1\n", 0],
		[String.raw`printf 'a\200 b\n' | LC_ALL=C.UTF-8 grep -cw 'a\>'`, "1\n", 0],
		[String.raw`printf 'a\377b c\n' | LC_ALL=C.UTF-8 grep -ow 'b\>'`, "b\n", 0],
		[String.raw`printf 'abc\377d\n' | LC_ALL=C.UTF-8 grep -ow '\<a[a-z]*'`, "abc\n", 0],
		[String.raw`printf '\377ab c9\n' | LC_ALL=C.UTF-8 grep -ow 'a[a-z ]*\|\<q'`, "ab\n", 0],
		[String.raw`printf '\377ab c\n' | LC_ALL=C.UTF-8 grep -ow 'a\|ab\>'`, "ab\n", 0],
		[String.raw`printf 'ab\377 ab x\n' | LC_ALL=C.UTF-8 grep -ow '\<a\|\<ab'`, "ab\nab\n", 0],
		[String.raw`printf '\377a b cd\n' | LC_ALL=C.UTF-8 grep -aow 'a\>\|a b\|a b c'`, "a b\n", 0],
		[String.raw`printf '\200a b cd x\n' | LC_ALL=C.UTF-8 grep -aow '\<a b c\|\<a'`, "a\n", 0],
		[String.raw`printf 'a b cd\n' | LC_ALL=C.UTF-8 grep -ow '\<a\|a b\|a b c'`, "a b\n", 0],
		[String.raw`printf '\200a b cd\n' | LC_ALL=C.UTF-8 grep -aow -e '\<a' -e 'a b' -e '\(x\)\1'`, "a b\n", 0],
		[String.raw`printf '\200a b cd\n' | LC_ALL=C.UTF-8 grep -acw '\<a\|a b\|\(x\)\1'`, "1\n", 0],
		[String.raw`printf 'aa b\n' | LC_ALL=C.UTF-8 grep -o '\(a\)\1\|a\|b'`, "aa\nb\n", 0],
		[String.raw`printf 'xx\n' | LC_ALL=C.UTF-8 grep -o '\(a\)\|\(x\)\2'`, "xx\n", 0],
	]);
});

describe("builtin grep: -P on a line that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 reads such a line under `-P` with PCRE2's UTF mode, and
	// without its Unicode properties: `\w` and `[[:alpha:]]` hold no `é`,
	// while `é` is a character, of either case, and no encoding error
	// matches.
	cases([
		// Regressed: `é` matched each, counted 1.
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -P -c '^\w'`, "0\n", 1],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -P -c '\w'`, "0\n", 1],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -P -c '[[:alpha:]]'`, "0\n", 1],
		// Regressed: the word test read `é` as a word character, counted 0.
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -P -cw a`, "1\n", 0],
		[String.raw`printf 'x\303\251y\377\n' | LC_ALL=C.UTF-8 grep -P -cw y`, "1\n", 0],
		// Already GNU's answer, kept.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -P -cw a`, "1\n", 0],
		[String.raw`printf 'a\377b\n' | LC_ALL=C.UTF-8 grep -P -c 'a.b'`, "0\n", 1],
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -P -ic $'\303\251'`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -P -c '\x{e9}'`, "1\n", 0],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -P -o '.'`, "\xc3\xa9\n", 0],
		[String.raw`printf 'a\377b\n' | LC_ALL=C grep -P -c 'a.b'`, "1\n", 0],
	]);
});

describe("builtin grep: without case, the counterparts GNU gives a letter", () => {
	// GNU grep 3.11 matches a letter's upper case, that one's lower case,
	// and the lower-case letters with no upper case of their own for them
	// (`ı` for `I` and `i`): not the Kelvin sign for `k`, the Ångström sign
	// for `å`, the Ohm sign for `ω` or `ẞ` for `ß`, which Unicode's folding
	// adds.
	cases([
		// Regressed: each counted 1.
		[String.raw`printf '\342\204\252\n' | LC_ALL=C.UTF-8 grep -ic k`, "0\n", 1],
		[String.raw`printf '\342\204\252\377\n' | LC_ALL=C.UTF-8 grep -ic k`, "0\n", 1],
		[String.raw`printf 'k\377\n' | LC_ALL=C.UTF-8 grep -ic $'\342\204\252'`, "0\n", 1],
		[String.raw`printf '\342\204\252\n' | LC_ALL=C.UTF-8 grep -iFc k`, "0\n", 1],
		[String.raw`printf '\342\204\253\377\n' | LC_ALL=C.UTF-8 grep -ic $'\303\245'`, "0\n", 1],
		[String.raw`printf '\342\204\253\377\n' | LC_ALL=C.UTF-8 grep -ic $'\303\205'`, "0\n", 1],
		[String.raw`printf '\342\204\246\n' | LC_ALL=C.UTF-8 grep -ic $'\317\211'`, "0\n", 1],
		[String.raw`printf '\341\272\236\n' | LC_ALL=C.UTF-8 grep -ic $'\303\237'`, "0\n", 1],
		// Regressed: each counted 0.
		[String.raw`printf 'I\n' | LC_ALL=C.UTF-8 grep -ic $'\304\261'`, "1\n", 0],
		[String.raw`printf 'I\377\n' | LC_ALL=C.UTF-8 grep -ic $'\304\261'`, "1\n", 0],
		// Already GNU's answer, kept: `É` for `é`, and `K` for `k` beside a back-reference.
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -ic $'\303\251'`, "1\n", 0],
		[String.raw`printf 'ka\n' | LC_ALL=C.UTF-8 grep -ic 'K\(a\)\1*'`, "1\n", 0],
	]);
});

describe("builtin grep: a back-reference among the patterns, on a line that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 reads the characters of such a line as in a line that is
	// UTF-8: `é` is a letter and a word character, of either case.
	cases([
		// Regressed: each read `é` as no letter, or without case.
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c '^\w\|\(x\)\1'`, "1\n", 0],
		[String.raw`printf '\303\211\377\n' | LC_ALL=C.UTF-8 grep -ic -e $'\303\251' -e '\(x\)\1'`, "1\n", 0],
		[String.raw`printf 'a\303\251\377\n' | LC_ALL=C.UTF-8 grep -cw -e a -e '\(x\)\1'`, "0\n", 1],
		[String.raw`printf '\303\251\377\n' | LC_ALL=C.UTF-8 grep -c -e '^[[:alpha:]]' -e '\(x\)\1'`, "1\n", 0],
		// Already GNU's answer, kept.
		[String.raw`printf 'x\377y\n' | LC_ALL=C.UTF-8 grep -c -e 'x.y' -e '\(q\)\1'`, "0\n", 1],
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 grep -cw -e '\(a\)\1*'`, "1\n", 0],
	]);
});

describe("builtin grep: a back-reference beside a pattern byte that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 counts 1: the byte 0xC3 starts `é`. PCRE2, which runs a
	// back-reference, matches no such byte inside a character, so the
	// builtin refuses the patterns, exit 2, with a message that names `grep`,
	// rather than count 0.
	const refused = String.raw`printf 'caf\303\251\n' | LC_ALL=C.UTF-8 grep -c -e $'\303' -e '\(x\)\1' 2>&1`;
	it(refused, async () => {
		// Regressed: counted 0, exit 1.
		const { child, exitCode, output } = await runInChild(dir, refused, { stderr: true });
		expect({ child, exitCode }).toEqual({ child: 0, exitCode: 2 });
		expect(output.toString()).toMatch(/^grep: /);
	});
});

describe("builtin grep: other arguments that are not UTF-8", () => {
	cases([
		// A file operand opens the file of that name, and is printed as its bytes;
		// already so.
		[String.raw`printf 'x\n' >$'\377'; LC_ALL=C grep -H x $'\377'`, "\xff:x\n", 0],
		// Regressed: the separator was refused, exit 2.
		[String.raw`LC_ALL=C grep -A0 --group-separator=$'\351' a g`, "a\n\xe9\na\n", 0],
	]);
});
