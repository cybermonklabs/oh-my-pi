import { afterEach, describe, expect, it } from "bun:test";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { cfgDisplayReduceMotion } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	resetSettingsForTest();
});

describe("reduce motion", () => {
	it("defaults to off and freezes every Theme spinner accessor to one memoized frame when enabled", async () => {
		const settings = await Settings.init({ inMemory: true });
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const sourceFrames = theme!.getSpinnerFrames("status");
		expect(cfgDisplayReduceMotion.get(settings)).toBe("off");
		expect(sourceFrames.length).toBeGreaterThan(1);

		cfgDisplayReduceMotion.override(settings, "on");
		const frozenFrames = theme!.getSpinnerFrames("status");
		expect(frozenFrames).toEqual([sourceFrames[0]]);
		expect(theme!.getSpinnerFrames("status")).toBe(frozenFrames);
	});

	it("makes --reduce-motion override the configured level for only the launched session", async () => {
		using tempDir = TempDir.createSync("@omp-reduce-motion-");
		const authStorage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ "display.reduceMotion": "strict" });
		const parsed = parseArgs(["--reduce-motion", "on", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();
		let observedOptions: CreateAgentSessionOptions | undefined;

		try {
			await runRootCommand(parsed, ["--reduce-motion", "on", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			authStorage.close();
		}

		expect(observedOptions).toBeDefined();
		expect(cfgDisplayReduceMotion.get(settings)).toBe("on");
	});
});
