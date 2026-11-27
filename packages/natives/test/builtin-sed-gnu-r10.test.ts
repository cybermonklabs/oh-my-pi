import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";
import { runInChild } from "./builtin-child";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C.UTF-8. The outputs are Latin-1 strings, one
// character to a byte: `"\xc3\x9f"` is the two bytes of `ß`. stderr is
// dropped, unless a command sends it to stdout itself (`2>&1`).

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part S14): builtin sed: `y` reads its strings by the locale > printf 'a\364\217\276\200\377\n' | LC_ALL=C.UTF-8 sed 'y/a/b/'
// Deleted (part S14): builtin sed: `y` reads its strings by the locale > printf 'a\377\n' | LC_ALL=C.UTF-8 sed $'y/a/\364\217\276\200/'
// Deleted (part S14): builtin sed: `y` reads its strings by the locale > printf 'caf\303\251\377\n' | LC_ALL=C.UTF-8 sed $'y/\303\251/e/' 2>&1

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-r10-"));
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

/** Writes `f1` (`a`) and `f2` (`b`, `c`), runs `sed -i SCRIPT f1 f2`, and prints both files. */
const inPlace = (script: string) => `printf 'a\\n' >f1; printf 'b\\nc\\n' >f2; sed -i '${script}' f1 f2; cat f1 f2`;

describe("builtin sed: -i over several files edits each on its own", () => {
	cases([
		// Regressed: `n` on the last line of `f1` runs the rest of the script on the first line of `f2`, which `d` deletes; GNU keeps `b`.
		[inPlace("n;d"), "a\nb\n", 0],
		// Regressed: `N` joins the last line of `f1` to the first of `f2`, and `f1` is left empty.
		[inPlace("N;s/\\n/+/"), "a\nb+c\n", 0],
		// Regressed: `$` is the last line of `f2` alone, so `f1` keeps its last line unmarked.
		[inPlace("$s/$/!/"), "a!\nb\nc!\n", 0],
		// Regressed: line numbers run on across the files, so `f2` has no line 1.
		[inPlace("1s/^/>/"), ">a\n>b\nc\n", 0],
		// Regressed: the same for line 2, which is `b` in the count across the files.
		[inPlace("2d"), "a\nb\n", 0],
		// Regressed: `$d` keeps the last line of `f1`.
		[inPlace("$d"), "b\n", 0],
	]);
});

describe("builtin sed: \\U, \\L, \\u and \\l map one character to one", () => {
	cases([
		// Regressed: `ß` becomes `SS`; GNU leaves it as it is.
		[String.raw`printf 'stra\303\237e\n' | sed 's/.*/\U&/'`, "STRA\xc3\x9fE\n", 0],
		// Regressed: the ligature `ﬁ` becomes `FI`; GNU leaves it as it is.
		[String.raw`printf '\357\254\201\n' | sed 's/.*/\U&/'`, "\xef\xac\x81\n", 0],
		// Regressed: `İ` becomes `i` and a combining dot; GNU writes `i`.
		[String.raw`printf '\304\260\n' | sed 's/.*/\L&/'`, "i\n", 0],
		// Regressed: the same for `\l`.
		[String.raw`printf '\304\260X\n' | sed 's/.*/\l&/'`, "iX\n", 0],
		// Regressed: `ᾳ` becomes `ΑΙ`; GNU writes the capital with prosgegrammeni, `ᾼ`.
		[String.raw`printf '\341\276\263\n' | sed 's/.*/\U&/'`, "\xe1\xbe\xbc\n", 0],
		// Regressed: the same for `\u`.
		[String.raw`printf '\341\276\263x\n' | sed 's/.*/\u&/'`, "\xe1\xbe\xbcx\n", 0],
	]);
});

describe("builtin sed: s///e strips the record delimiter", () => {
	cases([
		// Regressed: under -z the newline `echo` ends with is stripped; GNU strips a NUL and keeps it.
		[String.raw`printf 'x\0' | sed -z 's/x/echo y/e'`, "y\n\0", 0],
		// Regressed: the NUL the command ends with is kept, and the record gains a second one.
		[String.raw`printf 'x\0' | sed -z 's/x/printf "y\\0"/e'`, "y\0", 0],
		// Regressed: a `\r` before the newline is stripped too, where GNU strips the newline alone.
		[String.raw`printf 'x\n' | sed 's/x/printf "y\\r\\n"/e'`, "y\r\n", 0],
	]);
});

