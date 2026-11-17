import { describe, expect, it } from "bun:test";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// what GNU sed 4.9 prints on stdout and exits with for the same command, in
// the C locale and in C.UTF-8 alike. stderr is dropped.

async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	let output = "";
	const result = await executeShell({ command }, (_error, chunk) => {
		output += chunk;
	});
	return { output, exitCode: result.exitCode };
}

describe("builtin sed: GNU sed's answers", () => {
	it.each([
		// Regressed: `[\]` (a backslash, as POSIX reads it inside a list) stops sed with "Unterminated bracket expression".
		[String.raw`printf 'a\\b\n' | sed 's/[\]/X/' 2>/dev/null`, "aXb\n", 0],
		// Regressed: the same list in an address stops sed, and the line is not printed.
		[String.raw`printf 'a\\b\n' | sed -n '/[\]/p' 2>/dev/null`, "a\\b\n", 0],
		// Regressed: `[:alpha:]` without the outer brackets replaces the `a`, where GNU stops with "character class syntax is [[:space:]], not [:space:]".
		[String.raw`printf 'a:\n' | sed 's/[:alpha:]/X/' 2>/dev/null`, "", 4],
		// Regressed: the first branch `a` is replaced instead of the longer match `ab`.
		[String.raw`printf 'ab\n' | sed -E 's/a|ab/X/' 2>/dev/null`, "X\n", 0],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
