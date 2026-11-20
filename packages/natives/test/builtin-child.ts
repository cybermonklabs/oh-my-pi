import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Runs `command` in the builtin shell of a child process, in `dir`, which a
 * crash of the builtin ends alone, with stdout sent to `out` there. Returns
 * the child's own exit status (0 when it lived to report), the builtin's, and
 * the output.
 */
export async function runInChild(
	dir: string,
	command: string,
): Promise<{ child: number; exitCode: number; output: Buffer }> {
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