describe("builtin sed: errors as GNU reports them", () => {
	cases([
		// Regressed: a class name without its outer brackets is reported (exit 4) before the backwards range after it; GNU reports "Invalid range end" and exits 1.
		[String.raw`echo x | sed 's/[:alpha:][z-a]/x/'`, "", 1],
		// Regressed: the same before a group that never closes; GNU reports "Unmatched ( or \(" and exits 1.
		[String.raw`echo x | sed 's/[:alpha:]\(/x/'`, "", 1],
		// Regressed: the same in an ERE.
		[String.raw`echo x | sed -E 's/[:alpha:](/x/'`, "", 1],
		// Regressed: the same inside the group.
		[String.raw`echo x | sed 's/\([:alpha:]/x/'`, "", 1],
		// Alone, or in a group that closes, it is the class-syntax error, exit 4.
		[String.raw`echo x | sed 's/[:alpha:]/x/'`, "", 4],
		[String.raw`echo x | sed 's/\([:alpha:]\)/x/'`, "", 4],
		// Regressed: a jump to a label no `:` defines is "undefined label", with a script position.
		[String.raw`echo a | sed -n 'ba' 2>&1`, "sed: can't find label for jump to `a'\n", 4],
	]);
});

/** GNU sed's line for an error at `place`: `sed: PLACE: MESSAGE`. */
const error = (place: string, message: string) => `sed: ${place}: ${message}\n`;
/** The place of a character in the first `-e` expression. */
const char = (n: number) => `-e expression #1, char ${n}`;

describe("builtin sed: errors written as GNU writes them", () => {
	// Regressed, unless a case says otherwise: each message was the builtin's
	// own, after a place of its own, `<script argument 1>:1:C: error:` or
	// `FILE:L:C: error:`. GNU names the `-e` expression and the character at
	// which it stopped reading, or the script file and the line.
	cases([
		["echo a | sed k 2>&1", error(char(1), "unknown command: `k'"), 1],
		["echo a | sed -e p -e k 2>&1", error("-e expression #2, char 1", "unknown command: `k'"), 1],
		["printf 'p\\nk\\n' >s.sed; echo a | sed -f s.sed 2>&1", error("file s.sed line 2", "unknown command: `k'"), 1],
		// A regex error is glibc's message alone, without "invalid regex '...'", placed past the `;` that ends the command.
		["echo a | sed 's/[z-a]/x/;p' 2>&1", error(char(11), "Invalid range end"), 1],
		["echo a | sed -n '/[z-a]/p' 2>&1", error(char(7), "Invalid range end"), 1],
		// The interval was checked before the bracket expression ahead of it ("Invalid content of \{\}").
		[String.raw`echo a | sed 's/[z-a]a\{2,1\}/x/' 2>&1`, error(char(18), "Invalid range end"), 1],
		// The engine's own parse error, several lines long.
		["echo a | sed -E 's/(a/x/' 2>&1", error(char(7), "Unmatched ( or \\("), 1],
		["echo a | sed 's/a' 2>&1", error(char(3), "unterminated `s' command"), 1],
		["echo a | sed '/a' 2>&1", error(char(2), "unterminated address regex"), 1],
		["echo a | sed 'y/a/' 2>&1", error(char(4), "unterminated `y' command"), 1],
		// "internal error": the builtin read past the end of the line.
		["echo a | sed s 2>&1", error(char(1), "unterminated `s' command"), 1],
		["echo a | sed 'p;y' 2>&1", error(char(3), "unterminated `y' command"), 1],
		["echo a | sed 'y/ab/c/' 2>&1", error(char(7), "strings for `y' command are different lengths"), 1],
		["echo a | sed 's/a/b/z' 2>&1", error(char(7), "unknown option to `s'"), 1],
		// Accepted, and the line printed twice.
		["echo a | sed 's/a/b/pp' 2>&1", error(char(8), "multiple `p' options to `s' command"), 1],
		["echo a | sed --posix 's/a/b/e' 2>&1", error(char(7), "unknown option to `s'"), 1],
		["echo a | sed --sandbox 'w x' 2>&1", error(char(1), "e/r/w commands disabled in sandbox mode"), 1],
		["echo a | sed '!!p' 2>&1", error(char(2), "multiple `!'s"), 1],
		["echo a | sed ': ;' 2>&1", error(char(2), '":" lacks a label'), 1],
		["echo a | sed r 2>&1", error(char(1), "missing filename in r/R/w/W commands"), 1],
		["echo a | sed 'p x' 2>&1", error(char(3), "extra characters after command"), 1],
		["echo a | sed '1:a' 2>&1", error(char(2), ": doesn't want any addresses"), 1],
		["echo a | sed 1 2>&1", error(char(1), "missing command"), 1],
		// "internal error" for these two.
		["echo a | sed '1,p' 2>&1", error(char(3), "unexpected `,'"), 1],
		["echo a | sed '1,' 2>&1", error(char(2), "unexpected `,'"), 1],
		["echo a | sed '}' 2>&1", error(char(1), "unexpected `}'"), 1],
		// A block left open was reported with no place at all.
		["echo a | sed -e '{' -e p 2>&1", error(char(0), "unmatched `{'"), 1],
		["printf '{\\np\\n{\\np\\n' >b.sed; echo a | sed -f b.sed 2>&1", error("file b.sed line 3", "unmatched `{'"), 1],
		// Reported as a jump to a missing label, exit 4: GNU checks the blocks first.
		["echo a | sed '{ba' 2>&1", error(char(0), "unmatched `{'"), 1],
		["echo a | sed a 2>&1", error(char(1), "expected \\ after `a', `c' or `i'"), 1],
		["echo a | sed 0p 2>&1", error(char(2), "invalid usage of line address 0"), 1],
		["echo a | sed '0,5 p' 2>&1", error(char(5), "invalid usage of line address 0"), 1],
		["echo a | sed --posix '0,/a/p' 2>&1", error(char(6), "invalid usage of line address 0"), 1],
		// Under --posix, `~` is no step but a command, and after a `,` no address.
		["echo a | sed --posix '1~2p' 2>&1", error(char(2), "unknown command: `~'"), 1],
		["echo a | sed --posix '1,~2p' 2>&1", error(char(3), "unexpected `,'"), 1],
		[String.raw`echo a | sed 's/\(a\)/\2/' 2>&1`, error(char(11), "invalid reference \\2 on `s' command's RHS"), 1],
		["echo a | sed 's//x/I' 2>&1", error(char(6), "cannot specify modifiers on empty regexp"), 1],
		// Found only as the script runs, these exited 2; GNU places them at the end of the script and exits 1.
		[
			String.raw`printf 'ab\n' | sed '/a/s//[\1]/' 2>&1`,
			error(char(0), "invalid reference \\1 on `s' command's RHS"),
			1,
		],
		["echo a | sed -e '$!d' -e 's//x/' 2>&1", error("-e expression #2, char 0", "no previous regular expression"), 1],
		[
			"printf 's//x/\\n' >e.sed; echo a | sed -f e.sed 2>&1",
			error("file e.sed line 2", "no previous regular expression"),
			1,
		],
	]);
});

