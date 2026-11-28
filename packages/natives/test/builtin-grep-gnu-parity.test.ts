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

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part G4a): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[[:alpha:]' is refused (a valid class and then no closing ])
// Deleted (part G4a): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[]' is refused (only a ], which is a member)
// Deleted (part G4a): builtin grep: a BRE bracket expression GNU grep refuses > grep -n '[^]' is refused (a negated list whose ] is a member)
// Deleted (part G4a): builtin grep: a BRE bracket expression GNU grep refuses > grep -n 'a[b' is refused (a [ with no closing ])
// Deleted (part G4a): builtin grep: a BRE bracket expression GNU grep refuses > grep -n 'x[]' is refused (a ] first in the list, so nothing closes it)
// Deleted (part G4a): builtin grep: a BRE bracket expression GNU grep refuses > grep -n -e '[x' -e x is refused (one invalid pattern beside a valid one)

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-grep-gnu-"));
	await fs.writeFile(path.join(dir, "in"), "-5\n-1\nx\nzz\nb\n");
	// A pattern file whose name starts with a dash and a digit.
	await fs.writeFile(path.join(dir, "-1"), "-5\n");
	await fs.writeFile(path.join(dir, "empty"), "");
	await fs.writeFile(path.join(dir, "pats"), "zz\n\nb\n");
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
