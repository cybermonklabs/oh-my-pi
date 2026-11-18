import { afterAll, beforeAll } from "bun:test";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";

/**
 * Launch the headless Chromium a file's `open` calls share (`{ kind: "headless", headless: true }`, no viewport)
 * in a hook of its own, and hold it until the file ends.
 *
 * Without the hold, the browser is released whenever its last tab closes, so each test that opens and closes a
 * tab launches Chromium again, and on a loaded machine that launch alone can use a test's whole timeout. And when
 * the first test's open launches it, bun kills that test's processes if the test times out, Chromium included,
 * which fails every later test with it.
 */
export function holdHeadlessBrowserForFile(available: boolean, cwd: () => string = () => process.cwd()): void {
	let browser: BrowserHandle | undefined;
	beforeAll(async () => {
		if (!available) return;
		browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: cwd() });
		holdBrowser(browser);
	});
	afterAll(async () => {
		if (browser) await releaseBrowser(browser, { kill: true });
		browser = undefined;
	});
}
