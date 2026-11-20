import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigDirName, getPythonGatewayDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

describe("python gateway directory", () => {
	let tempRoot = "";
	let originalAgentDir = "";
	let originalEnv: Record<string, string | undefined> = {};
	let homedirSpy: Mock<typeof os.homedir> | undefined;
	const envKeys = ["PI_CONFIG_DIR", "XDG_STATE_HOME", "OMP_CONFIG_ROOT", "OMP_DOWNLOAD_ROOT"];

	beforeEach(async () => {
		originalAgentDir = getAgentDir();
		originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
		tempRoot = path.join(os.tmpdir(), "pi-utils-python-gateway", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
		// The config root is `<home>/<configDir>`: a home of this test's own, not the one
		// the test process runs in (whose root the preload replaced).
		homedirSpy = spyOn(os, "homedir").mockReturnValue(path.join(tempRoot, "home"));
		delete process.env.OMP_CONFIG_ROOT;
		delete process.env.OMP_DOWNLOAD_ROOT;
	});

	afterEach(async () => {
		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		homedirSpy?.mockRestore();
		setAgentDir(originalAgentDir);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG state for the default agent profile", async () => {
		if (process.platform === "win32") return;

		process.env.PI_CONFIG_DIR = `.omp-test-${Snowflake.next()}`;
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "omp"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(process.env.XDG_STATE_HOME, "omp", "python-gateway"));
	});

	it("keeps custom agent profiles isolated from XDG shared state", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, "omp"), { recursive: true });
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(customAgentDir, "python-gateway"));
	});
});
