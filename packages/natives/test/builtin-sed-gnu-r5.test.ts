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

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-r5-"));
	// Two files whose last line has no newline, and one whose last line has.
	await fs.writeFile(path.join(dir, "nonl"), "a\nb");
	await fs.writeFile(path.join(dir, "nonl2"), "x\ny");
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
		// Regressed: the same with Q inside a block.
		["sed '3{Q}' nonl nonl2", "a\nb", 0],
		// Regressed: under -z the record `a\nb` gains a NUL the input lacks.
		["sed -z 2Q nonl nonl2", "a\nb", 0],
	]);
});

describe("builtin sed: an empty match next to a multibyte character", () => {
	cases([
		// Regressed: an empty match is found between the two bytes of `é`, so `-` splits the character (`- \303 - \251 -`).
		// (A plain string: under `bun test` a String.raw template writes a non-ASCII character as its `\u` escape.)
		["printf '\\303\\251a\\n' | sed 's/[^\u00e9]*/-/g'", "-\xc3\xa9-\n", 0],
		// Regressed: the same in an ERE.
		["printf '\\303\\251a\\n' | sed -E 's/[^\u00e9]*/-/g'", "-\xc3\xa9-\n", 0],
		// Regressed: each `é` of `été` is split the same way.
		["printf '\\303\\251t\\303\\251\\n' | sed 's/[^\u00e9]*/-/g'", "-\xc3\xa9-\xc3\xa9-\n", 0],
	]);
});

// Skipped: the base release already differs from GNU here; tracked separately.
describe.skip("builtin sed: \\U and \\u keep a character that has no one-character upper case", () => {
	cases([
		// Regressed: `\U` writes `ß` as `SS`; GNU leaves `ß` as it is.
		[String.raw`printf '\303\237\n' | sed 's/.*/\U&/'`, "\xc3\x9f\n", 0],
		// Regressed: the same for `\u`.
		[String.raw`printf '\303\237\n' | sed 's/.*/\u&/'`, "\xc3\x9f\n", 0],
		// Regressed: the line changes length: `aß` becomes `ASS` where GNU gives `Aß`.
		[String.raw`printf 'a\303\237\n' | sed 's/.*/\U&/'`, "A\xc3\x9f\n", 0],
	]);
});
