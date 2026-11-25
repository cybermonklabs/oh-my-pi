/**
 * A Puppeteer tab on the inline tab worker runs its code in omp's own realm, like a cmux or Tern tab. A run that
 * times out with its code still pending must give the realm back, or every later runtime in the process fails
 * with "another same-realm JS runtime is running".
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { JsRuntime } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
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

async function openInlineTab(name: string): Promise<void> {
	const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: os.tmpdir() });
	const { tab } = await acquireTab(name, browser, { timeoutMs: 30_000 });
	if (tab.backend !== "worker") throw new Error(`expected a Puppeteer tab, got ${tab.backend}`);
	expect(tab.worker.mode).toBe("inline");
}

afterEach(async () => {
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) await releaseTab(name, { kill: false }).catch(() => undefined);
	vi.restoreAllMocks();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("an inline tab worker's run that never settles", () => {
	it("gives the realm back when it times out, so the next tab runs", async () => {
		refuseWorkers();
		const session = makeSession();
		await openInlineTab("inline-stuck");
		await expect(
			runInTab("inline-stuck", { code: "await new Promise(() => {});", timeoutMs: 300, session }),
		).rejects.toThrow("Browser code execution timed out after 300ms");

		// Another runtime in this realm can start: the stuck run's runtime was discarded.
		let probe: JsRuntime | undefined;
		try {
			probe = new JsRuntime({ initialCwd: os.tmpdir(), sessionId: "after-inline-timeout" });
		} finally {
			probe?.dispose();
		}
		await openInlineTab("inline-next");
		expect((await runInTab("inline-next", { code: "1 + 1;", timeoutMs: 30_000, session })).returnValue).toBe(2);
	}, 120_000);
});
