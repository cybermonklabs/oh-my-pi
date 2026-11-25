/**
 * Staging-only (the combined tree of three landings on Cut11): an inline tab's run awaits a session tool and times
 * out. Three changes meet on that path: the tab worker discards the run's runtime (the run is abandoned), the kill
 * aborts the run's pending host tool call, and the tool call's host side runs outside the run, so a write that host
 * code makes after the abort reaches the process's stdout. The write is in the tool's own continuation (after an
 * await), so it runs in the tool call's async context, not the aborter's.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const repoRoot = path.resolve(import.meta.dir, "../../../..");

const probe = `
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, getTabsMapForTest, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

// Refuse tab Workers, so the tab uses the inline worker in this realm.
globalThis.Worker = function () {
	throw new Error("this probe refuses tab Workers, so tabs use the inline worker");
};
let abortReason = "not aborted";
const tool = {
	name: "pending_probe",
	label: "pending_probe",
	description: "Stays in flight until aborted, then writes to stdout",
	parameters: type({}),
	async execute(_id, _args, signal) {
		const aborted = Promise.withResolvers();
		if (signal?.aborted) aborted.reject(signal.reason);
		else signal?.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
		try {
			await aborted.promise;
		} catch (reason) {
			abortReason = reason instanceof Error ? reason.message : String(reason);
			// This continuation runs in the tool call's async context.
			process.stdout.write("HOST-WRITE-AFTER-KILL\\n");
			throw reason;
		}
	},
};
const session = {
	cwd: os.tmpdir(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getToolByName: name => (name === tool.name ? tool : undefined),
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"browser.tern": false,
		"tools.maxTimeout": 0,
	}),
};
const name = "combined-lifetimes";
const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: os.tmpdir() });
const { tab } = await acquireTab(name, browser, { timeoutMs: 30_000 });
const mode = tab.backend === "worker" ? tab.worker.mode : tab.backend;
await runInTab(name, { code: "1 + 1;", timeoutMs: 30_000, session });
let runError = "resolved";
try {
	await runInTab(name, { code: "await tool.pending_probe({});", timeoutMs: 500, session });
} catch (error) {
	runError = error instanceof Error ? error.message : String(error);
}
// Let the tool's continuation run.
for (let turn = 0; turn < 3; turn++) {
	const next = Promise.withResolvers();
	setImmediate(next.resolve);
	await next.promise;
}
const tabAlive = getTabsMapForTest().has(name);
process.stdout.write("CONTROL-WRITE-OUTSIDE-ANY-RUN\\n");
process.stderr.write("SUMMARY " + JSON.stringify({ mode, runError, abortReason, tabAlive }) + "\\n");
await releaseTab(name, { kill: false }).catch(() => undefined);
process.exit(0);
`;

test.skipIf(!CHROMIUM_AVAILABLE)(
	"a killed inline tab's pending host tool call is aborted, and its host write after the abort reaches stdout",
	async () => {
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
		const summary = JSON.parse(
			stderr
				.split("\n")
				.find(line => line.startsWith("SUMMARY "))
				?.slice("SUMMARY ".length) ?? "null",
		);
		expect(summary?.mode, stderr).toBe("inline");
		expect(summary?.runError).toMatch(/Browser code execution (timed out after 500ms|hung past grace)/);
		expect(summary?.abortReason).toContain("tab killed");
		expect(summary?.tabAlive).toBe(false);
		// The control write shows the probe can see stdout; the host write after the kill reaches it, first.
		const lines = stdout.split("\n").filter(line => line.startsWith("HOST-") || line.startsWith("CONTROL-"));
		expect(lines).toEqual(["HOST-WRITE-AFTER-KILL", "CONTROL-WRITE-OUTSIDE-ANY-RUN"]);
	},
	120_000,
);
