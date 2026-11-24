import { expect, test } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../../..");

// A fresh process: before the fix, the first stuck run held the realm's run slot until the process exited.
const probe = `
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { runInProcessTab } from "@oh-my-pi/pi-coding-agent/tools/browser/in-process-run";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";

const cwd = process.cwd();
const session = { cwd, hasUI: false, getSessionFile: () => null };
const tab = surfaceId =>
	new CmuxTab({ client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-release-probe.sock" }), surfaceId });
const report = async (label, run) => {
	try {
		const result = await run;
		process.stdout.write(\`\${label}:ok:\${JSON.stringify(result.returnValue)}\\n\`);
	} catch (error) {
		process.stdout.write(\`\${label}:\${error instanceof Error ? \`\${error.name}: \${error.message}\` : String(error)}\\n\`);
	}
};
const never = "await new Promise(() => {});";

const timedOut = tab("timed-out");
await report("timed-out", runInProcessTab(timedOut, { code: never, timeoutMs: 100, session, snapshot: { cwd } }));
// Control: the same tab's runtime runs again (it owns the slot), so only another runtime shows the slot is held.
await report("same-tab", runInProcessTab(timedOut, { code: "3;", timeoutMs: 10_000, session, snapshot: { cwd } }));
await report("after-timeout", runInProcessTab(tab("after-timeout"), { code: "1 + 1;", timeoutMs: 10_000, session, snapshot: { cwd } }));

const cancel = new AbortController();
globalThis.cancelThisRun = () => cancel.abort();
await report(
	"cancelled",
	runInProcessTab(tab("cancelled"), {
		code: \`cancelThisRun(); \${never}\`,
		timeoutMs: 10_000,
		signal: cancel.signal,
		session,
		snapshot: { cwd },
	}),
);
await report("after-cancel", runInProcessTab(tab("after-cancel"), { code: "2 + 3;", timeoutMs: 10_000, session, snapshot: { cwd } }));

// Floating code of a timed-out run that wakes after the run ended is refused, and its unhandled rejection names
// the run's guest file, so it is logged rather than ending the process.
const lateGate = Promise.withResolvers();
globalThis.lateGate = lateGate.promise;
await report(
	"late-timed-out",
	runInProcessTab(tab("late"), {
		code: \`(async () => { await lateGate; globalThis.lateRan = true; print("late"); })(); \${never}\`,
		timeoutMs: 100,
		session,
		snapshot: { cwd },
	}),
);
lateGate.resolve();
for (let turn = 0; turn < 2; turn++) {
	const next = Promise.withResolvers();
	setImmediate(next.resolve);
	await next.promise;
}
process.stdout.write(\`late-ran:\${globalThis.lateRan === true}\\n\`);
await report("after-late", runInProcessTab(tab("after-late"), { code: "6;", timeoutMs: 10_000, session, snapshot: { cwd } }));
`;

test("a timed-out or cancelled in-process browser run whose code never settles leaves the next tab's run working", async () => {
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

	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe(
		[
			"timed-out:ToolError: Browser code execution timed out after 100ms",
			"same-tab:ok:3",
			"after-timeout:ok:2",
			"cancelled:ToolAbortError: Operation aborted",
			"after-cancel:ok:5",
			"late-timed-out:ToolError: Browser code execution timed out after 100ms",
			"late-ran:true",
			"after-late:ok:6",
			"",
		].join("\n"),
	);
});