describe("builtin sed: a step with no digits, and a `~` after other addresses", () => {
	cases([
		// Regressed: each of these was "sed: internal error", exit 1. GNU reads no digits after `~` as a step of 0: `first~0` is the line `first`, and `addr,~0` ends the range on its first line.
		["seq 5 | sed -n '1~p' 2>&1", "1\n", 0],
		["seq 5 | sed -n '1 ~p' 2>&1", "1\n", 0],
		["seq 5 | sed -n '1~!p' 2>&1", "2\n3\n4\n5\n", 0],
		["seq 5 | sed -n '1,~p' 2>&1", "1\n", 0],
		["seq 5 | sed -n '/2/,~p' 2>&1", "2\n", 0],
		["seq 5 | sed -n '\\%2%,~p' 2>&1", "2\n", 0],
		["seq 5 | sed -n '$,~p' 2>&1", "5\n", 0],
		["seq 5 | sed -n '/1/,~!p' 2>&1", "2\n3\n4\n5\n", 0],
		["echo a | sed '/a/,~p' 2>&1", "a\na\n", 0],
		// `0~` is line 0, which a regex may end.
		["seq 5 | sed -n '0~,/2/p' 2>&1", "1\n2\n", 0],
		["seq 5 | sed -n '0~p' 2>&1", error(char(3), "invalid usage of line address 0"), 1],
		["seq 5 | sed -n '0~,p' 2>&1", error(char(4), "unexpected `,'"), 1],
		// After an address other than a line number, the `~` is a command.
		["seq 5 | sed -n '$~p' 2>&1", error(char(2), "unknown command: `~'"), 1],
		["seq 5 | sed -n '/1/~p' 2>&1", error(char(4), "unknown command: `~'"), 1],
		["seq 5 | sed -n '/1/I~p' 2>&1", error(char(5), "unknown command: `~'"), 1],
		// What follows the step is the command.
		["seq 5 | sed -n '1~xp' 2>&1", error(char(4), "extra characters after command"), 1],
		["seq 5 | sed -n '1,~xp' 2>&1", error(char(5), "extra characters after command"), 1],
		["seq 5 | sed -n '1~;p' 2>&1", error(char(3), "unknown command: `;'"), 1],
		["seq 5 | sed -n '1,~}p' 2>&1", error(char(4), "unexpected `}'"), 1],
		// Regressed by the same rule: a step of 0 ran the range to the last line.
		["seq 5 | sed -n '2,~0p' 2>&1", "2\n", 0],
		["seq 5 | sed -n '/3/,~0p' 2>&1", "3\n", 0],
		// Regressed by the same rule: a `~` after `$` or a regex was read as a step.
		["seq 5 | sed -n '$~2p' 2>&1", error(char(2), "unknown command: `~'"), 1],
		["seq 5 | sed -n '/1/~2p' 2>&1", error(char(4), "unknown command: `~'"), 1],
	]);
});

