import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `sed` as a builtin, which reads a line that is
// UTF-8 as characters in every locale. Each expectation below is the bytes
// GNU sed 4.9 writes on stdout, and the status it exits with, for the same
// command in C.UTF-8; each comment gives GNU's output as `od -c` prints it,
// and its answer in the C locale, which reads the line a byte to a character.
// stderr is dropped. The outputs are Latin-1 strings, one character to a byte.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-sed-utf8-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell. stdout goes to a file, whose bytes
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

describe("builtin sed: a line cut inside a character and joined back is UTF-8 again", () => {
	cases([
		// `c a F a u l a i t \n`: `s/ *//g` matches empty inside the `é` and leaves the line as it was,
		// so `.` is the `é`. In C: `c a F 251 a u l a i t \n`. Regressed: `caF\251aulait`, the line
		// held as bytes.
		[String.raw`printf 'caf\303\251 au lait\n' | sed 's/ *//g;s/f./F/'`, "caFaulait\n", 0],
		// `C A F 303 211 A U L A I T \n`, the `é` upper-cased to `É`. In C: `C A F 377 377 A U L A I T \n`.
		// Regressed: `CAF\303\251AULAIT`, bytes having no case.
		[String.raw`printf 'caf\303\251 au lait\n' | sed 's/ *//g;s/.*/\U&/'`, "CAF\xc3\x89AULAIT\n", 0],
		// `c a f e a u l a i t \n`. In C GNU refuses `y/é/e/` (strings of different lengths).
		// Regressed: `caf\303\251aulait`.
		[String.raw`printf 'caf\303\251 au lait\n' | sed 's/ *//g;y/é/e/'`, "cafeaulait\n", 0],
		// `X X X \n`: the fourth empty match is the one after the `a`, and the second, inside the `é`,
		// is left as it was. In C: `X X X X \n`. Regressed: `XXXX`.
		[String.raw`printf '\303\251a\n' | sed 's/x*/-/4;s/./X/g'`, "XXX\n", 0],
		// `Y \n`. In C: `Y Y \n`. Regressed: `YY`.
		[String.raw`printf '\303\251\n' | sed 's/x*//g;s/./Y/g'`, "Y\n", 0],
		// `- c - a - f - 303 - 251 - \n` in both locales: the bytes of the `é` are parted, and the line
		// is held as bytes. Already GNU's answer, kept.
		[String.raw`printf 'caf\303\251\n' | sed 's/x*/-/g'`, "-c-a-f-\xc3-\xa9-\n", 0],
	]);
});

describe("builtin sed: an empty match inside a character only where GNU searches a byte at a time", () => {
	cases([
		// `- 303 251 - \n`: a bracket expression with a range is searched a character at a time, so no
		// match starts inside the `é`. Regressed: `- 303 - 251 -`.
		[String.raw`printf '\303\251a\n' | sed 's/[a-z]*/-/g'`, "-\xc3\xa9-\n", 0],
		// `- 303 251 - a - \n`: so is `\W`. Regressed: `- 303 - 251 - a -`.
		[String.raw`printf '\303\251a\n' | sed 's/\W*/-/g'`, "-\xc3\xa9-a-\n", 0],
		// `- 303 251 - a - \n`: and any pattern read without case. Regressed: `- 303 - 251 - a -`.
		[String.raw`printf '\303\251a\n' | sed 's/x*/-/Ig'`, "-\xc3\xa9-a-\n", 0],
		// `- 303 - 251 - a - \n`: a list of ASCII characters is searched a byte at a time. Already GNU's
		// answer, kept.
		[String.raw`printf '\303\251a\n' | sed 's/[x]*/-/g'`, "-\xc3-\xa9-a-\n", 0],
		// `- 303 - 251 - a - \n`: so is `.`. Already GNU's answer, kept.
		[String.raw`printf '\303\251a\n' | sed 's/\(.x\)*/-/g'`, "-\xc3-\xa9-a-\n", 0],
	]);
});
