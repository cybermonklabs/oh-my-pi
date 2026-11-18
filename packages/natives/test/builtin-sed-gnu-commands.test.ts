import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command, in the C locale and in C.UTF-8 alike; each comment gives
// GNU's output as `od -c` prints it. stderr is dropped. The outputs are
// Latin-1 strings, one character to a byte.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-commands-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell beside fresh copies of the files it
 * reads: `in` holds `1\n2\n3\n`, `nb` and `nd` hold `a\nb` and `c\nd`, each
 * without its last newline, and `f` holds `x\n`; `o`, which `w o` writes, is
 * removed first. stdout goes to a file, whose bytes are returned: the shell
 * streams its output to the callback as text.
 */
async function run(command: string): Promise<{ output: Buffer; exitCode: number | undefined }> {
	await Bun.write(path.join(dir, "in"), "1\n2\n3\n");
	await Bun.write(path.join(dir, "nb"), "a\nb");
	await Bun.write(path.join(dir, "nd"), "c\nd");
	await Bun.write(path.join(dir, "f"), "x\n");
	await fs.rm(path.join(dir, "o"), { force: true });
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
}

describe("builtin sed: n prints the pattern space and reads the next line", () => {
	cases([
		// `a \n c \n`. Regressed: `n` ended the cycle, and every line was printed: `a \n b \n c \n`.
		[String.raw`printf 'a\nb\nc\n' | sed 'n;d'`, "a\nc\n", 0],
		// `b \n`. Regressed: nothing was printed.
		[String.raw`printf 'a\nb\nc\n' | sed -n 'n;p'`, "b\n", 0],
		// `a \n 2 \n b \n c \n`; with no next line `n` ends the script, so the third line gets no number.
		// Regressed: no number at all.
		[String.raw`printf 'a\nb\nc\n' | sed 'n;='`, "a\n2\nb\nc\n", 0],
		// `a \n X b`. Regressed: `a \n b`.
		[String.raw`printf 'a\nb' | sed 'n;s/^/X/'`, "a\nXb", 0],
		// `a \n A \n X Y b \n X c \n`: the text of `a` comes before the line `n` reads. Regressed: `a \n A \n X b \n X c \n`.
		[String.raw`printf 'a\nb\nc\n' | sed -e '1{a A' -e 'n;s/^/Y/}' -e 's/^/X/'`, "a\nA\nXYb\nXc\n", 0],
		// `1 \n 2 \n 3 \n X 1 \n 2 \n 3 \n`: `n` reads on into the next file. Regressed: no `X`.
		[String.raw`sed 'n;n;n;s/^/X/' in in`, "1\n2\n3\nX1\n2\n3\n", 0],
		// `1 \n 2 \n 3 \n 1 \n 2 \n 3 \n`: under -s it does not. Already GNU's answer, kept.
		[String.raw`sed -s 'n;n;n;s/^/X/' in in`, "1\n2\n3\n1\n2\n3\n", 0],
	]);
});

describe("builtin sed: a # after a command starts a comment", () => {
	cases([
		// Regressed: each of these was refused with "extra characters at the end of the … command"
		// or "invalid substitute flag: '#'", and exit 1.
		// `a \n a \n b \n b \n`.
		[String.raw`printf 'a\nb\n' | sed 'p#c'`, "a\na\nb\nb\n", 0],
		// `a \n b \n`.
		[String.raw`printf 'a\nb\n' | sed -n 'p # c'`, "a\nb\n", 0],
		// Nothing.
		[String.raw`printf 'a\nb\n' | sed 'd#c'`, "", 0],
		// `a \n b \n`.
		[String.raw`printf 'a\nb\n' | sed '2q#c'`, "a\nb\n", 0],
		// `2 \n`.
		[String.raw`printf 'a\nb\n' | sed -n '$=#c'`, "2\n", 0],
		// `a $ \n b $ \n`.
		[String.raw`printf 'a\nb\n' | sed -n 'l 3#c'`, "a$\nb$\n", 0],
		// `A \n b \n`.
		[String.raw`printf 'a\nb\n' | sed 'y/a/A/#c'`, "A\nb\n", 0],
		// `X \n`.
		[String.raw`printf 'a\nb\n' | sed -n 's/a/X/p#c'`, "X\n", 0],
		// `X \n`.
		[String.raw`printf 'a\nb\n' | sed -n 's/a/X/gp # c'`, "X\n", 0],
		// `a \n`.
		[String.raw`printf 'a\nb\n' | sed -n '/a/{p}#c'`, "a\n", 0],
		// `a \n`.
		[String.raw`printf 'a\nb\n' | sed -n '1{p}#c'`, "a\n", 0],
		// Nothing: a label ends at a `#` too.
		[String.raw`printf 'a\nb\n' | sed -n ':a#c'`, "", 0],
		// Nothing, and exit 4: the label is `a`, which no `:` defines ("can't find label for jump to `a'").
		[String.raw`printf 'a\nb\n' | sed -n 'ba#c'`, "", 4],
		// The same.
		[String.raw`printf 'a\nb\n' | sed -n '/b/ba#c'`, "", 4],
		// `X \n b \n`: `:a#c` defines the label `a`.
		[String.raw`printf 'a\nb\n' | sed -n -e ':a#c' -e 's/a/X/;ta;p'`, "X\nb\n", 0],
		// `X \n b \n`: a label holds any character but a blank, `;`, `}` and `#`.
		[String.raw`printf 'a\nb\n' | sed -n -e ':a+b' -e 's/a/X/;ta+b;p'`, "X\nb\n", 0],
		// `a \n b \n`. Already GNU's answer, kept.
		[String.raw`printf 'a\nb\n' | sed -n 'p;#c'`, "a\nb\n", 0],
	]);
});