describe("builtin sed: how many addresses a command takes", () => {
	cases([
		// Regressed: accepted, so the script ran where GNU refuses it.
		["seq 3 | sed -n '1,2q' 2>&1", error(char(4), "command only uses one address"), 1],
		["echo a | sed '/a/~2p' 2>&1", error(char(4), "unknown command: `~'"), 1],
		["seq 3 | sed --posix -n '1,2l' 2>&1", error(char(4), "command only uses one address"), 1],
		// Regressed: `first~step` counted as two addresses, so `Q` refused it.
		["seq 3 | sed -n '1~2Q 5'", "", 5],
		// `q` takes it too.
		["seq 3 | sed -n '1~2q 5'", "", 5],
		// Regressed: `c` treated `first~step` as a range, replacing its last line alone.
		["seq 3 | sed -n '1~2c foo'", "foo\nfoo\n", 0],
		["seq 3 | sed '1~2!c foo'", "1\nfoo\n3\n", 0],
		// Regressed: "} doesn't want any addresses" for both; GNU first refuses a `}` that closes no block.
		["echo a | sed '1}' 2>&1", error(char(2), "unexpected `}'"), 1],
		["echo a | sed -n '{p;1}' 2>&1", error(char(5), "`}' doesn't want any addresses"), 1],
		// Regressed: after `!` the `}` no longer closed its block, so the script was "unmatched `{'".
		["echo a | sed -n '{p;!}' 2>&1", "a\n", 0],
		// A `!}` that closes no block is refused as a bare `}` is.
		["echo a | sed -n '!}' 2>&1", error(char(2), "unexpected `}'"), 1],
	]);
});

describe("builtin sed: a reused regex's group references", () => {
	cases([
		// Regressed: GNU checks the references of an address's regex when an `s` command first reuses it, before it searches the line; the builtin checked only on a match.
		[
			String.raw`printf 'b\n' | sed '/a/!s//[\1]/' 2>&1`,
			error(char(0), "invalid reference \\1 on `s' command's RHS"),
			1,
		],
		[
			String.raw`printf 'b\na\n' | sed '/a/!s//[\1]/' 2>&1`,
			error(char(0), "invalid reference \\1 on `s' command's RHS"),
			1,
		],
		[
			String.raw`printf 'b\n' | sed -n '/a/p;s//[\1]/' 2>&1`,
			error(char(0), "invalid reference \\1 on `s' command's RHS"),
			1,
		],
		// Regressed: anywhere else a reference to a group the regex lacks is empty, where the builtin refused it.
		[String.raw`printf 'aab\n' | sed 's/\(a\)/x/;s//[\2]/' 2>&1`, "x[]b\n", 0],
		[String.raw`printf 'ab\n' | sed '/\(a\)/s//[\1]/;s//<\2>/' 2>&1`, "[<>]b\n", 0],
		[String.raw`printf 'ab\nab\n' | sed '/a/s//[&]/;s//[\1]/' 2>&1`, "[[]]b\n[[]]b\n", 0],
		// Regressed: --posix checks no reference.
		[String.raw`printf 'ab\n' | sed --posix '/a/s//[\1]/' 2>&1`, "[]b\n", 0],
		[String.raw`printf 'ab\n' | sed --posix 's/a/[\1]/' 2>&1`, "[]b\n", 0],
		// Each `/a/` is a regex of its own, checked by the `s` command that first reuses it.
		[
			String.raw`printf 'ab\n' | sed '/a/s//[&]/;/a/s//[\1]/' 2>&1`,
			error(char(0), "invalid reference \\1 on `s' command's RHS"),
			1,
		],
	]);
});

describe("builtin sed: what it refuses where GNU accepts", () => {
	// The builtin lacks these; it refuses each with a nonzero exit and a
	// message that names what it does not take. These are its own messages,
	// not GNU's.
	const command = "seq 3 | sed -n '1,+p' 2>&1";
	it(command, async () => {
		// Regressed: "number expected", which names no `+`. GNU reads `1,+` as `1,+0`.
		const { child, exitCode, output } = await runInChild(dir, command, { stderr: true });
		expect({ child, exitCode }).toEqual({ child: 0, exitCode: 1 });
		expect(output.toString()).toMatch(/^sed: .*\+/);
	});
});

describe("builtin sed: a brace with nothing to repeat, and a count above 32767", () => {
	cases([
		// Regressed: with `{` the delimiter, `\{` reaches the pattern as a brace that sed's own interval check never sees, and it is read as text; GNU prints "Invalid preceding regular expression" and exits 1.
		[String.raw`echo a | sed -E 's{\{x{Y{'`, "", 1],
		// Regressed: the same for a brace that would open an interval.
		[String.raw`echo a | sed -E 's{\{1,2,3}{Y{'`, "", 1],
		// Regressed: the same after an anchor.
		[String.raw`echo a | sed -E 's{^\{x{Y{'`, "", 1],
		// Regressed: the same in an address.
		[String.raw`echo a | sed -E -n '\{\{x{p'`, "", 1],
		// Regressed: past the same check, a maximum above 32767 is searched; GNU prints "Regular expression too big".
		[String.raw`echo a | sed -E 's{a\{1,32768}{Y{'`, "", 1],
		// sed's own check refuses one with any delimiter.
		[String.raw`echo a | sed 's/a\{32768\}/Y/'`, "", 1],
	]);
});

