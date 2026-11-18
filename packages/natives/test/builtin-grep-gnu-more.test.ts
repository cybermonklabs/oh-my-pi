import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// what GNU grep 3.11 prints on stdout and exits with for the same command, in
// the C locale and in C.UTF-8 alike, so a script an agent writes means the
// same thing in the tool as in a terminal. stderr is dropped unless a case
// says otherwise.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-more-"));
	await fs.writeFile(path.join(dir, "in"), "-5\n-1\nx\nzz\nb\n");
	await fs.writeFile(path.join(dir, "f1"), "zz\n");
	// Binary input: GNU reports a match in it on stderr rather than writing
	// the bytes, and a NUL byte ends a line, so `grep -c .` counts four.
	await fs.writeFile(path.join(dir, "bin"), new Uint8Array([0x78, 0x00, 0x79, 0x0a, 0x7a, 0x0a, 0x77, 0x0a]));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/** Runs `command` in the builtin shell; `output` holds what the shell streams. */
async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	let output = "";
	const result = await executeShell({ command, cwd: dir }, (_error, chunk) => {
		output += chunk;
	});
	return { output, exitCode: result.exitCode };
}

type Case = [command: string, output: string, exitCode: number];

function cases(list: Case[]) {
	it.each(list)("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
}

describe("builtin grep: repetition operators", () => {
	cases([
		// Regressed: `+?` is read as a lazy `+`, so a line without `a` is not counted.
		[String.raw`printf 'b\n' | grep -cE 'a+?' 2>/dev/null`, "1\n", 0],
		// Regressed: the same in a BRE.
		[String.raw`printf 'b\n' | grep -c 'a\+\?' 2>/dev/null`, "1\n", 0],
		// Regressed: `*?` is read as a lazy `*`, and -o prints nothing.
		[String.raw`printf 'aa\n' | grep -oE 'a*?' 2>/dev/null`, "aa\n", 0],
		// Regressed: a leading `*` in an ERE stops grep with exit 2; GNU warns and matches.
		[String.raw`printf 'x\n' | grep -cE '*x' 2>/dev/null`, "1\n", 0],
		// Regressed: `{,2}` is matched as the literal text, so no line counts.
		[String.raw`printf 'b\n' | grep -cE 'a{,2}' 2>/dev/null`, "1\n", 0],
		// Regressed: the same in a BRE.
		[String.raw`printf 'b\n' | grep -c 'a\{,2\}' 2>/dev/null`, "1\n", 0],
		// Regressed: an unterminated `{1` stops grep with exit 2 instead of being a literal.
		[String.raw`printf 'a{1\n' | grep -cE 'a{1' 2>/dev/null`, "1\n", 0],
		// Regressed: `{,}` is matched as the literal text; GNU reads it as `{0,}`.
		[String.raw`printf 'b\n' | grep -cE 'a{,}' 2>/dev/null`, "1\n", 0],
		// Regressed: the same in a BRE is refused as "Unmatched \{".
		[String.raw`printf 'b\n' | grep -c 'a\{,\}' 2>/dev/null`, "1\n", 0],
		// Regressed: an unmatched `)` in an ERE stops grep with exit 2 instead of being a literal.
		[String.raw`printf 'a)\n' | grep -cE 'a)' 2>/dev/null`, "1\n", 0],
		// Regressed: a leading `\{` in a BRE stops grep with exit 2 instead of being a literal.
		[String.raw`printf '{\n' | grep -c '\{' 2>/dev/null`, "1\n", 0],
	]);
});

describe("builtin grep: back-references and BRE syntax errors", () => {
	cases([
		// Regressed: the back-reference is matched as the typed text, so `aa` does not count.
		[String.raw`printf 'aa\n' | grep -c '\(a\)\1' 2>/dev/null`, "1\n", 0],
		// Regressed: an ERE back-reference stops grep with exit 2.
		[String.raw`printf 'aa\n' | grep -cE '(a)\1' 2>/dev/null`, "1\n", 0],
		// Regressed: an unmatched `\(` is searched as text with exit 1 instead of refused.
		[String.raw`printf 'x\n' | grep -c '\(a' 2>/dev/null`, "", 2],
		// Regressed: an unmatched `\{` is searched as text with exit 1 instead of refused.
		[String.raw`printf 'x\n' | grep -c 'a\{2' 2>/dev/null`, "", 2],
		// Regressed: a back-reference to no group is searched as text with exit 1 instead of refused.
		[String.raw`printf 'x\n' | grep -c '\1' 2>/dev/null`, "", 2],
		// Regressed: a back-reference to a group of another branch is searched instead of refused.
		[String.raw`printf 'bb\n' | grep -c '\(a\)\|\(b\)\1' 2>/dev/null`, "", 2],
		// Regressed: each branch searched alone renumbered its groups, and `-o` printed `bcc`.
		[String.raw`printf 'bcc\n' | grep -o '\(b\)\|\(b\)\(c\)\2' 2>/dev/null`, "b\n", 0],
	]);
});

describe("builtin grep: bracket expressions with colons", () => {
	cases([
		// Regressed: a range between the colons is refused as a class name without its brackets.
		[String.raw`printf 'a:\n' | grep -c '[:a-z:]' 2>/dev/null`, "1\n", 0],
		// Regressed: so is a class between the colons.
		[String.raw`printf 'a:\n' | grep -c '[:[:digit:]:]' 2>/dev/null`, "1\n", 0],
	]);
});

describe("builtin grep: a backslash before an ordinary character", () => {
	cases([
		// Regressed: `\d` matches a digit instead of the letter `d`.
		[String.raw`printf 'd1\n' | grep -o '\d' 2>/dev/null`, "d\n", 0],
		// Regressed: `\x` matches nothing instead of the letter `x`.
		[String.raw`printf 'x\n' | grep -c '\x' 2>/dev/null`, "1\n", 0],
		// Regressed: the start-of-buffer anchor `` \` `` matches nothing.
		[String.raw`printf 'ab\n' | grep -c '\`a' 2>/dev/null`, "1\n", 0],
	]);
});

describe("builtin grep: input and options beside the pattern", () => {
	cases([
		// Regressed: -w with non-ASCII letters counts no line; GNU counts one in the C and C.UTF-8 locales.
		["printf '\u00c0B\\n\u00df\\n' | grep -cw '[[:alpha:]]' 2>/dev/null", "1\n", 0],
		// Regressed: a line holding a NUL byte is printed raw on stdout instead of "binary file matches" on stderr.
		["grep x bin 2>&1", "grep: bin: binary file matches\n", 0],
		// Regressed: a NUL byte does not end a line of a binary file, so the count is 3.
		["grep -c . bin 2>/dev/null", "4\n", 0],
		// Regressed: -s does not silence "Is a directory".
		["grep -s zz . f1 2>&1", "f1:zz\n", 2],
		// Regressed: an abbreviated long option is refused with exit 2.
		["grep --regex=zz in 2>/dev/null", "zz\n", 0],
		// Regressed: `--before-context` was missing from the abbreviations, so `--bef 1` is refused.
		["grep --bef 1 zz in 2>/dev/null", "x\nzz\n", 0],
		// Regressed: the same with `=`.
		["grep --be=1 zz in 2>/dev/null", "x\nzz\n", 0],
		// Regressed: `--col` names `--color` and its alias `--colour`, one option, but is refused as ambiguous.
		["grep --col=never zz in 2>/dev/null", "zz\n", 0],
		// Regressed: a negative -m other than -1 is refused with exit 2.
		["grep -m -2 x in 2>/dev/null", "x\n", 0],
		// Regressed: -v -m -1 prints every other line where GNU selects none.
		["grep -v -m -1 x in 2>/dev/null", "", 1],
		// Regressed: a negative -m is refused as reading the output file, which GNU reads as it reads -m1.
		["printf 'x\\nmid\\n' > g; grep -m -2 x g >>g 2>/dev/null; cat g", "x\nmid\nx\n", 0],
	]);
});
