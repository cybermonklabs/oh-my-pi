import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell } from "../native/index.js";

// The bash tool's shell runs `cat`, `grep`, `find` and `du` as builtins. Each
// expectation below is the bytes GNU coreutils 9.7, grep 3.11 and findutils
// 4.10 write, with stderr sent to stdout (`2>&1`) and both into a regular
// file, and the status they exit with, for the same command under
// LC_ALL=C.UTF-8 unless a case names another locale. GNU prints a diagnostic
// where it was written among the output: glibc's `error` flushes stdout first.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-order-r10-"));
	await fs.writeFile(path.join(dir, "abc"), "a\nb\nc\n");
	await fs.mkdir(path.join(dir, "d"));
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell with stdout sent to a file, whose bytes
 * are returned with the shell's exit status.
 */
async function run(command: string): Promise<{ output: string; exitCode: number | undefined }> {
	const result = await executeShell(
		{ command: `{ export LC_ALL=C.UTF-8; ${command}\n} >out 2>/dev/null`, cwd: dir },
		() => {},
	);
	return { output: await fs.readFile(path.join(dir, "out"), "utf8"), exitCode: result.exitCode };
}

/**
 * Whether a directory without write permission refuses a new file. It does not
 * for a process that overrides file permissions, such as root in a build
 * container, where the find `-delete` case below cannot be refused.
 */
async function readOnlyDirectoryRefusesWrites(): Promise<boolean> {
	const probe = await fs.mkdtemp(path.join(os.tmpdir(), "natives-order-r10-probe-"));
	try {
		await fs.chmod(probe, 0o555);
		try {
			await fs.writeFile(path.join(probe, "x"), "");
			return false;
		} catch {
			return true;
		}
	} finally {
		await fs.chmod(probe, 0o755);
		await fs.rm(probe, { recursive: true, force: true });
	}
}

const readOnlyRefuses = await readOnlyDirectoryRefusesWrites();

describe("builtin output and diagnostics sent to one file with 2>&1", () => {
	it.each([
		// Regressed: every line of output came first and the diagnostic last.
		["cat abc nosuch abc 2>&1", "a\nb\nc\ncat: nosuch: No such file or directory\na\nb\nc\n", 1],
		["cat nosuch abc 2>&1", "cat: nosuch: No such file or directory\na\nb\nc\n", 1],
		// Regressed: the same for grep.
		["grep -H a abc d abc 2>&1", "abc:a\ngrep: d: Is a directory\nabc:a\n", 2],
		// Regressed: the same for du, which writes its output to the descriptor unbuffered.
		["du -sb nosuch abc 2>&1", "du: cannot access 'nosuch': No such file or directory\n6\tabc\n", 1],
		// A pipe already kept the order.
		["cat abc nosuch abc 2>&1 | cat", "a\nb\nc\ncat: nosuch: No such file or directory\na\nb\nc\n", 0],
	])("%s", async (command, output, exitCode) => {
		expect(await run(command)).toEqual({ output, exitCode });
	});

	// Regressed: the same for find, whose `-delete` refused in a directory it cannot write.
	it.skipIf(!readOnlyRefuses)("find -delete refused in a directory it cannot write", async () => {
		const command =
			"mkdir -p ro; touch ro/a ro/b; chmod 555 ro; LC_ALL=C find ro -type f -print -delete 2>&1; echo $?; chmod 755 ro";
		expect(await run(command)).toEqual({
			output:
				"ro/a\nfind: cannot delete 'ro/a': Permission denied\nro/b\nfind: cannot delete 'ro/b': Permission denied\n1\n",
			exitCode: 0,
		});
	});
});