describe("builtin sed: the pattern dialect shared with grep", () => {
	cases([
		// Regressed: `^` after `\<` anchors, so `a` is replaced; GNU reads the caret as text and changes nothing.
		[String.raw`printf 'a\n' | sed 's/\<^a/X/'`, "a\n", 0],
		// Regressed: after `` \` `` the caret is text, found in the line `^a`.
		[String.raw`printf 'a\n^a\n' | sed 's/\`^a/X/'`, "a\nX\n", 0],
		// Regressed: under `I` the range `[a-Z]` is refused; GNU's runs from `A` to `Z`.
		[String.raw`printf 'b\n' | sed 's/[a-Z]/x/I'`, "x\n", 0],
		// Regressed: under `I` the range `[A-z]` holds `_`; GNU's does not.
		[String.raw`printf '_\n' | sed 's/[A-z]/x/I'`, "_\n", 0],
		// Regressed: under `I` `[[:lower:]]` is `[[:alpha:]]` to GNU, which `中` is.
		[String.raw`printf '\344\270\255\n' | sed 's/[[:lower:]]/X/I'`, "X\n", 0],
	]);
});

describe("builtin sed: a pattern of groups nested past the engine's limit", () => {
	// GNU sed 4.9 itself crashes on this pattern (exit 139), so the
	// expectation is the builtin's own refusal: an invalid regex, a message
	// that names `sed`, and exit 1.
	it("is refused with exit 1, and the process lives on", async () => {
		// Regressed: splitting the pattern into its branches recurses once a group, so 100,000 nested groups with a `|` overflow the stack, which aborts the whole process, the bash tool's host with it.
		const depth = 100_000;
		await fs.writeFile(path.join(dir, "deep.sed"), `s/${"(".repeat(depth)}a|b${")".repeat(depth)}/X/\n`);
		const { child, exitCode, stderr } = await runInChild(dir, "echo a | sed -E -f deep.sed", { stderr: true });
		expect({ child, exitCode }).toEqual({ child: 0, exitCode: 1 });
		expect(stderr.toString()).toMatch(/^sed: /);
	}, 60_000);
});

describe("builtin sed: blocks nested 100,000 deep", () => {
	// GNU sed 4.9 runs such a script, and refuses one left unclosed with
	// "unmatched `{'" and exit 1.
	it("are run, and the process lives on", async () => {
		// Regressed: compiling the blocks recursed once a block, so the stack overflowed, which aborts the whole process.
		await fs.writeFile(path.join(dir, "blocks.sed"), `${"{".repeat(100_000)}p${"}".repeat(100_000)}\n`);
		expect(await runInChild(dir, "echo a | sed -n -f blocks.sed")).toEqual({
			child: 0,
			exitCode: 0,
			output: Buffer.from("a\n"),
		});
	}, 60_000);

	it("left unclosed are refused with exit 1, and the process lives on", async () => {
		// Regressed: the same before the unmatched `{` is reported.
		await fs.writeFile(path.join(dir, "open.sed"), `${"{".repeat(100_000)}p\n`);
		expect(await runInChild(dir, "echo a | sed -n -f open.sed")).toEqual({
			child: 0,
			exitCode: 1,
			output: Buffer.alloc(0),
		});
	}, 60_000);
});

describe("builtin sed: where a range ends, and `c` on a range", () => {
	cases([
		// Regressed: a line-number end reached while the range was active wrote no text.
		[String.raw`seq 5 | sed '3,4c\X'`, "1\n2\nX\n5\n", 0],
		// Regressed: once one range had ended at its first line, every later line of a `c` range wrote the text.
		[String.raw`seq 5 | sed '1,+0d;3,4c\X'`, "2\nX\n5\n", 0],
		// Regressed: the text was written where the input ended inside the range.
		[String.raw`seq 5 | sed '3,10c\X'`, "1\n2\n", 0],
		// Regressed: `addr,+N` ended a line late, so `c` wrote no text.
		[String.raw`seq 5 | sed '2,+1c\X'`, "1\nX\n4\n5\n", 0],
		// Regressed: `!` on a range wrote the text on the last line alone.
		[String.raw`seq 5 | sed '2,3!c\X'`, "X\n2\n3\nX\nX\n", 0],
		// Regressed: a range whose end line the command did not see ended a line late, writing no text.
		[String.raw`seq 5 | sed '3d;2,4c\X'`, "1\nX\n5\n", 0],
		// Regressed: `addr,+N` past a line the command did not see left out the line that ends it.
		["seq 10 | sed -n '3d;2,+1p'", "2\n4\n", 0],
		// Regressed: `addr,~N` past a multiple the command did not see ran on to the next one.
		["seq 10 | sed -n '4d;2,~4p'", "2\n3\n5\n", 0],
	]);
});

describe("builtin sed: `first~step` is an address GNU tests on each line", () => {
	cases([
		// Regressed: held as a range that started at `first`, so with line 1 deleted nothing was printed.
		["seq 5 | sed -n '1d;1~2p'", "3\n5\n", 0],
		[String.raw`seq 10 | sed '1d;1~2c\X'`, "2\nX\n4\nX\n6\nX\n8\nX\n10\n", 0],
		// Regressed: "unknown command: `,'": the step left no room for a second address.
		["seq 10 | sed -n '2~3,+1p'", "2\n3\n5\n6\n8\n9\n", 0],
		["seq 10 | sed -n '0~4,5p'", "4\n5\n8\n", 0],
	]);
});

