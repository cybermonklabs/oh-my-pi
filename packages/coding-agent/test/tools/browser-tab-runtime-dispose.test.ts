/**
 * A tab whose code runs in omp's own realm (a cmux or Tern tab, or a Puppeteer tab on the inline tab worker) builds
 * a JsRuntime there, and that runtime claims one entry per reserved global in the realm's shared table. The runtime
 * must end with its tab: opening and closing tabs must leave the table as it was, or a long session grows it by one
 * set of entries (and one live runtime) per tab it ever opened.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type GlobalTableSize, globalTableSizeForTest } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
	setAfterInProcessImportForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { setBeforeRunRuntimeForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const CYCLES = 3;
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

/** The table's size before the first cycle and after each one: one tab opened, run and ended per cycle. */
async function sizesAcrossCycles(
	cycle: (index: number) => Promise<void>,
): Promise<{ before: GlobalTableSize; after: GlobalTableSize[] }> {
	const before = globalTableSizeForTest();
	const after: GlobalTableSize[] = [];
	for (let index = 0; index < CYCLES; index++) {
		await cycle(index);
		after.push(globalTableSizeForTest());
	}
	return { before, after };
}

/** A cmux socket that answers every request a tab's open, run and close make, with nothing behind it. */
function mockCmuxSocket(): void {
	spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
	spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
	let surfaces = 0;
	spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
		async (method: string): Promise<Record<string, unknown>> => {
			switch (method) {
				case "browser.open_split":
					surfaces++;
					return { surface_id: `surface-dispose-${surfaces}`, url: "about:blank" };
				case "browser.url.get":
					return { url: "about:blank" };
				case "browser.snapshot":
					return { page: { html: "" } };
				case "browser.eval":
					return { value: "" };
				default:
					return {};
			}
		},
	);
}

let daemon: FakeDaemon | undefined;

afterEach(async () => {
	setAfterInProcessImportForTest(undefined);
	setBeforeRunRuntimeForTest(undefined);
	// oxlint-disable-next-line unicorn/no-useless-spread -- releasing tabs mutates the map
	for (const name of [...getTabsMapForTest().keys()]) await releaseTab(name, { kill: false }).catch(() => undefined);
	await daemon?.close();
	daemon = undefined;
	vi.restoreAllMocks();
});

