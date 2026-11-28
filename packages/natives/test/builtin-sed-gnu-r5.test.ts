import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin. Each expectation below is
// the bytes GNU sed 4.9 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C.UTF-8 (all input here is UTF-8). The
// outputs are Latin-1 strings, one character to a byte: `"\xc3\xa9"` is the
// two bytes of `é`. stderr is dropped.

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part S4): builtin sed: Q adds no newline the input lacks > sed '3{Q}' nonl nonl2
// Deleted (part S7): builtin sed: an empty match next to a multibyte character > printf '\303\251a\n' | sed 's/[^é]*/-/g'
// Deleted (part S7): builtin sed: an empty match next to a multibyte character > printf '\303\251a\n' | sed -E 's/[^é]*/-/g'
// Deleted (part S7): builtin sed: an empty match next to a multibyte character > printf '\303\251t\303\251\n' | sed 's/[^é]*/-/g'

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part S4): builtin sed: Q adds no newline the input lacks > sed -z 2Q nonl nonl2

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-r5-"));
	// A file whose last line has no newline, and one whose last line has.
	await fs.writeFile(path.join(dir, "nonl"), "a\nb");
	await fs.writeFile(path.join(dir, "nl"), "a\n");
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

describe("builtin sed: Q adds no newline the input lacks", () => {
	cases([
		// Regressed: `b`, the last line of the first file, gains a newline although Q prints nothing after it.
		["sed 3Q nonl nl", "a\nb", 0],
	]);
});

describe("builtin sed: \\U and \\u keep a character that has no one-character upper case", () => {
	cases([
		// Regressed: `\U` writes `ß` as `SS`; GNU leaves `ß` as it is.
		[String.raw`printf '\303\237\n' | sed 's/.*/\U&/'`, "\xc3\x9f\n", 0],
		// Regressed: the same for `\u`.
		[String.raw`printf '\303\237\n' | sed 's/.*/\u&/'`, "\xc3\x9f\n", 0],
		// Regressed: the line changes length: `aß` becomes `ASS` where GNU gives `Aß`.
		[String.raw`printf 'a\303\237\n' | sed 's/.*/\U&/'`, "A\xc3\x9f\n", 0],
	]);
});