describe("builtin sed: l lists each byte of a UTF-8 character in octal", () => {
	cases([
		// `c a f \ 3 0 3 \ 2 5 1   o k $ \n`. Regressed: `caf\u00E9 ok$`.
		[String.raw`printf 'caf\303\251 ok\n' | LC_ALL=C sed -n l`, "caf\\303\\251 ok$\n", 0],
		// The same in C.UTF-8.
		[String.raw`printf 'caf\303\251 ok\n' | LC_ALL=C.UTF-8 sed -n l`, "caf\\303\\251 ok$\n", 0],
		// `c a f \ \n \ 3 0 3 \ \n \ 2 5 1 \ \n   o k $ \n`: folding parts the escapes and splits none.
		// Regressed: `caf\` and `\u00E9\`.
		[String.raw`printf 'caf\303\251 ok\n' | LC_ALL=C sed -n 'l 5'`, "caf\\\n\\303\\\n\\251\\\n ok$\n", 0],
		// The same in C.UTF-8.
		[String.raw`printf 'caf\303\251 ok\n' | LC_ALL=C.UTF-8 sed -n 'l 5'`, "caf\\\n\\303\\\n\\251\\\n ok$\n", 0],
		// `\ 3 6 0 \ 2 3 7 \ 2 4 6 \ 2 0 0 $ \n`. Regressed: `\U0001F980$`.
		[String.raw`printf '\360\237\246\200\n' | sed -n l`, "\\360\\237\\246\\200$\n", 0],
		// `a b c $ \n`: a width of 0 folds nothing. Regressed: `\`, `a\`, `b\`, `c$`, a fold before each byte.
		[String.raw`echo abc | sed -n 'l 0'`, "abc$\n", 0],
		// `c a f \ 3 0 3 \ 2 5 1 $ \n`. Regressed: a fold before each byte.
		[String.raw`printf 'caf\303\251\n' | sed -n 'l 0'`, "caf\\303\\251$\n", 0],
	]);
});

describe("builtin sed: r ends a last line that lacks its newline", () => {
	cases([
		// `a \n x \n`. Regressed: `a x \n`.
		[String.raw`printf 'a' | sed 'r f'`, "a\nx\n", 0],
		// The same where `$!N` leaves the line alone. Regressed: `a x \n`.
		[String.raw`printf 'a' | sed '$!N;r f'`, "a\nx\n", 0],
		// `a \n`: the newline is written for a file that cannot be read too. Regressed: `a`.
		[String.raw`printf 'a' | sed 'r nonexistent'`, "a\n", 0],
		// `a \n x \n`: `N` with no next line prints the pattern space before the text of `r`.
		// Regressed: `x \n a \n`.
		[String.raw`printf 'a' | sed -e '1r f' -e N`, "a\nx\n", 0],
		// `a \0 x \n`: under -z the line ends at a NUL. Regressed: `a x \n`.
		[String.raw`printf 'a' | sed -z 'r f'`, "a\0x\n", 0],
		// `x \n`: no line was printed, so none is ended. Already GNU's answer, kept.
		[String.raw`printf 'a' | sed -n 'r f'`, "x\n", 0],
	]);
});

