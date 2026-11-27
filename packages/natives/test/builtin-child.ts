import * as fs from "node:fs/promises";
import * as path from "node:path";

interface ChildRun {
	child: number;
	exitCode: number;
	output: Buffer;
}

/**
 * Runs `command` in the builtin shell of a child process, in `dir`, which a
 * crash of the builtin ends alone, with stdout sent to `out` there and stderr
 * to `err`. Returns the child's own exit status (0 when it lived to report),
 * the builtin's, and the output; with `{ stderr: true }`, what was written on
 * stderr too.
 */
export async function runInChild(dir: string, command: string): Promise<ChildRun>;
export async function runInChild(
	dir: string,
	command: string,
	options: { stderr: true },
): Promise<ChildRun & { stderr: Buffer }>;
export async function runInChild(
	dir: string,
	command: string,
	options?: { stderr: true },
): Promise<ChildRun | (ChildRun & { stderr: Buffer })> {
	const addon = path.join(import.meta.dir, "../native/index.js");
	const script = path.join(dir, "child.mjs");
	await fs.writeFile(
		script,
		[
			`import { executeShell } from ${JSON.stringify(addon)};`,
			`const command = ${JSON.stringify(`{ ${command}\n} >out 2>err`)};`,
			`const result = await executeShell({ command, cwd: ${JSON.stringify(dir)} }, () => {});`,
			"console.log(result.exitCode);",
		].join("\n"),
	);
	await fs.rm(path.join(dir, "out"), { force: true });
	await fs.rm(path.join(dir, "err"), { force: true });
	const shell = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "ignore" });
	const [stdout, child] = await Promise.all([new Response(shell.stdout).text(), shell.exited]);
	const output = await fs.readFile(path.join(dir, "out")).catch(() => Buffer.alloc(0));
	const run = { child, exitCode: Number(stdout), output };
	if (!options?.stderr) return run;
	const stderr = await fs.readFile(path.join(dir, "err")).catch(() => Buffer.alloc(0));
	return { ...run, stderr };
}
