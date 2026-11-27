import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` and `grep` as builtins. Each expectation
// below is the bytes GNU sed 4.9 or GNU grep 3.11 writes on stdout, and the
// status it exits with, for the same command under the locale the command
// sets itself (`LC_ALL=C` or `LC_ALL=C.UTF-8`). The outputs are Latin-1
// strings, one character to a byte: `"\xc3\x9f"` is the two bytes of `ß`.
// stderr is dropped.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-gnu-r10-regressions-"));
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

describe("builtin sed: `c` on a range that ends at `$` and starts on the last line", () => {
	cases([
		// Regressed: the range is deleted and its text never printed, so the output loses the last line and gains nothing; GNU prints the text in its place.
		["printf 'p\\nq\\n' | LC_ALL=C.UTF-8 sed '2,$c\\\nCH'", "p\nCH\n", 0],
		// Regressed: the same on a last line without a newline.
		["printf 'p\\nq' | LC_ALL=C.UTF-8 sed '2,$c\\\nCH'", "p\nCH\n", 0],
		// Regressed: under -i the file is rewritten without its last line and without the text.
		["printf 'p\\nq\\n' >g; LC_ALL=C.UTF-8 sed -i '2,$c\\\nCH' g; cat g", "p\nCH\n", 0],
		// Regressed: the same for a range whose first address is a regex.
		["printf 'p\\nq\\n' | LC_ALL=C.UTF-8 sed '/q/,$c\\\nCH'", "p\nCH\n", 0],
		// Regressed: a one-line input changed whole prints nothing.
		["printf 'p\\n' | LC_ALL=C.UTF-8 sed '1,$c\\\nCH'", "CH\n", 0],
		// Regressed: under -s each file whose range starts on its last line loses the text.
		["printf 'p\\nq' >f; printf 'p\\nq\\n' >g; LC_ALL=C.UTF-8 sed -s '2,$c\\\nCH' f g", "p\nCH\np\nCH\n", 0],
		// A range that starts before the last line prints the text once at its end.
		["printf 'p\\nq\\nr\\n' | LC_ALL=C.UTF-8 sed '2,$c\\\nCH'", "p\nCH\n", 0],
	]);
});

describe("builtin grep: -E with a repetition operator alone in a group", () => {
	cases([
		// Regressed: the pattern is accepted and every line counted (exit 0); GNU skips the operator, finds the group empty and refuses it with "Unmatched ( or \(" (exit 2).
		["printf 'a\\nb\\n' | LC_ALL=C.UTF-8 grep -cE '(*)'", "", 2],
		// Regressed: the same for `+` after `|` inside a group.
		["printf 'a\\nb\\n' | LC_ALL=C.UTF-8 grep -cE '(a|+)'", "", 2],
		// Regressed: the same for `?` in a group after text, which then counts no line (exit 1).
		["printf 'a\\nb\\n' | LC_ALL=C.UTF-8 grep -cE 'x(?)'", "", 2],
		// Regressed: the same for a group that a back-reference repeats.
		["printf 'a\\nb\\n' | LC_ALL=C.UTF-8 grep -cE '(*)\\1'", "", 2],
		// An operator followed by an atom in the group is skipped and the atom matched.
		["printf 'a\\nb\\n' | LC_ALL=C.UTF-8 grep -cE '(*a)'", "1\n", 0],
	]);
});

describe("builtin grep: a back-reference among the patterns leaves the word class as it is", () => {
	cases([
		// Regressed: adding a pattern with a back-reference makes `\w` match the superscript `²`, so a line with no word character is counted; GNU counts none.
		["printf '\\302\\262\\n' | LC_ALL=C.UTF-8 grep -c -e '\\w' -e 'q\\(z\\)\\1'", "0\n", 1],
		// Regressed: the same for `\<` before the vulgar fraction `½`.
		["printf '\\302\\275\\n' | LC_ALL=C.UTF-8 grep -c -e '\\<.' -e 'q\\(z\\)\\1'", "0\n", 1],
		// Without the back-reference `\w` does not match `²`.
		["printf '\\302\\262\\n' | LC_ALL=C.UTF-8 grep -c -e '\\w'", "0\n", 1],
	]);
});

describe("builtin grep and sed: character classes in the C locale are bytes", () => {
	cases([
		// Regressed: in the C locale `[[:upper:]]` matches the UTF-8 letter `É`; GNU reads its two bytes, neither an upper-case letter.
		["printf '\\303\\211\\n' | LC_ALL=C grep -c '[[:upper:]]'", "0\n", 1],
		// Regressed: the same for `[[:alpha:]]` and `é`.
		["printf '\\303\\251\\n' | LC_ALL=C grep -c '[[:alpha:]]'", "0\n", 1],
		// Regressed: the same for `[[:alnum:]]`.
		["printf '\\303\\251\\n' | LC_ALL=C grep -c '[[:alnum:]]'", "0\n", 1],
		// Regressed: sed's `[[:lower:]]` likewise selects the line.
		["printf '\\303\\251\\n' | LC_ALL=C sed -n '/[[:lower:]]/p'", "", 0],
	]);
});

describe("builtin grep: -i in the C locale folds ASCII letters only", () => {
	cases([
		// Regressed: `grep -i I` matches the dotless `ı` in the C locale; GNU folds bytes there and counts no line.
		["printf '\\304\\261\\n' | LC_ALL=C grep -ic 'I'", "0\n", 1],
		// Regressed: the same the other way round, `ı` matching `I`.
		["printf 'I\\n' | LC_ALL=C grep -ic \"$(printf '\\304\\261')\"", "0\n", 1],
		// In C.UTF-8 `I` and `ı` are one another's case, as in GNU.
		["printf '\\304\\261\\n' | LC_ALL=C.UTF-8 grep -ic 'I'", "1\n", 0],
	]);
});

describe("builtin grep: -i in the C locale reads a range as written", () => {
	cases([
		// Regressed: in the C locale `-i` reads the reversed range `[a-Z]` as every letter and counts both lines; GNU's range is empty and counts none.
		["printf 'a\\nB\\n' | LC_ALL=C grep -ic '[a-Z]'", "0\n", 1],
		// A range in order is folded as GNU folds it.
		["printf 'a\\nB\\n' | LC_ALL=C grep -ic '[a-z]'", "2\n", 0],
	]);
});

describe("builtin sed: a script argument may hold bytes that are not UTF-8", () => {
	cases([
		// Regressed: a byte that is not UTF-8 in a comment makes sed refuse the whole script (exit 1, nothing printed); GNU runs it.
		["printf 'x\\n' | LC_ALL=C.UTF-8 sed \"$(printf 's/x/y/;# \\351')\"", "y\n", 0],
		// Regressed: the same for a byte that ends a bracket range.
		["printf 'b\\n' | LC_ALL=C.UTF-8 sed -n \"$(printf 's/[a-\\351]/<&>/p')\"", "<b>\n", 0],
		// Regressed: the same in the C locale.
		["printf 'b\\n' | LC_ALL=C sed -n \"$(printf 's/[a-\\351]/<&>/p')\"", "<b>\n", 0],
	]);
});

describe("builtin grep: a long-option prefix GNU does not know", () => {
	cases([
		// Regressed: `--mm` is taken as the builtin's own `--mmap` and the search runs (exit 0); GNU grep has no option it begins and exits 2.
		["printf 'a\\n' | LC_ALL=C.UTF-8 grep --mm a", "", 2],
		// Regressed: the same for `--include-d`, a prefix of the builtin's `--include-dir`.
		["printf 'a\\n' | LC_ALL=C.UTF-8 grep --include-d=x a", "", 2],
	]);
});
