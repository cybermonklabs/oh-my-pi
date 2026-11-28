import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `xargs` as a builtin. Each expectation below is
// the bytes GNU xargs (findutils 4.10) writes on stdout, and the status it
// exits with, for the same command under LC_ALL=C.UTF-8. stderr is dropped,
// unless a command sends it to stdout itself (`2>&1`).

// Deleted: upstream main 9319b0b3 gives GNU's answer for these cases, so
// this change does not carry them (INFRA-4986 inventory v20).
// Deleted (part X2): builtin xargs: a command it cannot run, or that exits 255 > printf '#!/bin/sh\necho hi\n' >noexec; mkdir -p d; echo a | xargs sh -c 'exit 255' 2>&1

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-xargs-r10-"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell with stdout sent to a file, whose bytes
 * are returned with the shell's exit status.
 */
async function run(command: string): Promise<{ output: Buffer; exitCode: number | undefined }> {
	const result = await executeShell({ command: `{ ${command}\n} >out 2>/dev/null`, cwd: dir }, () => {});
	return { output: await fs.readFile(path.join(dir, "out")), exitCode: result.exitCode };
}

/** Makes `noexec` (not executable) and `d`, then runs `echo a | xargs ARGS`. */
const xargs = (args: string) => `printf '#!/bin/sh\\necho hi\\n' >noexec; mkdir -p d; echo a | xargs ${args} 2>&1`;

describe("builtin xargs: a command it cannot run, or that exits 255", () => {
	it.each([
		// Regressed: `Command could not be run: permission denied`; GNU names the command, with strerror's text.
		[xargs("./noexec"), "xargs: ./noexec: Permission denied\n", 126],
		[xargs("-P2 ./noexec"), "xargs: ./noexec: Permission denied\n", 126],
		[xargs("-I{} ./noexec {}"), "xargs: ./noexec: Permission denied\n", 126],
		// Regressed: a directory was "No such file or directory", status 127; it cannot be executed.
		[xargs("./d"), "xargs: ./d: Permission denied\n", 126],
		// Nothing has the name: already as GNU.
		[xargs("nosuch"), "xargs: nosuch: No such file or directory\n", 127],
		// Regressed: a script whose interpreter is missing ran in the shell, which wrote its own "bad interpreter" message and exited 126, so xargs exited 123; GNU's execvp fails with ENOENT.
		[
			`printf '#!/nonexistent/sh\\n' >badint; chmod +x badint; ${xargs("./badint")}`,
			"xargs: ./badint: No such file or directory\n",
			127,
		],
		// Regressed: the same for an interpreter that cannot be executed: EACCES.
		[
			`printf '#!/etc/passwd\\n' >badint2; chmod +x badint2; ${xargs("./badint2")}`,
			"xargs: ./badint2: Permission denied\n",
			126,
		],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output: Buffer.from(output, "latin1"), exitCode });
	});
});

describe("builtin xargs: a command name that is not UTF-8", () => {
	it("is written as its bytes", async () => {
		// Regressed: written with U+FFFD for the byte 0xFF.
		expect(await run(String.raw`echo a | xargs $'n\377' 2>&1; echo $?`)).toEqual({
			output: Buffer.from("xargs: n\xff: No such file or directory\n127\n", "latin1"),
			exitCode: 0,
		});
	});
});
