/**
 * `afterOthers` cleanup callbacks start only once every other callback of the
 * same pass has settled, resolved or rejected, under the pass's one deadline;
 * one with a `deadlineMs` of its own then holds the pass open for up to that
 * bound, also past the 10 s deadline when a peer's `deadlineMs` held the pass
 * open that long, while one without gets no time past that deadline, and
 * neither starts while a peer hangs. A `waitMessage` hold is announced without
 * waiting for `afterOthers` callbacks. Each case runs in a process of its own,
 * since postmortem's state is process-wide. The rows past the deadline wait for
 * postmortem's real 10 s deadline on purpose: a signal exit ends the process
 * from a timer, which a fake clock in the child would not reach.
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const postmortemModuleUrl = pathToFileURL(join(import.meta.dir, "../src/index.ts")).href;

/** Run `source` with postmortem's process handlers installed; its exit code and output. */
async function runProbe(source: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-postmortem-after-others-"));
	const probePath = join(root, "probe.ts");
	try {
		await Bun.write(
			probePath,
			`import { postmortem } from "${postmortemModuleUrl}";\npostmortem.installProcessHandlers();\n${source}`,
		);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_AGENT_DIR: join(root, "agent") },
		});
		// A regression can hang the child; the watchdog bounds it without slowing green runs.
		const watchdog = Bun.sleep(20_000).then(() => {
			proc.kill("SIGKILL");
			return -999;
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			Promise.race([proc.exited, watchdog]),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The JSON array the probe prints on its last `ORDER ` line. */
function orderOf(stdout: string): unknown {
	const line = stdout.split("\n").findLast(row => row.startsWith("ORDER "));
	return line ? JSON.parse(line.slice("ORDER ".length)) : undefined;
}

/**
 * Run `source` (postmortem's handlers not installed) with its stdin open; once its stderr shows `pattern`, or it
 * exits first, write `go` to its stdin. Its exit code, stderr and the match.
 */
async function runUntilShown(source: string, pattern: RegExp) {
	const root = await mkdtemp(join(tmpdir(), "omp-postmortem-after-others-"));
	const probePath = join(root, "probe.ts");
	try {
		await Bun.write(probePath, `import { postmortem } from "${postmortemModuleUrl}";\n${source}`);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, OMP_AGENT_DIR: join(root, "agent") },
		});
		const watchdog = setTimeout(() => proc.kill("SIGKILL"), 40_000);
		let stderr = "";
		const shown = Promise.withResolvers<void>();
		const reading = (async () => {
			for await (const chunk of proc.stderr) {
				stderr += new TextDecoder().decode(chunk);
				if (pattern.test(stderr)) shown.resolve();
			}
		})();
		await Promise.race([shown.promise, proc.exited]);
		proc.stdin.write("go\n");
		proc.stdin.end();
		const [exitCode] = await Promise.all([proc.exited, reading, new Response(proc.stdout).text()]);
		clearTimeout(watchdog);
		return { exitCode, stderr, match: pattern.exec(stderr) };
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("postmortem afterOthers callbacks", () => {
	it("start only after every other callback of the pass has settled, whatever the registration order", async () => {
		const result = await runProbe(`
			const order = [];
			const tick = () => new Promise(resolve => setTimeout(resolve, 20));
			// Registered first and last: neither position lets it start before the others settle.
			postmortem.register("last-a", async () => { order.push("last-a start"); }, { afterOthers: true });
			postmortem.register("slow", async () => { order.push("slow start"); await tick(); order.push("slow end"); });
			postmortem.register("sync", () => { order.push("sync"); });
			postmortem.register("last-b", async () => { order.push("last-b start"); }, { afterOthers: true });
			await postmortem.cleanup();
			console.log("ORDER " + JSON.stringify(order));
		`);
		expect(result.exitCode).toBe(0);
		expect(orderOf(result.stdout)).toEqual(["sync", "slow start", "slow end", "last-b start", "last-a start"]);
	});

	it("start after a peer that rejects, and the pass still reports that peer's failure", async () => {
		const result = await runProbe(`
			const order = [];
			postmortem.register("last", () => { order.push("last"); }, { afterOthers: true });
			postmortem.register("rejects", async () => {
				await new Promise(resolve => setTimeout(resolve, 20));
				order.push("rejects");
				throw new Error("peer failed");
			});
			await postmortem.cleanup();
			console.log("ORDER " + JSON.stringify(order));
		`);
		expect(result.exitCode).toBe(0);
		expect(orderOf(result.stdout)).toEqual(["rejects", "last"]);
	});

	it("never start while a peer hangs, and the pass ends at the deadline without them", async () => {
		const result = await runProbe(`
			import { vi } from "bun:test";
			vi.useFakeTimers();
			const order = [];
			postmortem.register("last", () => { order.push("last"); }, { afterOthers: true });
			postmortem.register("hangs", () => Promise.withResolvers().promise);
			let settled = false;
			const pass = postmortem.cleanup().then(() => { settled = true; });
			await Promise.resolve();
			vi.advanceTimersByTime(9999);
			await Promise.resolve();
			order.push(settled ? "settled early" : "pending at 9999 ms");
			vi.advanceTimersByTime(1);
			await pass;
			order.push(settled ? "settled at the deadline" : "still pending");
			console.log("ORDER " + JSON.stringify(order));
		`);
		expect(result.exitCode).toBe(0);
		expect(orderOf(result.stdout)).toEqual(["pending at 9999 ms", "settled at the deadline"]);
	});

	it("never start while a peer hangs, also with a deadlineMs of their own", async () => {
		const result = await runProbe(`
			import { vi } from "bun:test";
			vi.useFakeTimers();
			const order = [];
			postmortem.register("last", () => { order.push("last"); }, { afterOthers: true, deadlineMs: 2000 });
			postmortem.register("hangs", () => Promise.withResolvers().promise);
			let settled = false;
			const pass = postmortem.cleanup().then(() => { settled = true; });
			await Promise.resolve();
			vi.advanceTimersByTime(9999);
			await Promise.resolve();
			order.push(settled ? "settled early" : "pending at 9999 ms");
			vi.advanceTimersByTime(1);
			await pass;
			order.push(settled ? "settled at the deadline" : "still pending");
			console.log("ORDER " + JSON.stringify(order));
		`);
		expect(result.exitCode).toBe(0);
		expect(orderOf(result.stdout)).toEqual(["pending at 9999 ms", "settled at the deadline"]);
	});

	it("do not run once cancelled, even when cancelled while the others are still running", async () => {
		const result = await runProbe(`
			const order = [];
			let cancelLast;
			cancelLast = postmortem.register("last", () => { order.push("last"); }, { afterOthers: true });
			postmortem.register("cancels", async () => {
				order.push("cancels");
				cancelLast();
				await new Promise(resolve => setTimeout(resolve, 20));
			});
			await postmortem.cleanup();
			const cancelledFirst = postmortem.register("cancelled first", () => { order.push("cancelled first"); }, { afterOthers: true });
			cancelledFirst();
			await postmortem.cleanup();
			console.log("ORDER " + JSON.stringify(order));
		`);
		expect(result.exitCode).toBe(0);
		expect(orderOf(result.stdout)).toEqual(["cancels", "cancels"]);
	});

	it("run on a real exit by SIGTERM after the others, also when exit-only", async () => {
		const result = await runProbe(`
			import * as fs from "node:fs";
			// A signal exit fires no "exit" event: each callback prints the order so far itself.
			const order = [];
			const print = () => fs.writeSync(1, "ORDER " + JSON.stringify(order) + "\\n");
			postmortem.register("last", async () => { order.push("last"); print(); }, { afterOthers: true, exitOnly: true });
			postmortem.register("teardown", async () => {
				await new Promise(resolve => setTimeout(resolve, 50));
				order.push("teardown");
				print();
			});
			setInterval(() => {}, 1000);
			process.kill(process.pid, "SIGTERM");
		`);
		expect(result.exitCode).toBe(143);
		expect(orderOf(result.stdout)).toEqual(["teardown", "last"]);
	});

	it("with a deadlineMs of their own, start once a peer that held the pass past the deadline settles, and finish", async () => {
		const result = await runProbe(`
			import * as fs from "node:fs";
			// A signal exit fires no "exit" event: each callback prints the order so far itself.
			const order = [];
			const print = () => fs.writeSync(1, "ORDER " + JSON.stringify(order) + "\\n");
			postmortem.register("last", async () => {
				order.push("last start");
				print();
				await new Promise(resolve => setTimeout(resolve, 300));
				order.push("last end");
				print();
			}, { afterOthers: true, exitOnly: true, deadlineMs: 2000 });
			postmortem.register("long", async () => {
				await new Promise(resolve => setTimeout(resolve, 10_500));
				order.push("long end");
				print();
			}, { deadlineMs: 20_000 });
			setInterval(() => {}, 1000);
			process.kill(process.pid, "SIGTERM");
		`);
		expect({ exitCode: result.exitCode, order: orderOf(result.stdout) }).toEqual({
			exitCode: 143,
			order: ["long end", "last start", "last end"],
		});
	}, 30_000);

	it("without a deadlineMs of their own, start once such a peer settles but get no time: the pass ends at once", async () => {
		// The control for the row above: the same peer, the same 300 ms of work, no bound of its own. The pass is past
		// its 10 s deadline when the peer settles, so it ends on the next turn and the work is cut.
		const result = await runProbe(`
			import * as fs from "node:fs";
			const order = [];
			const print = () => fs.writeSync(1, "ORDER " + JSON.stringify(order) + "\\n");
			postmortem.register("last", async () => {
				order.push("last start");
				print();
				await new Promise(resolve => setTimeout(resolve, 300));
				order.push("last end");
				print();
			}, { afterOthers: true, exitOnly: true });
			postmortem.register("long", async () => {
				await new Promise(resolve => setTimeout(resolve, 10_500));
				order.push("long end");
				print();
			}, { deadlineMs: 20_000 });
			setInterval(() => {}, 1000);
			process.kill(process.pid, "SIGTERM");
		`);
		expect({ exitCode: result.exitCode, order: orderOf(result.stdout) }).toEqual({
			exitCode: 143,
			order: ["long end", "last start"],
		});
	}, 30_000);

	it("with a deadlineMs of their own that they overrun after such a peer, end the pass at that bound", async () => {
		const result = await runProbe(`
			import * as fs from "node:fs";
			const order = [];
			const print = () => fs.writeSync(1, "ORDER " + JSON.stringify(order) + "\\n");
			postmortem.register("last", async () => {
				order.push("last start");
				print();
				await new Promise(() => {});
			}, { afterOthers: true, exitOnly: true, deadlineMs: 1000 });
			postmortem.register("long", async () => {
				await new Promise(resolve => setTimeout(resolve, 10_500));
				order.push("long end");
				print();
			}, { deadlineMs: 20_000 });
			setInterval(() => {}, 1000);
			process.kill(process.pid, "SIGTERM");
		`);
		// The runner's watchdog turns a pass that never ends into exit -999.
		expect({ exitCode: result.exitCode, order: orderOf(result.stdout) }).toEqual({
			exitCode: 143,
			order: ["long end", "last start"],
		});
	}, 30_000);

	it("registered while a pass runs, start once that pass's other callbacks have settled", async () => {
		const result = await runProbe(`
			const order = [];
			postmortem.register("slow", async () => {
				postmortem.register("late last", () => { order.push("late last"); }, { afterOthers: true });
				order.push("slow start");
				await new Promise(resolve => setTimeout(resolve, 20));
				order.push("slow end");
			});
			await postmortem.cleanup();
			console.log("ORDER " + JSON.stringify(order));
		`);
		expect(result.exitCode).toBe(0);
		expect(orderOf(result.stdout)).toEqual(["slow start", "slow end", "late last"]);
	});
});

describe("postmortem waitMessage beside afterOthers callbacks", () => {
	/** The hold's wait line and the remaining wait it names, up to 15 s: 15 at once, 5 at the 10 s base deadline. */
	const WAIT_LINE = /LOGIN-REFRESH-WAIT \(up to (\d+) s\)/;

	it("is printed once the other callbacks finish, not held back by an afterOthers callback that waits for the hold", async () => {
		// The hold ends only when the test writes to stdin, which it does once the line shows: a line held back until
		// the base deadline names 5 s left, one printed at once names more.
		const result = await runUntilShown(
			`
			const go = new Promise(resolve => process.stdin.once("data", resolve));
			postmortem.register("quick", () => {});
			postmortem.register("refresh", () => go, { deadlineMs: 15_000, waitMessage: "LOGIN-REFRESH-WAIT" });
			postmortem.register("leases", () => {}, { afterOthers: true });
			await postmortem.cleanup();
			process.exit(0);
		`,
			WAIT_LINE,
		);
		const secondsLeft = result.match ? Number(result.match[1]) : undefined;
		expect({
			exitCode: result.exitCode,
			shown: secondsLeft !== undefined,
			beforeBaseDeadline: (secondsLeft ?? 0) > 5,
		}).toEqual({ exitCode: 0, shown: true, beforeBaseDeadline: true });
	}, 45_000);

	it("is printed before a 4 s hold ends, with an afterOthers callback registered", async () => {
		const result = await runProbe(`
			import * as fs from "node:fs";
			postmortem.register("quick", () => {});
			postmortem.register("refresh", async () => {
				await new Promise(resolve => setTimeout(resolve, 4000));
				fs.writeSync(2, "HOLD-END\\n");
			}, { deadlineMs: 15_000, waitMessage: "LOGIN-REFRESH-WAIT" });
			postmortem.register("leases", () => {}, { afterOthers: true });
			await postmortem.cleanup();
		`);
		const line = result.stderr.search(WAIT_LINE);
		const end = result.stderr.indexOf("HOLD-END");
		expect({ exitCode: result.exitCode, shown: line >= 0, beforeHoldEnd: line >= 0 && line < end }).toEqual({
			exitCode: 0,
			shown: true,
			beforeHoldEnd: true,
		});
	}, 30_000);
});
