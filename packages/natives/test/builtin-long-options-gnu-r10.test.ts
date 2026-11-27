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

// Deleted: upstream main already answers these cases as GNU does, so this
// change does not carry them (INFRA-4986 spec v8, R1 and R4).
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > printf 'a\n' | tail --p=1
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > printf 'a\nb\n' | sort --ch
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > printf 'a\nb\n' | tail --r -n1
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > printf 'a\nb\n' | tail --re -n1
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > printf 'b\na\n' | sort --che
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > rm -rf d; mkdir d; printf x >d/s; cp --pr d/s d/t; echo $?; ls d
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > rm -rf d; mkdir d; printf x >d/s; cp --pres=mode d/s d/t; echo $?; ls d
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > rm -rf d; mkdir d; printf x >d/s; rm --p d/s; echo $?; ls d
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > rm -rf d; mkdir d; printf x >d/s; rm --pr d/s; echo $?; ls d
// Deleted (part X4): builtin cp, rm, sort and tail: a long option's abbreviation GNU accepts > rm -rf d; mkdir d; printf x >d/s; rm --pres d/s; echo $?; ls d

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
		// A prefix ambiguous among GNU's own options is still refused.
		[inD("cp --p d/s d/t"), "1\ns\n", 0],
		[String.raw`printf 'b\na\n' | sort --c`, "", 2],
		// And `--no-preserve-root` may not be abbreviated at all.
		[inD("rm --no-pres d/s"), "1\ns\n", 0],
	]);
});