describe("builtin sed: a range whose first address is a line number", () => {
	cases([
		// Regressed: it started on that line alone, which `N` read, so it never started; GNU starts it on the first
		// line at or past it.
		["seq 10 | sed -n '$!N;3,5p'", "3\n4\n", 0],
		["seq 10 | sed -n '$!N;3,4p'", "3\n4\n", 0],
		["seq 10 | sed -n '$!N;3,+1p'", "3\n4\n5\n6\n", 0],
		["seq 10 | sed -n '$!N;3,~4p'", "3\n4\n5\n6\n7\n8\n", 0],
		[String.raw`seq 10 | sed '$!N;3,5c\X'`, "1\n2\n5\n6\n7\n8\n9\n10\n", 0],
		["seq 10 | sed -n '2d;2,3p'", "3\n", 0],
	]);
});

describe("builtin sed: errors about files and comments as GNU writes them", () => {
	cases([
		// Regressed: `<script argument 1>:1:1: error: creating file '/nonexistent/x': … (os error 2)`, exit 2.
		[
			"echo a | sed 'w /nonexistent/x' 2>&1",
			"sed: couldn't open file /nonexistent/x: No such file or directory\n",
			4,
		],
		[
			"echo a | sed 's/a/b/w /nonexistent/y' 2>&1",
			"sed: couldn't open file /nonexistent/y: No such file or directory\n",
			4,
		],
		// Regressed: "error opening script file '/nonexistent/s': … (os error 2)", exit 2.
		["echo a | sed -f /nonexistent/s 2>&1", "sed: couldn't open file /nonexistent/s: No such file or directory\n", 4],
		// Regressed: "unknown command: `#'".
		["echo a | sed '1#foo' 2>&1", error(char(2), "comments don't accept any addresses"), 1],
		["echo a | sed '1,2#foo' 2>&1", error(char(4), "comments don't accept any addresses"), 1],
		["echo a | sed '1!#foo' 2>&1", error(char(3), "comments don't accept any addresses"), 1],
		// Regressed: the same; after `!` alone it is a comment.
		["echo a | sed '!#foo' 2>&1", "a\n", 0],
		// Regressed: the script file's name was written with U+FFFD for the byte 0xFF.
		[
			String.raw`printf 'k\n' >$'n\377'; echo a | sed -f $'n\377' 2>&1`,
			"sed: file n\xff line 1: unknown command: `k'\n",
			1,
		],
	]);
});

describe("builtin sed: a `w` file that cannot be written", () => {
	// GNU sed names the bytes of the write that failed: its stdio buffers
	// the file in blocks of 4096 bytes (`/dev/full`'s `st_blksize`), and the
	// line's text or delimiter that does not fit is the write that fails.
	const full = (message: string) => `sed: couldn't write ${message} to /dev/full: No space left on device\n`;
	cases([
		// Regressed: "couldn't write 1 item", or "couldn't flush /dev/full" at the end, for each.
		["seq 100000 | sed -n 'w /dev/full' 2>&1", full("4 items"), 4],
		["yes abcdefg | head -n 1000 | sed -n 'w /dev/full' 2>&1", full("7 items"), 4],
		[`yes ${"a".repeat(104)} | head -n 1000 | sed -n 'w /dev/full' 2>&1`, full("104 items"), 4],
		["yes abc | head -n 1025 | sed -n 'w /dev/full' 2>&1", full("3 items"), 4],
		["head -c 5000 /dev/zero | tr '\\0' a | sed -n 'w /dev/full' 2>&1", full("5000 items"), 4],
		// Regressed: "couldn't write 4 items", each command buffering the file apart.
		["seq 100000 | sed -n -e 'w /dev/full' -e 'w /dev/full' 2>&1", full("3 items"), 4],
		// Regressed: "couldn't write 1 item to /dev/stdout", sed's output flushed at each line.
		[
			"seq 100000 | sed -n 'w /dev/stdout' 2>&1 >/dev/full",
			"sed: couldn't write 4 items to stdout: No space left on device\n",
			4,
		],
		// Only the names `/dev/stdout` and `/dev/stderr` are GNU's own streams, named so; any
		// other is named as written. Regressed: each named `stdout`.
		[
			"seq 100000 | sed -n 'w /dev/fd/1' 2>&1 >/dev/full",
			"sed: couldn't write 4 items to /dev/fd/1: No space left on device\n",
			4,
		],
		[
			"seq 100000 | sed -n 'w //dev/stdout' 2>&1 >/dev/full",
			"sed: couldn't write 4 items to //dev/stdout: No space left on device\n",
			4,
		],
		[
			"seq 100000 | sed -n 'w /proc/self/fd/1' 2>&1 >/dev/full",
			"sed: couldn't write 4 items to /proc/self/fd/1: No space left on device\n",
			4,
		],
		// A write that fails only where sed flushes its output at the end. Regressed: "No space
		// left on device (os error 28)", exit 2.
		[
			"printf 'a\\n' | sed -n 'w /dev/stdout' 2>&1 >/dev/full",
			"sed: couldn't flush stdout: No space left on device\n",
			4,
		],
		["printf 'a\\n' | sed p 2>&1 >/dev/full", "sed: couldn't flush stdout: No space left on device\n", 4],
	]);
});

