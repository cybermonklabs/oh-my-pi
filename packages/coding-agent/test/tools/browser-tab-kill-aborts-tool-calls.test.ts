/**
 * A browser run's code can call a session tool, which the supervisor runs on the host. When the run's tab is torn down
 * under it, that host call must be aborted: left running, it has no one to answer, or its reply goes to a new worker
 * that never had the run. A release and a worker exit already abort it; these cases cover a kill (an inline tab whose
 * run timed out) and the recycle the supervisor runs on a Worker-backed tab (as after a run timed out).
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	recycleTimedOutWorkerTabForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/** A session tool whose call stays in flight until it is aborted; it records the abort's reason. */
function pendingTool(): { tool: AgentTool; started: Promise<void>; abortReason: () => unknown } {
	const started = Promise.withResolvers<void>();
	let reason: unknown;
	return {
		started: started.promise,
		abortReason: () => reason,
		tool: {
			name: "pending_probe",
			label: "pending_probe",
			description: "Stays in flight until aborted",
			parameters: type({}),
			async execute(_id, _args, signal) {
				const result = Promise.withResolvers<AgentToolResult>();
				const onAbort = (): void => {
					reason = signal?.reason;
					result.reject(signal?.reason);
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				started.resolve();
				try {
					return await result.promise;
				} finally {
					signal?.removeEventListener("abort", onAbort);
				}
			},
		},
	};
}

function makeSession(tool: AgentTool): ToolSession {
	return {
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
}

/** Each tab worker the supervisor spawns falls back to the inline worker in omp's realm. */
function refuseWorkers(): void {
	// The `Worker` class seen as a plain function, so the spy can throw in its place.
	const workerGlobal = globalThis as unknown as { Worker: () => never };
	spyOn(workerGlobal, "Worker").mockImplementation(() => {
		throw new Error("this test refuses tab Workers, so tabs use the inline worker");
	});
}

/** Open a tab and run once in it, so the timed-out run below does not also load the compiler in the tab's realm. */
async function openWarmTab(name: string, mode: "inline" | "worker", session: ToolSession): Promise<void> {
	const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: os.tmpdir() });
	const { tab } = await acquireTab(name, browser, { timeoutMs: 30_000 });
	if (tab.backend !== "worker") throw new Error(`expected a Puppeteer tab, got ${tab.backend}`);
	expect(tab.worker.mode).toBe(mode);
	// A first run loads the compiler synchronously in the worker's realm, which can hold the worker's own
	// timeout past the supervisor's grace; the run under test must reach the worker's timeout, not the grace kill.
	expect((await runInTab(name, { code: "1 + 1;", timeoutMs: 30_000, session })).returnValue).toBe(2);
}

afterEach(async () => {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) await releaseTab(name, { kill: false }).catch(() => undefined);
	vi.restoreAllMocks();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a torn-down tab aborts the host tool calls its run started", () => {
	it("aborts them when a timed-out run gets its inline tab killed", async () => {
		refuseWorkers();
		const probe = pendingTool();
		const session = makeSession(probe.tool);
		const name = "kill-aborts-tool-call";
		await openWarmTab(name, "inline", session);
		const run = runInTab(name, { code: "await tool.pending_probe({});", timeoutMs: 500, session });
		await probe.started;
		// The supervisor kills an inline tab whose run timed out, or one whose answer outlasted the grace; either kill
		// must reach the call the run left behind.
		await expect(run).rejects.toThrow(/Browser code execution (timed out after 500ms|hung past grace)/);
		expect(getTabsMapForTest().has(name)).toBe(false);
		expect(probe.abortReason()).toBeInstanceOf(ToolError);
		expect((probe.abortReason() as Error).message).toContain("tab killed");
	}, 120_000);

	it("aborts them when the supervisor recycles a tab's Worker", async () => {
		const probe = pendingTool();
		const session = makeSession(probe.tool);
		const name = "recycle-aborts-tool-call";
		await openWarmTab(name, "worker", session);
		const run = runInTab(name, { code: "await tool.pending_probe({});", timeoutMs: 60_000, session });
		run.catch(() => undefined);
		await probe.started;
		// Under the Bun test runner a Worker's own run timeout cannot be relied on to fire (raceWithTimeout's comment),
		// so the test runs the recycle the supervisor runs once that timeout has answered.
		expect(await recycleTimedOutWorkerTabForTest(name, 30_000)).toBe(true);
		// The tab stays, with a new worker; the call the replaced worker's run left behind must not.
		expect(getTabsMapForTest().has(name)).toBe(true);
		expect(probe.abortReason()).toBeInstanceOf(ToolError);
		expect((probe.abortReason() as Error).message).toContain("tab worker was replaced");
		expect(await releaseTab(name, { kill: false })).toBe(true);
		await expect(run).rejects.toThrow(`Tab "${name}" was closed`);
	}, 120_000);
});
