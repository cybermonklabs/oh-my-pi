/**
 * `gracefulKillTreeOnce` ends a browser omp launched in a process group of its
 * own (puppeteer launches Chromium detached) with its group, so a child that a
 * browser process forks while it is being ended, and that outlives its parent
 * under init, is ended too.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { gracefulKillTreeOnce } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";

/** The live (not zombie) processes of process group `pgid` and their command names. */
function groupMembers(pgid: number): { pid: number; comm: string }[] {
	const members: { pid: number; comm: string }[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let stat: string;
		try {
			stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
		} catch {
			continue;
		}
		const end = stat.lastIndexOf(")");
		const fields = stat.slice(end + 2).split(" ");
		if (Number(fields[2]) !== pgid || fields[0] === "Z" || fields[0] === "X") continue;
		members.push({ pid: Number(entry), comm: stat.slice(stat.indexOf("(") + 1, end) });
	}
	return members;
}

/** Waits up to `ms` for `done`; returns whether it held. */
async function waitFor(done: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() >= deadline) return false;
		await Bun.sleep(5);
	}
	return true;
}

describe.skipIf(process.platform !== "linux")("gracefulKillTreeOnce", () => {
	it("ends the child a browser process forks as it is ended", async () => {
		// A stand-in for a hung browser in a group of its own: a helper that, on
		// TERM, starts a `sleep` and exits, so the sleep outlives it under init,
		// out of the tree any walk from the root can read.
		const browser = Bun.spawn(
			["sh", "-c", "sh -c 'trap \"sleep 1000 & exit\" TERM; while :; do sleep 0.05; done' & wait"],
			{ detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
		);
		const pgid = browser.pid;
		try {
			// The helper has set its trap once it runs its first `sleep 0.05`.
			const ready = await waitFor(() => groupMembers(pgid).some(member => member.comm === "sleep"), 10_000);
			expect(ready).toBe(true);

			await gracefulKillTreeOnce(browser.pid, 500);

			await waitFor(() => groupMembers(pgid).length === 0, 2_000);
			expect(groupMembers(pgid)).toEqual([]);
		} finally {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch {}
		}
	});
});
