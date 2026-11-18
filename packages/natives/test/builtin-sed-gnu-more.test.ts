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
		// Regressed: a count with g (`2g`, the second match and every later one) is refused.
		[String.raw`printf 'aa\n' | sed 's/a/b/2g' 2>/dev/null`, "ab\n", 0],
		// Regressed: `\U` in the replacement is written as a literal `U` instead of upper-casing.
		[String.raw`printf 'ab\n' | sed 's/./\U&/' 2>/dev/null`, "Ab\n", 0],
		// Regressed: the start-of-word anchor `\<` matches nothing.
		[String.raw`printf 'ab\n' | sed 's/\</</g' 2>/dev/null`, "<ab\n", 0],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});
});