describe("a dead tab's runtime leaves the realm's global table", () => {
	it("disposes a cmux tab's runtime when the tab is closed", async () => {
		mockCmuxSocket();
		const session = makeSession();
		const sizes = await sizesAcrossCycles(async index => {
			const name = `cmux-dispose-${index}`;
			const browser = await acquireBrowser(
				{ kind: "cmux", socketPath: `/tmp/omp-test-dispose-${index}.sock`, surface: `surface-dispose-${index}` },
				{ cwd: os.tmpdir() },
			);
			expect((await acquireTab(name, browser, { timeoutMs: 5_000 })).tab.backend).toBe("cmux");
			expect((await runInTab(name, { code: "1 + 1;", timeoutMs: 5_000, session })).returnValue).toBe(2);
			expect(await releaseTab(name, { kill: false })).toBe(true);
		});
		expect(sizes.after).toEqual(Array.from({ length: CYCLES }, () => sizes.before));
	});

	it("builds no runtime for a cmux run whose tab is closed while the in-process runner loads", async () => {
		mockCmuxSocket();
		const session = makeSession();
		const name = "cmux-closed-during-import";
		const browser = await acquireBrowser(
			{ kind: "cmux", socketPath: "/tmp/omp-test-dispose-import.sock", surface: "surface-dispose-import" },
			{ cwd: os.tmpdir() },
		);
		expect((await acquireTab(name, browser, { timeoutMs: 5_000 })).tab.backend).toBe("cmux");
		const before = globalTableSizeForTest();
		// The close lands after the runner's import, before the run starts: the window the supervisor's guard closes.
		let closedInWindow = false;
		setAfterInProcessImportForTest(async () => {
			closedInWindow = await releaseTab(name, { kill: false });
		});
		await expect(runInTab(name, { code: "1 + 1;", timeoutMs: 5_000, session })).rejects.toThrow(
			`Tab "${name}" was closed`,
		);
		expect(closedInWindow).toBe(true);
		expect(globalTableSizeForTest()).toEqual(before);
	});

	it("disposes a Tern tab's runtime when the tab is closed", async () => {
		// One window block the tab adopts each cycle, and releases on close.
		const block = {
			block: 5,
			url: "https://docs.example/a",
			title: "Docs A",
			owner: null,
			shown: true,
			driven: false,
		};
		daemon = await startFakeDaemon((op): FakeAnswer => {
			switch (op.op) {
				case "blocks":
					return { ok: { blocks: [block] } };
				case "events":
					return { ok: { events: [], next: 40, dropped: 0 } };
				case "state":
					return {
						ok: { url: block.url, title: block.title, loading: false, shown: true, width: 800, height: 600 },
					};
				case "eval":
					// The kit's `frames`: no child frames.
					return { ok: { value: { value: [] } } };
				default:
					return { ok: {} };
			}
		});
		const fake = daemon;
		const session = makeSession();
		const sizes = await sizesAcrossCycles(async index => {
			const name = `tern-dispose-${index}`;
			const browser = await acquireBrowser(
				{ kind: "tern", socketPath: fake.socketPath, pane: 3 },
				{ cwd: os.tmpdir() },
			);
			expect((await acquireTab(name, browser, { target: "docs", timeoutMs: 5_000 })).tab.backend).toBe("tern");
			expect((await runInTab(name, { code: "1 + 1;", timeoutMs: 5_000, session })).returnValue).toBe(2);
			expect(await releaseTab(name, { kill: false })).toBe(true);
		});
		expect(sizes.after).toEqual(Array.from({ length: CYCLES }, () => sizes.before));
	});

	describe.skipIf(!CHROMIUM_AVAILABLE)("a Puppeteer tab on the inline tab worker", () => {
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

		it("disposes the runtime when the tab is closed", async () => {
			refuseWorkers();
			const session = makeSession();
			const sizes = await sizesAcrossCycles(async index => {
				const name = `inline-close-${index}`;
				await openInlineTab(name);
				expect((await runInTab(name, { code: "1 + 1;", timeoutMs: 30_000, session })).returnValue).toBe(2);
				expect(await releaseTab(name, { kill: false })).toBe(true);
			});
			expect(sizes.after).toEqual(Array.from({ length: CYCLES }, () => sizes.before));
		}, 120_000);

		it("disposes the runtime when a timed-out run gets its tab killed", async () => {
			refuseWorkers();
			const session = makeSession();
			const sizes = await sizesAcrossCycles(async index => {
				const name = `inline-killed-${index}`;
				await openInlineTab(name);
				// `wait` ends with the run's signal, so the code settles once the run times out; the supervisor kills
				// an inline tab whose run timed out.
				await expect(runInTab(name, { code: "await wait(60_000);", timeoutMs: 300, session })).rejects.toThrow(
					"Browser code execution timed out after 300ms",
				);
				expect(getTabsMapForTest().has(name)).toBe(false);
			});
			expect(sizes.after).toEqual(Array.from({ length: CYCLES }, () => sizes.before));
		}, 120_000);

		it("builds no runtime when the core stops before the run builds it", async () => {
			refuseWorkers();
			const session = makeSession();
			const name = "inline-stopped-before-runtime";
			await openInlineTab(name);
			const before = globalTableSizeForTest();
			// The core stops while the run is under way, before it builds the runtime: the window the core's guard closes.
			let stoppedInWindow = false;
			setBeforeRunRuntimeForTest(async core => {
				core.terminate();
				stoppedInWindow = true;
			});
			await expect(runInTab(name, { code: "1 + 1;", timeoutMs: 300, session })).rejects.toThrow();
			expect(stoppedInWindow).toBe(true);
			expect(globalTableSizeForTest()).toEqual(before);
		}, 120_000);
	});
});
