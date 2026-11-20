import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `cp`, `rm`, `sort` and `tail` as builtins. Each
// expectation below is the bytes GNU coreutils 9.7 writes on stdout, and the
// status it exits with, for the same command under LC_ALL=C.UTF-8. stderr is
// dropped. Each command makes the files it reads, so a case does not depend
// on another.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-long-options-r10-"));
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

/** Makes the directory `d` holding the file `s`, runs `command`, then lists `d`. */
const inD = (command: string) => `rm -rf d; mkdir d; printf x >d/s; ${command}; echo $?; ls d`;

describe("builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts", () => {
	cases([
		// Regressed: `--pres` also begins the builtin's own `--preserve-default-attributes`, so clap calls it ambiguous and cp exits 1; GNU reads `--preserve`.
		[inD("cp --pres=mode d/s d/t"), "0\ns\nt\n", 0],
		// Regressed: the same for `--pr`, which also begins the builtin's `--progress`.
		[inD("cp --pr d/s d/t"), "0\ns\nt\n", 0],
		// Regressed: `--p` also begins the builtin's `--progress` and `--presume-input-tty`, which GNU hides behind a third dash; GNU reads `--preserve-root`.
		[inD("rm --p d/s"), "0\n", 0],
		// Regressed: the same for `--pr`.
		[inD("rm --pr d/s"), "0\n", 0],
		// Regressed: the same for `--pres`.
		[inD("rm --pres d/s"), "0\n", 0],
		// Regressed: `--ch` also begins the builtin's `--check-silent`; GNU reads `--check`.
		[String.raw`printf 'a\nb\n' | sort --ch`, "", 0],
		// Regressed: the same for `--che`, which finds the disorder and exits 1.
		[String.raw`printf 'b\na\n' | sort --che`, "", 1],
		// Regressed: `--p` also begins the builtin's `--presume-input-pipe`; GNU reads `--pid`.
		[String.raw`printf 'a\n' | tail --p=1`, "a\n", 0],
		// Regressed: `--r` also begins the builtin's `--reverse`; GNU reads `--retry`.
		[String.raw`printf 'a\nb\n' | tail --r -n1`, "b\n", 0],
		// Regressed: the same for `--re`.
		[String.raw`printf 'a\nb\n' | tail --re -n1`, "b\n", 0],
		// A prefix ambiguous among GNU's own options is still refused.
		[inD("cp --p d/s d/t"), "1\ns\n", 0],
		[String.raw`printf 'b\na\n' | sort --c`, "", 2],
		// And `--no-preserve-root` may not be abbreviated at all.
		[inD("rm --no-pres d/s"), "1\ns\n", 0],
	]);
});