describe("builtin sed: a negated bracket expression holds no newline under M", () => {
	cases([
		// `X \n b \n c \n`. Regressed: `X \n`, the match running over the newlines.
		[String.raw`printf 'a\nb\nc\n' | sed 'N;N;s/[^x]*$/X/M'`, "X\nb\nc\n", 0],
		// `a X \n X a \n`. Regressed: `a X X X a \n`.
		[String.raw`printf 'ab\nba\n' | sed 'N;s/[^a]/X/Mg'`, "aX\nXa\n", 0],
		// `a X \n X b \n`. Regressed: `a X X X b \n`.
		[String.raw`printf 'a1\n2b\n' | sed 'N;s/[^[:alpha:]]/X/Mg'`, "aX\nXb\n", 0],
		// `X \n X \n`. Regressed: `X \n`.
		[String.raw`printf 'ab\ncd\n' | sed -E 'N;s/[^x]+/X/Mg'`, "X\nX\n", 0],
		// `a b \n X \n`. Regressed: `a b \n c d \n`.
		[String.raw`printf 'ab\ncd\n' | sed 'N;s/[^x]*/X/M2'`, "ab\nX\n", 0],
		// `X \n X \0 X \n X \0`: under -z too. Regressed: `X \0 X \0`.
		[String.raw`printf 'a\nb\0c\nd\0' | sed -z 'N;s/[^x]*/X/Mg'`, "X\nX\0X\nX\0", 0],
		// `a X b X c \n`: `\W` still matches the newline. Already GNU's answer, kept.
		[String.raw`printf 'a b\nc\n' | sed 'N;s/\W/X/Mg'`, "aXbXc\n", 0],
		// `X X \n X X \n`. Already GNU's answer, kept.
		[String.raw`printf 'ab\ncd\n' | sed 'N;s/[^\n]/X/Mg'`, "XX\nXX\n", 0],
		// `a X X X a \n`: without M the newline is a member. Already GNU's answer, kept.
		[String.raw`printf 'ab\nba\n' | sed 'N;s/[^a]/X/g'`, "aXXXa\n", 0],
	]);
});

describe("builtin sed: a last line that lacks its newline keeps lacking it", () => {
	cases([
		// `a \n b` in `o`. Regressed: `a \n b \n`.
		[String.raw`printf 'a\nb' | sed -n 'w o'; cat o`, "a\nb", 0],
		// `X` in `o`. Regressed: `X \n`.
		[String.raw`printf 'a\nb' | sed -n 's/b/X/w o'; cat o`, "X", 0],
		// `a \0 b` in `o`. Regressed: `a \0 b \0`.
		[String.raw`printf 'a\0b' | sed -z -n 'w o'; cat o`, "a\0b", 0],
		// `a \n b`. Regressed: `a \n b \n`.
		[String.raw`printf 'a\nb' | sed -n 'w /dev/stdout'`, "a\nb", 0],
		// `a \n a \n b b`: GNU keeps the newline `w /dev/stdout` lacks apart from the one the printed
		// line lacks. Regressed: `a \n a \n b \n b`.
		[String.raw`printf 'a\nb' | sed 'w /dev/stdout'`, "a\na\nbb", 0],
		// `a a \n a`. Regressed: `a \n a \n a`.
		[String.raw`printf 'a' | sed 'p;w /dev/stdout'`, "aa\na", 0],
		// `a \n b \n c`: `N` with no next line prints the pattern space as it is. Regressed: `a \n b \n c \n`.
		[String.raw`printf 'a\nb\nc' | sed N`, "a\nb\nc", 0],
		// `a`. Regressed: `a \n`.
		[String.raw`printf 'a' | sed N`, "a", 0],
		// `a \n b \n c \n d`: the newline `nb` lacks is written before the first line of `nd`.
		// Regressed: `a \n b c \n d`.
		[String.raw`sed '' nb nd`, "a\nb\nc\nd", 0],
		// The same under -s. Regressed: `a \n b c \n d`.
		[String.raw`sed -s '' nb nd`, "a\nb\nc\nd", 0],
		// The same. Regressed: `a \n b c \n d`.
		[String.raw`sed -s N nb nd`, "a\nb\nc\nd", 0],
		// The same. Regressed: `a \n b c \n d`.
		[String.raw`sed -s '$!N' nb nd`, "a\nb\nc\nd", 0],
		// The same. Regressed: `a \n b \n c \n d \n`.
		[String.raw`sed -s 'N;N;N' nb nd`, "a\nb\nc\nd", 0],
		// `a \n b \n c \n d` in `o`. Regressed: `a \n b \n c \n d \n`.
		[String.raw`sed -s -n 'w o' nb nd; cat o`, "a\nb\nc\nd", 0],
		// `a \n a \n b b \n c \n \n c \n d d`. Regressed: `a \n a \n b \n b c \n c \n d \n d`.
		[String.raw`sed 'w /dev/stdout' nb nd`, "a\na\nbb\nc\n\nc\ndd", 0],
		// `x \n a \n b x \n \n c \n d`: `0r` writes its file before the next file's first line,
		// which gets the newline `nb` lacks. Regressed: `x \n a \n b x \n c \n d`.
		[String.raw`sed -s '0r f' nb nd`, "x\na\nbx\n\nc\nd", 0],
	]);
});

describe("builtin sed: Q writes no text that a or r queued", () => {
	cases([
		// `a \n b`: `Q` quits before the text `a` queued, and before the newline `nb` lacks.
		// Regressed: `a \n b \n f o o \n`.
		[String.raw`sed -e '3a foo' -e 3Q nb nd`, "a\nb", 0],
		// `a \n b`: the same for the file `r` queued. Regressed: `a \n b \n x \n`.
		[String.raw`sed -e '3r f' -e 3Q nb nd`, "a\nb", 0],
	]);
});