describe("builtin sed: one `w` file for each name", () => {
	cases([
		// Regressed: the second `w` opened the file again, and each line was written once.
		["seq 3 | sed -n -e 'w o' -e 'w o'; cat o", "1\n1\n2\n2\n3\n3\n", 0],
		// A name is as written: two names of one file are two streams, each writing it from its
		// start. Regressed: one stream, which wrote each line twice.
		["mkdir d; seq 3 | sed -n -e 'w d/o' -e 'w d//o'; cat d/o", "1\n2\n3\n", 0],
		["mkdir d; seq 3 | sed -n -e 'w d/o' -e 'w d/./o'; cat d/o", "1\n2\n3\n", 0],
	]);
});

describe("builtin sed: `y` reads its strings by the locale", () => {
	// GNU sed 4.9 reads the strings, and the line, a character at a time in
	// C.UTF-8, a line that is not UTF-8 too where it can be, and a byte at a
	// time in the C locale.
	cases([
		// Regressed: refused as strings of different lengths.
		[String.raw`printf 'caf\303\251\n' | LC_ALL=C sed 'y/\xc3\xa9/eE/' 2>&1`, "cafeE\n", 0],
		// Regressed: `é` was one character, where the C locale reads two bytes.
		[
			String.raw`printf 'caf\303\251\n' | LC_ALL=C sed $'y/\303\251/e/' 2>&1`,
			error(char(7), "strings for `y' command are different lengths"),
			1,
		],
		// Regressed: the line was read a byte at a time, which `é` is no member of.
		[String.raw`printf 'caf\303\251\377\n' | LC_ALL=C.UTF-8 sed 'y/\xc3\xa9/e/' 2>&1`, "cafe\xff\n", 0],
		// A source given twice keeps its first target in C.UTF-8, and its last in the C locale.
		// Regressed: the last in both.
		["echo a | LC_ALL=C.UTF-8 sed 'y/aa/12/'", "1\n", 0],
		["echo ab | LC_ALL=C.UTF-8 sed 'y/aba/123/'", "12\n", 0],
		[String.raw`printf 'caf\303\251\n' | LC_ALL=C.UTF-8 sed $'y/\303\251\303\251/12/'`, "caf1\n", 0],
		["echo a | LC_ALL=C sed 'y/aa/12/'", "2\n", 0],
		// A character from U+10FF80 written in the script is that character. Regressed: it was
		// the byte 0x80, and in the C locale its four bytes were one, with no error.
		[String.raw`printf 'ab\n' | LC_ALL=C.UTF-8 sed $'y/ab/\364\217\276\200c/'`, "\xf4\x8f\xbe\x80c\n", 0],
		[
			String.raw`printf 'ab\n' | LC_ALL=C sed $'y/ab/\364\217\276\200c/' 2>&1`,
			error(char(11), "strings for `y' command are different lengths"),
			1,
		],
		// So it is beside a target that is a byte. Regressed: U+10FF80 was written as the byte
		// 0x80, and a source byte mapped to it was kept.
		[String.raw`printf 'ab\n' | LC_ALL=C.UTF-8 sed $'y/ab/\\xe9\364\217\276\200/'`, "\xe9\xf4\x8f\xbe\x80\n", 0],
		[String.raw`printf 'ab\n' | LC_ALL=C.UTF-8 sed $'y/ab/\364\217\276\200\\xff/'`, "\xf4\x8f\xbe\x80\xff\n", 0],
		[String.raw`printf 'x\200\n' | LC_ALL=C.UTF-8 sed $'y/\\x80/\364\217\276\200/'`, "x\xf4\x8f\xbe\x80\n", 0],
		// Already GNU's answer, kept.
		[String.raw`printf 'a\377\n' | LC_ALL=C.UTF-8 sed $'y/a\\xff/\\xffa/'`, "\xffa\n", 0],
	]);
});

