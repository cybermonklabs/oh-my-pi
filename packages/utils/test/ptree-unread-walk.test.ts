// A subreaper stop when one walk of the process table could not read every process (with no
// descriptor left the natives' `children()` throws): the stop goes on, and its sweeps read again,
// so a TERM-ignoring descendant in a session of its own still dies. The wait for its end has no
// bound of its own: the test runner's timeout fails a stop that left it running.
import { afterEach, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { spawn } from "@oh-my-pi/pi-utils/ptree";

/** Whether `pid` still runs (a zombie has ended; its pidfd is readable). */
function running(pid: number): boolean {
	return Process.fromPid(pid)?.status() === "running";
}

afterEach(() => {
	vi.restoreAllMocks();
});

it.skipIf(process.platform !== "linux")(
	"a subreaper stop ends a TERM-ignoring descendant of its own session after a walk it could not read",
	async () => {
		using dir = TempDir.createSync("@omp-ptree-unread-walk-");
		const pidfile = path.join(dir.path(), "grandchild.pid");
		const script = `trap '' TERM; setsid sh -c 'trap "" TERM; echo $$ > ${pidfile}; exec /bin/sleep 600' & while [ ! -s ${pidfile} ]; do :; done; echo ready; wait`;
		const child = spawn(["sh", "-c", script], { subreaper: true });
		const reader = child.stdout.getReader();
		await reader.read(); // "ready": the grandchild ignores TERM and leads its own session
		reader.releaseLock();
		const grandchild = Number((await fs.readFile(pidfile, "utf8")).trim());
		expect(running(grandchild)).toBe(true);
		const realChildren = Process.prototype.children;
		let walks = 0;
		spyOn(Process.prototype, "children").mockImplementation(function (this: Process) {
			walks++;
			if (walks === 1) throw new Error("cannot read process: Too many open files (os error 24)");
			return realChildren.call(this);
		});
		try {
			child.kill(undefined, 50);
			await child.exited.catch(() => undefined);
			while (running(grandchild)) await Bun.sleep(20);
			expect(walks).toBeGreaterThan(1);
		} finally {
			vi.restoreAllMocks();
			if (running(grandchild)) process.kill(grandchild, "SIGKILL");
		}
	},
	30_000,
);
