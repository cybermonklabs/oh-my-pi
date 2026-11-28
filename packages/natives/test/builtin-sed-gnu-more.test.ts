import { describe, expect, it } from "bun:test";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// what GNU sed 4.9 prints on stdout and exits with for the same command, in
// the C locale and in C.UTF-8 alike. stderr is dropped.

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part S12): builtin sed: a `}` ends a command, as a `;` does > printf 'x\ny\n' | sed '/x/{q5}' 2>/dev/null
// Deleted (part S12): builtin sed: a `}` ends a command, as a `;` does > printf 'x\ny\n' | sed '/x/{y/x/X/ }' 2>/dev/null
// Deleted (part S12): builtin sed: a `}` ends a command, as a `;` does > printf 'x\ny\n' | sed -n '/x/{ba};p;:a' 2>/dev/null
// Deleted (part S12): builtin sed: a `}` ends a command, as a `;` does > printf 'x\ny\n' | sed -n '/x/{p}' 2>/dev/null
// Deleted (part S12): builtin sed: a `}` ends a command, as a `;` does > printf 'x\ny\n' | sed -n '/x/{s/x/X/gp}' 2>/dev/null
// Deleted (part S12): builtin sed: a `}` ends a command, as a `;` does > printf 'x\ny\n' | sed -n '1{/x/{p}}' 2>/dev/null

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part S9): builtin sed: substitute flags and replacements > printf 'aaaa\n' | sed 's/a/b/2g' 2>/dev/null

// Deleted: upstream main c9730fdb gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v24).
// Deleted (part G6): builtin sed: patterns > printf 'aa\n' | sed 's/a\+\?/X/' 2>/dev/null
// Deleted (part S13): builtin sed: what GNU sed refuses > printf 'a)\n' | sed -E 's/a)/X/' 2>/dev/null
// Deleted (part S10): builtin sed: what GNU sed refuses > printf 'aab\n' | sed 's/a**/X/' 2>/dev/null

async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	let output = "";
	const result = await executeShell({ command }, (_error, chunk) => {
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

describe("builtin sed: substitute flags and replacements", () => {
	cases([
		// Regressed: `\U` in the replacement is written as a literal `U` instead of upper-casing.
		[String.raw`printf 'abc\n' | sed 's/a./\U&/' 2>/dev/null`, "ABc\n", 0],
		// Regressed: with `U` as the delimiter, `\U` is a case directive instead of the escaped delimiter.
		[String.raw`printf 'aU\n' | sed 'sUaU\UU' 2>/dev/null`, "UU\n", 0],
	]);
});

describe("builtin sed: patterns", () => {
	cases([
		// Regressed: the start-of-word anchor `\<` matches nothing.
		[String.raw`printf 'ab\n' | sed 's/\</</g' 2>/dev/null`, "<ab\n", 0],
		// `.*?:` takes `ab:` in the ERE, as GNU reads it.
		[String.raw`printf 'ab:cd\n' | sed -E 's/.*?:/X/' 2>/dev/null`, "Xcd\n", 0],
		// Regressed: a class between the colons is refused as a class name without its brackets.
		[String.raw`printf 'a:\n' | sed 's/[:[:digit:]:]/X/' 2>/dev/null`, "aX\n", 0],
	]);
});

describe("builtin sed: the longest match of an alternation", () => {
	cases([
		// Regressed: an empty match right where the last match ended is replaced too.
		[String.raw`echo aabb | sed 's/a*\|q/X/g' 2>/dev/null`, "XbXbX\n", 0],
		// Regressed: the same with -E.
		[String.raw`printf 'baaac\n' | sed -E 's/a*|b/x/g' 2>/dev/null`, "xxcx\n", 0],
		// Regressed: the same at the end of the line.
		[String.raw`printf 'aac\n' | sed -E 's/a*|b/-/g' 2>/dev/null`, "-c-\n", 0],
		// Regressed: each branch searched alone renumbered its groups, and the pattern is refused.
		[String.raw`printf 'bb\nab\n' | sed 's/\(a\)\|\(b\)\2/X/' 2>/dev/null`, "X\nXb\n", 0],
		// Regressed: the same for a back-reference in each branch.
		[String.raw`printf 'xqx yry\n' | sed 's/\(x\)[^x]*\1\|\(y\)[^y]*\2/X/g' 2>/dev/null`, "X X\n", 0],
		// Regressed: a back-reference to a group of another branch is searched instead of refused.
		[String.raw`printf 'bb\n' | sed 's/\(a\)\|\(b\)\1/X/' 2>/dev/null`, "", 1],
	]);
});

describe("builtin sed: what GNU sed refuses", () => {
	cases([
		// Regressed: a leading `*` in an ERE is dropped instead of refused.
		[String.raw`printf 'x\n' | sed -E 's/*x/Y/' 2>/dev/null`, "", 1],
	]);
});

describe("builtin sed: l lists a newline of the pattern space as an escape", () => {
	cases([
		// Regressed: `x$` and `x$\ny$` were listed, as if each were a line of its own.
		[String.raw`printf 'x\ny\n' | sed -n 'N;l' 2>/dev/null`, "x\\ny$\n", 0],
	]);
});