describe("builtin sed: a `y` error comes before a later `w` file is opened", () => {
	// GNU sed 4.9 reports a `y` command whose strings differ in length in the
	// locale before it compiles the commands after it, so the file of a later
	// `w` (or `s///w`) is neither created nor emptied.
	const different = (n: number) => error(char(n), "strings for `y' command are different lengths");
	cases([
		// Regressed: `o` was emptied, or created.
		[
			String.raw`echo keep >o; printf 'x\n' | LC_ALL=C sed -e $'y/\303\251/e/' -e 'w o' 2>&1; echo $?; cat o`,
			`${different(7)}1\nkeep\n`,
			0,
		],
		[
			String.raw`rm -f o; printf 'x\n' | LC_ALL=C sed -e $'y/\303\251/e/' -e 'w o' 2>&1; test -e o; echo $?`,
			`${different(7)}1\n`,
			0,
		],
		[
			String.raw`echo keep >o; printf 'x\n' | LC_ALL=C.UTF-8 sed -e 'y/\xc3\xa9/ab/' -e 'w o' 2>&1; echo $?; cat o`,
			`${different(14)}1\nkeep\n`,
			0,
		],
		[
			String.raw`echo keep >o; printf 'x\n' | LC_ALL=C.UTF-8 sed -e $'y/ab/\303\251/' -e 'w o' 2>&1; cat o`,
			`${different(8)}keep\n`,
			0,
		],
		[
			String.raw`echo keep >o; printf 'x\n' | LC_ALL=C sed -e $'y/a/\303\251/' -e 'w o' 2>&1; cat o`,
			`${different(7)}keep\n`,
			0,
		],
		[String.raw`echo keep >o; echo a | LC_ALL=C sed $'y/\303\251/e/;w o' 2>&1; cat o`, `${different(7)}keep\n`, 0],
		[
			String.raw`echo keep >o; echo a | LC_ALL=C sed -e $'y/\303\251/e/' -e 's/a/b/w o' 2>&1; cat o`,
			`${different(7)}keep\n`,
			0,
		],
		[
			String.raw`echo keep >o; echo a >in; LC_ALL=C sed -i -e $'y/\303\251/e/' -e 'w o' in 2>&1; cat o in`,
			`${different(7)}keep\na\n`,
			0,
		],
		// Already GNU's answer, kept: the strings are of one length in C.UTF-8.
		[
			String.raw`echo keep >o; printf 'x\n' | LC_ALL=C.UTF-8 sed -e $'y/\303\251/e/' -e 'w o' 2>&1; echo $?; cat o`,
			"x\n0\nx\n",
			0,
		],
	]);
});

describe("builtin sed: the escapes of `y`", () => {
	// GNU sed 4.9 reads `\a`, `\f`, `\n`, `\r`, `\t`, `\v`, `\cX`, `\dNNN`,
	// `\oNNN` and `\xHH` in a string of `y`, and any other `\X` as the `X`;
	// the bytes the escapes write are then read as characters in C.UTF-8,
	// and each as one in the C locale.
	const lengths = (n: number) => error(char(n), "strings for `y' command are different lengths");
	cases([
		// Regressed: `\u0061` was read as `a`, which GNU reads as `u0061`.
		["echo abc | sed 'y/\\u0061/x/' 2>&1", lengths(11), 1],
		["echo abc | sed 'y/a/\\u0078/' 2>&1", lengths(11), 1],
		// Regressed: an escape GNU does not define kept its backslash, two characters.
		["echo aqc | sed 'y/\\q/x/' 2>&1", "axc\n", 0],
		["echo 'a&c' | sed 'y/\\&/x/' 2>&1", "axc\n", 0],
		// Regressed: `\b` was a backspace.
		["echo abc | sed 'y/a\\bc/xyz/' 2>&1", "xyz\n", 0],
		// Regressed: "unterminated `y' command" for `\c\\`, `\c/` and `\c` before the delimiter.
		[String.raw`printf 'a\034c\n' | sed 'y/\c\\/x/' 2>&1`, "axc\n", 0],
		["echo abo | sed 'y/\\c\\//x/' 2>&1", "abx\n", 0],
		["echo abc | sed 'y/\\c//' 2>&1", "abc\n", 0],
		// Regressed: refused as strings of different lengths.
		["echo abc | sed 'y/a/\\c\\q/' 2>&1", error(char(9), "recursive escaping after \\c not allowed"), 1],
		// Regressed: `\d300` was the character U+012C; GNU writes the byte 300 mod 256, a comma.
		["printf 'a,c\\n' | sed 'y/\\d300/x/' 2>&1", "axc\n", 0],
		["echo abc | sed 'y/a/\\d300/' 2>&1", ",bc\n", 0],
		// Regressed: the two bytes of `é` were two characters, refused as strings of different lengths.
		[String.raw`printf 'caf\303\251\n' | LC_ALL=C.UTF-8 sed 'y/\xc3\xa9/e/' 2>&1`, "cafe\n", 0],
		[String.raw`printf 'cafe\n' | LC_ALL=C.UTF-8 sed 'y/e/\xc3\xa9/' 2>&1`, "caf\xc3\xa9\n", 0],
		// Regressed: the byte 0xE9 was the character `é`, which it is not in a line that is UTF-8.
		[String.raw`printf 'caf\303\251\n' | LC_ALL=C.UTF-8 sed 'y/\xe9/e/' 2>&1`, "caf\xc3\xa9\n", 0],
		[String.raw`printf 'cafe\n' | LC_ALL=C.UTF-8 sed 'y/e/\xe9/' 2>&1`, "caf\xe9\n", 0],
		// Regressed: "unterminated `y' command"; an escaped newline is a newline.
		[String.raw`printf 'a\nb\n' | sed $'N;y/\\\n/x/' 2>&1`, "axb\n", 0],
	]);
});
