import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// the bytes GNU grep 3.11 writes on stdout, and the status it exits with, for
// the same command in the locale the case names, where a pattern, a file name
// or another argument holds a byte that is not UTF-8. stderr is dropped. The
// outputs are Latin-1 strings, one character to a byte: `"caf\xe9"` is c, a,
// f and 0xE9.

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

describe("builtin grep: a back-reference beside a pattern byte that is not UTF-8, in the C.UTF-8 locale", () => {
	// GNU grep 3.11 counts 1: the byte 0xC3 starts `é`. PCRE2, which runs a
	// back-reference, matches no such byte inside a character, so the
	// builtin refuses the patterns, exit 2, rather than count 0.
	cases([
		// Regressed: counted 0, exit 1.
		[
			String.raw`printf 'caf\303\251\n' | LC_ALL=C.UTF-8 grep -c -e $'\303' -e '\(x\)\1' 2>&1`,
			"grep: a back-reference beside a pattern byte that is not UTF-8 is not supported in a UTF-8 locale\n",
			2,
		],
	]);
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
