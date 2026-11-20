import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C.UTF-8. The outputs are Latin-1 strings, one
// character to a byte: `"\xc3\x9f"` is the two bytes of `ß`. stderr is
// dropped, unless a command sends it to stdout itself (`2>&1`).

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

/**
 * Runs `command` in the builtin shell of a child process, which a crash of
 * the builtin ends alone, with stdout sent to `out`. Returns the child's own
 * exit status (0 when it lived to report), the builtin's, and the output.
 */
async function runInChild(command: string): Promise<{ child: number; exitCode: number; output: Buffer }> {
	const addon = path.join(import.meta.dir, "../native/index.js");
	const script = path.join(dir, "child.mjs");
	await fs.writeFile(
		script,
		[
			`import { executeShell } from ${JSON.stringify(addon)};`,
			`const command = ${JSON.stringify(`{ ${command}\n} >out 2>/dev/null`)};`,
			`const result = await executeShell({ command, cwd: ${JSON.stringify(dir)} }, () => {});`,
			"console.log(result.exitCode);",
		].join("\n"),
	);
	await fs.rm(path.join(dir, "out"), { force: true });
	const shell = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" });
	const [stdout, child] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
	const output = await fs.readFile(path.join(dir, "out")).catch(() => Buffer.alloc(0));
	return { child, exitCode: Number(stdout), output };
}

describe("builtin sed: a pattern of groups nested past the engine's limit", () => {
	// GNU sed 4.9 itself crashes on this pattern (exit 139), so the
	// expectation is the builtin's own refusal: an invalid regex, exit 1, and
	// no output.
	it("is refused with exit 1, and the process lives on", async () => {
		// Regressed: splitting the pattern into its branches recurses once a group, so 100,000 nested groups with a `|` overflow the stack, which aborts the whole process, the bash tool's host with it.
		const depth = 100_000;
		await fs.writeFile(path.join(dir, "deep.sed"), `s/${"(".repeat(depth)}a|b${")".repeat(depth)}/X/\n`);
		expect(await runInChild("echo a | sed -E -f deep.sed")).toEqual({
			child: 0,
			exitCode: 1,
			output: Buffer.alloc(0),
		});
	}, 60_000);
});

describe("builtin sed: blocks nested 100,000 deep", () => {
	// GNU sed 4.9 runs such a script, and refuses one left unclosed with
	// "unmatched `{'" and exit 1.
	it("are run, and the process lives on", async () => {
		// Regressed: compiling the blocks recursed once a block, so the stack overflowed, which aborts the whole process.
		await fs.writeFile(path.join(dir, "blocks.sed"), `${"{".repeat(100_000)}p${"}".repeat(100_000)}\n`);
		expect(await runInChild("echo a | sed -n -f blocks.sed")).toEqual({
			child: 0,
			exitCode: 0,
			output: Buffer.from("a\n"),
		});
	}, 60_000);

	it("left unclosed are refused with exit 1, and the process lives on", async () => {
		// Regressed: the same before the unmatched `{` is reported.
		await fs.writeFile(path.join(dir, "open.sed"), `${"{".repeat(100_000)}p\n`);
		expect(await runInChild("echo a | sed -n -f open.sed")).toEqual({
			child: 0,
			exitCode: 1,
			output: Buffer.alloc(0),
		});
	}, 60_000);
});
