import { describe, expect, it } from "bun:test";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// what GNU sed 4.9 prints and exits with for the same script on the line
// `a[b`: a `[` inside a bracket expression is one more member of the list,
// as POSIX says, and does not open anything.

async function sed(script: string): Promise<{ stdout: string; exitCode: number | undefined }> {
	let stdout = "";
	const result = await executeShell({ command: `printf 'a[b\\n' | sed ${script} 2>/dev/null` }, (_error, chunk) => {
		stdout += chunk;
	});
	return { stdout, exitCode: result.exitCode };
}

describe("builtin sed: a [ as a member of a bracket expression", () => {
	it.each([
		// Regressed: sed stops with "Unterminated bracket expression" and exit 1, the line is not printed.
		["'s/[[]/x/'", "axb\n"],
		// Regressed: the same script with -E stops with exit 1.
		["-E 's/[[]/x/'", "axb\n"],
		// Regressed: an address with `[[]` is refused and the matching line is not printed.
		["-n '/[[]/p'", "a[b\n"],
		// Regressed: a negated list holding `[` is refused instead of replacing the other characters.
		["'s/[^[]/y/g'", "y[y\n"],
		// Regressed: the list `][` (a leading `]`, then `[`) is refused.
		["'s/[][]/y/g'", "ayb\n"],
		// Regressed: a `[` after a character class in the list is refused.
		["'s/[[:alpha:][]/y/g'", "yyy\n"],
	])("sed %s", async (script, stdout) => {
		expect(await sed(script)).toEqual({ stdout, exitCode: 0 });
	});
});
