import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `grep` as a builtin. Each expectation below is
// what GNU grep 3.11 prints and exits with for the same command in the C
// locale, so a script an agent writes means the same thing in the tool as in
// a terminal.

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part G4): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[[.a]b]' is refused (a collating symbol with no closing .])
// Deleted (part G4): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[[:alpha]]' is refused (a class name with no closing :])
// Deleted (part G4): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[[=a]b]' is refused (an equivalence class with no closing =])
// Deleted (part G4): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[a[:]b]' is refused (a [: inside the list with no closing :])

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-gnu-"));
	await fs.writeFile(path.join(dir, "in"), "-5\n-1\nx\nzz\nb\n");
	// A pattern file whose name starts with a dash and a digit.
	await fs.writeFile(path.join(dir, "-1"), "-5\n");
	await fs.writeFile(path.join(dir, "empty"), "");
	await fs.writeFile(path.join(dir, "pats"), "zz\n\nb\n");
	await fs.writeFile(path.join(dir, "br"), "a\n:\nb]\n^\na[b\nx[]\nx\n[x\n");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

async function grep(args: string): Promise<{ stdout: string; exitCode: number | undefined }> {
	let stdout = "";
	const result = await executeShell({ command: `grep ${args} 2>/dev/null`, cwd: dir }, (_error, chunk) => {
		stdout += chunk;
	});
	return { stdout, exitCode: result.exitCode };
}

describe("builtin grep: the argument after -e or -f ending a cluster of short options", () => {
	// GNU reads the next argument as the pattern or the pattern file whatever
	// its first character, also when -e or -f ends a cluster such as -ve.
	it.each([
		// Regressed: `grep -ve -5` searches for a different pattern and prints every line.
		["-ve -5 in", "-1\nx\nzz\nb\n"],
		// Regressed: the count of lines holding `-5` is 0 and the exit status 1.
		["-ce -5 in", "1\n"],
		// Regressed: `grep -ne -1` finds no line.
		["-ne -1 in", "2:-1\n"],
		// Regressed: the pattern file `-1` is not read; grep fails with exit 2.
		["-cf -1 in", "1\n"],
	])("grep %s", async (args, stdout) => {
		expect(await grep(args)).toEqual({ stdout, exitCode: 0 });
	});
});

describe("builtin grep: a BRE bracket expression GNU grep refuses", () => {
	// GNU refuses each pattern ("Unmatched [, [^, [:, [., or [=") with exit 2
	// and prints no line. Regressed: grep reports lines as matches, or "no
	// match" with exit 1, for a pattern that is not valid, and the caller
	// takes the answer as a real search result.
	it.each([
		["'a[b'", "a [ with no closing ]"],
		["'x[]'", "a ] first in the list, so nothing closes it"],
		["'[]'", "only a ], which is a member"],
		["'[^]'", "a negated list whose ] is a member"],
		["'[[:alpha:]'", "a valid class and then no closing ]"],
		["-e '[x' -e x", "one invalid pattern beside a valid one"],
	])("grep -n %s is refused (%s)", async args => {
		expect(await grep(`-n ${args} br`)).toEqual({ stdout: "", exitCode: 2 });
	});
});

describe("builtin grep: empty patterns", () => {
	// Regressed: `grep -i -f` with an empty pattern file prints every line as a match.
	it("grep -i -f with an empty pattern file selects no line", async () => {
		expect(await grep("-i -f empty in")).toEqual({ stdout: "", exitCode: 1 });
	});

	// Regressed: `-o` prints nothing, or only some of the real matches, because
	// the empty pattern's zero-length match hides them.
	it.each([
		["-o -e '' -e zz in", "zz\n"],
		["-o -f pats in", "zz\nb\n"],
	])("grep %s prints the matches of the non-empty patterns", async (args, stdout) => {
		expect(await grep(args)).toEqual({ stdout, exitCode: 0 });
	});
});
