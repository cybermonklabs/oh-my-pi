import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// The bash tool's shell runs `find` as a builtin. Each expectation below is
// the bytes GNU find 4.10 writes on stdout, and the status it exits with, for
// the same command under LC_ALL=C.UTF-8. stderr is dropped.

let dir: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "natives-find-r10-"));
	await fs.writeFile(path.join(dir, "f"), "x\n");
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Runs `command` in the builtin shell of a child process, which a crash of
 * the builtin ends alone, with stdout sent to `out`. Returns the child's own
 * exit status (0 when it lived to report), the builtin's, and the output.
 */
async function runInChild(command: string): Promise<{ child: number; exitCode: number; output: Buffer }> {
	const addon = path.join(import.meta.dir, "../native/index.js");
	const script = path.join(dir, "child.mjs");
	await fs.writeFile(
		script,
		[
			`import { executeShell } from ${JSON.stringify(addon)};`,
			`const command = ${JSON.stringify(`{ ${command}\n} >out 2>/dev/null`)};`,
			`const result = await executeShell({ command, cwd: ${JSON.stringify(dir)} }, () => {});`,
			"console.log(result.exitCode);",
		].join("\n"),
	);
	await fs.rm(path.join(dir, "out"), { force: true });
	const shell = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" });
	const [stdout, child] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
	const output = await fs.readFile(path.join(dir, "out")).catch(() => Buffer.alloc(0));
	return { child, exitCode: Number(stdout), output };
}

describe("builtin find: parentheses nested 10,000 deep", () => {
	const depth = 10_000;

	it("are read, and the process lives on", async () => {
		// Regressed: reading the expression recursed once a `(`, so the stack overflowed (from 1,000 deep), which aborts the whole process, the bash tool's host with it.
		const command = `find . ${"\\( ".repeat(depth)}-name f${" \\)".repeat(depth)}`;
		expect(await runInChild(command)).toEqual({ child: 0, exitCode: 0, output: Buffer.from("./f\n") });
	}, 60_000);

	it("left unclosed are refused with exit 1, and the process lives on", async () => {
		// Regressed: the same before the missing `)` is reported.
		const command = `find . ${"\\( ".repeat(depth)}-name f`;
		expect(await runInChild(command)).toEqual({ child: 0, exitCode: 1, output: Buffer.alloc(0) });
	}, 60_000);
});
