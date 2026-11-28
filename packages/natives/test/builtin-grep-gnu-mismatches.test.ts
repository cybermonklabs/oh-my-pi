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

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part G1): builtin grep: context counts, in groups of short options and alone > grep -0e mid ctx 2>/dev/null
// Deleted (part G1): builtin grep: context counts, in groups of short options and alone > grep -1o mid ctx 2>/dev/null
// Deleted (part G1): builtin grep: context counts, in groups of short options and alone > grep -n12m1 -e mid ctx 2>/dev/null

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part G1): builtin grep: context counts, in groups of short options and alone > grep -C0 mid ctx 2>/dev/null
// Deleted (part G1): builtin grep: context counts, in groups of short options and alone > grep -v -m1 -A1 x in 2>/dev/null

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-mismatch-"));
	// Lines 1 to 20, with `mid` on lines 5 and 13.
	const ctx = Array.from({ length: 20 }, (_, i) => (i === 4 || i === 12 ? "mid" : String(i + 1)));
	await fs.writeFile(path.join(dir, "ctx"), `${ctx.join("\n")}\n`);
	await fs.writeFile(path.join(dir, "in"), "-5\n-1\nx\nzz\nb\n");
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

describe("builtin grep: bracket expressions GNU grep refuses", () => {
	cases([
		// Regressed: `[:alpha:]` without the outer brackets is read as the list `:alph`, and the line counts, where GNU stops with "character class syntax is [[:space:]], not [:space:]".
		[String.raw`printf 'a:\n' | grep -c '[:alpha:]' 2>/dev/null`, "", 2],
		// Regressed: the same in an ERE.
		[String.raw`printf 'a:\n' | grep -cE '[:alpha:]' 2>/dev/null`, "", 2],
		// Regressed: a range whose ends fold backwards under -i is searched (count 0, exit 1) instead of refused as "Invalid range end".
		[String.raw`printf 'x\n' | grep -ci '[Z-a]' 2>/dev/null`, "", 2],
		// Regressed: a collating symbol of a multibyte character is accepted and matches, where GNU says "Invalid collation character".
		// (A plain string: under `bun test` a String.raw template writes a non-ASCII character as its `\u` escape.)
		["printf '\u00e9\\n' | grep -c '[[.\u00e9.]]' 2>/dev/null", "", 2],
	]);
});

describe("builtin grep: -o prints the longest match at each position", () => {
	cases([
		// Regressed: the empty branch of `(|zz)` hides `zz`, and -o prints nothing.
		[String.raw`printf 'zz\n' | grep -oE '(|zz)' 2>/dev/null`, "zz\n", 0],
		// Regressed: the BRE `q\?\|zz` prints nothing for the same reason.
		[String.raw`printf 'zz\n' | grep -o 'q\?\|zz' 2>/dev/null`, "zz\n", 0],
		// Regressed: the empty middle branch of `a||b` hides every `b`.
		[String.raw`printf 'ab\n' | grep -oE 'a||b' 2>/dev/null`, "a\nb\n", 0],
		// Regressed: the first branch `a` is printed instead of the longer `ab`.
		[String.raw`printf 'ab\n' | grep -oE 'a|ab' 2>/dev/null`, "ab\n", 0],
		// Regressed: the first pattern `a` is printed instead of the longer match of the second.
		[String.raw`printf 'ab\n' | grep -o -e a -e ab 2>/dev/null`, "ab\n", 0],
		// Regressed: the same with -F.
		[String.raw`printf 'ab\n' | grep -oF -e a -e ab 2>/dev/null`, "ab\n", 0],
	]);
});

describe("builtin grep: context counts, in groups of short options and alone", () => {
	cases([
		// Regressed: with -o -C1 the `--` between the groups is missing.
		["grep -o -C1 mid ctx 2>/dev/null", "mid\n--\nmid\n", 0],
		// Regressed: a later -5 replaces the explicit -A1, so five lines follow each match.
		["grep -A1 -5 mid ctx 2>/dev/null", "1\n2\n3\n4\nmid\n6\n--\n8\n9\n10\n11\n12\nmid\n14\n", 0],
		// Regressed: a later -C3 replaces the explicit -A1.
		["grep -A1 -C3 mid ctx 2>/dev/null", "2\n3\n4\nmid\n6\n--\n10\n11\n12\nmid\n14\n", 0],
	]);
});
