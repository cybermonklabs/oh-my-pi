import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

/**
 * Whether the Chromium puppeteer resolves can actually execute on this host.
 * CI runners without Chrome's system libraries (libnspr4 & co.) hold the
 * downloaded binary but cannot exec it. A wrapper can also print a version
 * without starting Chrome, so Linux requires a live headless CDP endpoint.
 */
async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		// Only Linux runs the exec probe. Elsewhere the resolved candidate is a
		// GUI application path, and running it is the hazard
		// `isChromiumExecutable()` already refuses for the same reason (#8445): a
		// GUI `chrome.exe --version` prints nothing to a detached stdout and does
		// not exit, so this spawnSync never returns and every importing suite
		// hangs during module evaluation. Check the file instead, so a stale
		// PUPPETEER_EXECUTABLE_PATH — which `ensureChromiumExecutable()` hands
		// back unvalidated — still skips the suites rather than failing them at
		// launch.
		if (process.platform !== "linux") return (await fs.stat(executable)).isFile();
		return await chromiumCdpAvailable(executable);
	} catch {
		return false;
	}
}

/**
 * Whether a disposable headless launch of `executable` can run on this host. Only evidence that it cannot
 * skips the browser suites: the spawn fails, or Chrome exits before its CDP endpoint answers (code 127 for a
 * missing libnspr4, or a wrapper that prints a version without starting Chrome). An exit ends the wait at once:
 * polling on would let a concurrent test server that grabs the freed port answer `/json/version` with 200 and
 * pass the probe falsely.
 *
 * A wait that runs out while the launched browser is still running is no such evidence: a loaded host starts
 * Chrome slowly, and skipping then would read as a pass. It counts as available, so the suites run and fail
 * for real if the browser is broken.
 */
export async function chromiumCdpAvailable(executable: string, timeoutMs = 5000): Promise<boolean> {
	const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-chromium-probe-"));
	let child: ChildProcess | undefined;
	try {
		const port = await findFreeCdpPort();
		child = ptree.spawn(
			[
				executable,
				"--headless=new",
				"--no-sandbox",
				"--no-first-run",
				"--no-default-browser-check",
				`--user-data-dir=${userDataDir}`,
				`--remote-debugging-port=${port}`,
				"about:blank",
			],
			{ stdin: "ignore", detached: true, subreaper: true },
		);
		const exited = new AbortController();
		child.exited.then(
			() => exited.abort(),
			() => exited.abort(),
		);
		try {
			await waitForCdp(`http://127.0.0.1:${port}`, timeoutMs, exited.signal);
		} catch {
			// The wait ends on Chrome's exit or on running out; only the exit says Chrome cannot run here.
			return !exited.signal.aborted && child.exitCode === null;
		}
		return true;
	} catch {
		return false;
	} finally {
		if (child) {
			child.kill(undefined, -1);
			await child.wait({ allowAbort: true, allowNonZero: true });
		}
		await fs.rm(userDataDir, { recursive: true, force: true });
	}
}

/**
 * Launch arguments for every test Chromium: `--no-sandbox`, as {@link chromiumCdpAvailable}
 * probes and omp's own headless launches run. A host that forbids unprivileged user namespaces
 * (Ubuntu 23.10+ AppArmor) cannot start Chrome's sandbox, so the probe passes and a sandboxed
 * launch then dies with "No usable sandbox!".
 */
export const TEST_CHROMIUM_ARGS = ["--no-sandbox"];

/**
 * Wait until a Chromium a test launched with `--remote-debugging-port` (and `stderr: "pipe"`) answers CDP. The event
 * is the `DevTools listening on ws://…` line Chromium prints on stderr once that endpoint accepts connections; it
 * resolves with that WebSocket URL. Chromium exiting first rejects, with what it printed. There is no time limit of
 * its own: the test's timeout bounds a launch that never gets there. Stderr is read to its end, so Chromium never
 * blocks on a full pipe.
 */
export async function chromiumDevToolsListening(child: {
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
}): Promise<string> {
	const listening = Promise.withResolvers<string>();
	void (async () => {
		const decoder = new TextDecoder();
		let printed = "";
		let found = false;
		for await (const chunk of child.stderr) {
			if (found) continue;
			printed += decoder.decode(chunk, { stream: true });
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(printed);
			if (match?.[1]) {
				found = true;
				listening.resolve(match[1]);
			}
		}
		if (found) return;
		const code = await child.exited;
		listening.reject(
			new Error(
				`Chromium exited (code ${code}) before its DevTools endpoint was listening:\n${printed.slice(-2_000)}`,
			),
		);
	})().catch(error => listening.reject(error));
	return await listening.promise;
}

let probe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a real Chromium:
 *
 *     const CHROMIUM_AVAILABLE = await chromiumAvailable();
 *     describe.skipIf(!CHROMIUM_AVAILABLE)(…);
 *
 * The result is a promise rather than an awaited `export const`. A module whose
 * exports are initialized by top-level await hands the test runner a binding
 * that is still in its temporal dead zone when a second test file in the same
 * process imports it, and that file dies during registration with "Cannot
 * access 'CHROMIUM_AVAILABLE' before initialization". Awaiting in the importer
 * makes the wait part of that file's own evaluation, which the runner does
 * sequence. The probe runs once per process.
 */
export function chromiumAvailable(): Promise<boolean> {
	probe ??= chromiumCanLaunch();
	return probe;
}

let visibleProbe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a *headful* Chromium (`headless: false`).
 *
 * `chromiumAvailable()` checks a headless launch on Linux, which needs no
 * display and cannot gate a headful launch. On a
 * GH-hosted ubuntu runner there is no X server and no xvfb in the workflow,
 * so `puppeteer.launch({ headless: false })` throws "Missing X server or
 * $DISPLAY" and the suite fails rather than skipping. Require a display on
 * Linux; macOS and Windows launch headful without one.
 *
 * Same promise-not-awaited-const shape as `chromiumAvailable()`, for the same
 * temporal-dead-zone reason.
 */
export function visibleBrowserAvailable(): Promise<boolean> {
	visibleProbe ??= (async () => {
		if (!(await chromiumAvailable())) return false;
		if (process.platform !== "linux") return true;
		return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	})();
	return visibleProbe;
}
