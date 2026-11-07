/**
 * A Python eval kernel takes its environment from the shell config when it starts.
 * Variables an extension exports, and `eval.envPassthrough` admits, reach the kernel,
 * and a kernel started after a shell-config refresh (as after a session switch) sees the
 * refreshed values rather than the ones the first availability probe captured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executePythonWithKernel } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { PythonKernel } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import * as piUtils from "@oh-my-pi/pi-utils";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { __resetShellConfigCacheForTests, refreshShellConfigCache } from "@oh-my-pi/pi-utils/procmgr";

const PYTHON = Bun.env.PYTHON ?? $which("python3") ?? $which("python");
const KEYS = ["DISPATCH_HOST", "DISPATCH_SESSION_ID", "DISPATCH_URL", "ENVOY_CONFIG_FILE"] as const;
const SAVED_KEYS = [...KEYS, "PI_PYTHON_SKIP_CHECK"] as const;
const READ_KEYS = `import json, os; print(json.dumps({key: os.environ.get(key) for key in ${JSON.stringify(KEYS)}}))`;

describe.skipIf(!PYTHON)("Python kernel environment from the shell config", () => {
	let tempDir: TempDir;
	let saved: Record<string, string | undefined> = {};

	beforeEach(async () => {
		tempDir = TempDir.createSync("@python-kernel-shell-env-");
		saved = Object.fromEntries(SAVED_KEYS.map(key => [key, process.env[key]]));
		// Run the real availability probe: its cached result is what a later kernel start reuses.
		delete process.env.PI_PYTHON_SKIP_CHECK;
		vi.spyOn(piUtils, "isBunTestRuntime").mockReturnValue(false);
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "eval.envPassthrough": { prefixes: ["DISPATCH_", "ENVOY_"] } },
		});
		process.env.DISPATCH_HOST = "omp";
		process.env.DISPATCH_SESSION_ID = "ses_first";
		process.env.DISPATCH_URL = "https://dispatch.internal.example";
		process.env.ENVOY_CONFIG_FILE = tempDir.join("envoy.json");
		refreshShellConfigCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const key of SAVED_KEYS) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetShellConfigCacheForTests();
		resetSettingsForTest();
		tempDir.removeSync();
	});

	async function readKernelEnv(): Promise<Record<string, string | null>> {
		const kernel = await PythonKernel.start({ cwd: tempDir.path(), interpreter: PYTHON ?? undefined });
		try {
			const result = await executePythonWithKernel(kernel, READ_KEYS);
			expect(result.exitCode).toBe(0);
			return JSON.parse(result.output.trim());
		} finally {
			await kernel.shutdown();
		}
	}

	it("passes the Dispatch and Envoy variables the shell config carries", async () => {
		expect(await readKernelEnv()).toEqual({
			DISPATCH_HOST: "omp",
			DISPATCH_SESSION_ID: "ses_first",
			DISPATCH_URL: "https://dispatch.internal.example",
			ENVOY_CONFIG_FILE: tempDir.join("envoy.json"),
		});
	}, 30_000);

	it("gives a kernel started after a shell-config refresh the refreshed session id", async () => {
		expect((await readKernelEnv()).DISPATCH_SESSION_ID).toBe("ses_first");

		// A session switch: the extension exports the new id and the runner refreshes the shell config.
		process.env.DISPATCH_SESSION_ID = "ses_second";
		refreshShellConfigCache();

		expect((await readKernelEnv()).DISPATCH_SESSION_ID).toBe("ses_second");
	}, 30_000);
});
