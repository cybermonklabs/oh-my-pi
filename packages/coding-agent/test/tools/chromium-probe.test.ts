import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { chromiumCdpAvailable, chromiumDevToolsListening } from "./chromium-probe";

// The same executable the gate probes; none resolving is the one reason to skip the real-browser case.
const REAL_EXECUTABLE = process.platform === "linux" ? await ensureChromiumExecutable() : undefined;

// What the browser suites' gate decides: skip only on evidence the browser cannot run here.
describe("chromium probe", () => {
	let dir = "";

	async function fakeExecutable(name: string, script: string): Promise<string> {
		const file = path.join(dir, name);
		await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
		return file;
	}

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-chromium-probe-test-"));
	});

	afterAll(async () => {
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")(
		"counts a browser that is still starting when the wait runs out as available",
		async () => {
			// Stays alive without ever answering CDP, as Chrome does on a host too loaded to start it in time.
			const starting = await fakeExecutable("starting-browser", "exec sleep 30");
			expect(await chromiumCdpAvailable(starting, 300)).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")(
		"counts a browser that exits before CDP answers as unavailable",
		async () => {
			// Chrome's exit when a system library such as libnspr4 is missing.
			const missingLibrary = await fakeExecutable("missing-library", "exit 127");
			expect(await chromiumCdpAvailable(missingLibrary, 300)).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")("counts an executable that cannot be spawned as unavailable", async () => {
		expect(await chromiumCdpAvailable(path.join(dir, "no-such-browser"), 300)).toBe(false);
	});

	it.skipIf(!REAL_EXECUTABLE)(
		"counts this host's Chromium as available",
		async () => {
			expect(await chromiumCdpAvailable(REAL_EXECUTABLE ?? "")).toBe(true);
		},
		30_000,
	);
});

// The wait a test makes for a Chromium it launched: Chromium's own report, or its exit.
describe.skipIf(process.platform === "win32")("chromium DevTools listening", () => {
	it("resolves with the endpoint once Chromium reports it is listening", async () => {
		const child = Bun.spawn(
			["/bin/sh", "-c", 'echo "DevTools listening on ws://127.0.0.1:9/devtools/browser/x" >&2; exec sleep 30'],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		try {
			expect(await chromiumDevToolsListening(child)).toBe("ws://127.0.0.1:9/devtools/browser/x");
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	it("rejects with what Chromium printed when it exits first", async () => {
		const child = Bun.spawn(
			["/bin/sh", "-c", 'echo "error while loading shared libraries: libnspr4.so" >&2; exit 127'],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		const error = await chromiumDevToolsListening(child).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(String(error)).toContain("exited (code 127) before its DevTools endpoint was listening");
		expect(String(error)).toContain("libnspr4.so");
	});
});
