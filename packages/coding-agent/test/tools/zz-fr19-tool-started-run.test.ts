/**
 * Staging-only (ForkReview19): an in-process run that a session tool starts, while the run that called the tool awaits
 * it, does not wait for that run's turn. The tool's host side runs in `JsRuntime`'s `#hostCall`, which leaves the
 * runtime's store and the realm's run record; in-process-run's `insideRun` must survive it, or the started run waits
 * for the turn of the run that waits for it, until its own budget ends.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

const probe = `
import { type } from "@oh-my-pi/omptype";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { runInProcessTab } from "@oh-my-pi/pi-coding-agent/tools/browser/in-process-run";

const cwd = process.cwd();
const tab = surfaceId =>
	new CmuxTab({ client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-tool-nested-probe.sock" }), surfaceId });
const outer = tab("outer");
let nested = "not started";
let nestedMs = -1;
const tool = {
	name: "nested_probe",
	label: "nested_probe",
	description: "Starts an in-process run on the calling tab and awaits it",
	parameters: type({}),
	async execute() {
		const started = Date.now();
		try {
			const result = await runInProcessTab(outer, { code: "21 * 2;", timeoutMs: 2_000, session, snapshot: { cwd } });
			nested = "ok:" + JSON.stringify(result.returnValue);
		} catch (error) {
			nested = error instanceof Error ? error.name + ": " + error.message : String(error);
		}
		nestedMs = Date.now() - started;
		return { content: [{ type: "text", text: nested }] };
	},
};
const session = { cwd, hasUI: false, getSessionFile: () => null, getToolByName: name => (name === tool.name ? tool : undefined) };
const report = async (label, run) => {
	try {
		const result = await run;
		process.stdout.write(\`\${label}:ok:\${JSON.stringify(result.returnValue)}\\n\`);
	} catch (error) {
		process.stdout.write(\`\${label}:\${error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error)}\\n\`);
	}
};
await report("outer", runInProcessTab(outer, { code: "await tool.nested_probe({}); 1;", timeoutMs: 10_000, session, snapshot: { cwd } }));
process.stdout.write(\`nested:\${nested}\\n\`);
process.stderr.write(\`NESTED-MS \${nestedMs}\\n\`);
await report("after", runInProcessTab(tab("after-nested"), { code: "5;", timeoutMs: 10_000, session, snapshot: { cwd } }));
`;

test("an in-process run a session tool starts during a run does not wait for that run's turn", async () => {
	const proc = Bun.spawn([process.execPath, "--eval", probe], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	console.log(
		`TOOL-STARTED-RUN stdout=${JSON.stringify(stdout)} ${stderr.split("\n").find(l => l.startsWith("NESTED-MS")) ?? "NESTED-MS ?"}`,
	);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe(["outer:ok:1", "nested:ok:42", "after:ok:5", ""].join("\n"));
}, 60_000);
