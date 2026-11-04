import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
import { resolveClaudePaths } from "@oh-my-pi/pi-coding-agent/config/claude-paths";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getUserPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { getAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("PI_CONFIG_DIR", () => {
	const original = process.env.PI_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = original;
		}
	});

	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".omp/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs respects PI_CONFIG_DIR for user base", () => {
		process.env.PI_CONFIG_DIR = ".config/omp";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/omp", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".omp", level: "user" });
	});
});

describe("CLAUDE_CONFIG_DIR", () => {
	const original = process.env.CLAUDE_CONFIG_DIR;
	afterEach(() => {
		clearFsCache();
		if (original === undefined) {
			delete process.env.CLAUDE_CONFIG_DIR;
		} else {
			process.env.CLAUDE_CONFIG_DIR = original;
		}
	});

	test("relocates Claude user discovery and .claude.json together", () => {
		process.env.CLAUDE_CONFIG_DIR = "./fixtures/claude-home";
		const expectedRoot = path.resolve("./fixtures/claude-home");
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};

		expect(resolveClaudePaths(ctx.home)).toEqual({
			configDir: expectedRoot,
			configFile: path.join(expectedRoot, ".claude.json"),
		});
		expect(getUserPath(ctx, "claude", "commands")).toBe(path.join(expectedRoot, "commands"));
		expect(
			getConfigDirs("commands", { user: true, project: false }).find(entry => entry.source === ".claude"),
		).toEqual({ path: path.join(expectedRoot, "commands"), source: ".claude", level: "user" });
	});

	test("keeps the legacy split paths when the override is unset", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		expect(resolveClaudePaths("/home/tester")).toEqual({
			configDir: path.join("/home/tester", ".claude"),
			configFile: path.join("/home/tester", ".claude.json"),
		});
	});

	test("reads the .claude.json the file system resolves CLAUDE_CONFIG_DIR to", async () => {
		using tempDir = TempDir.createSync("@pi-claude-config-dir-");
		const base = tempDir.path();
		fs.mkdirSync(path.join(base, "actual", "child"), { recursive: true });
		fs.mkdirSync(path.join(base, "actual", "claude"));
		fs.mkdirSync(path.join(base, "configured", "claude"), { recursive: true });
		fs.mkdirSync(path.join(base, "project"));
		fs.symlinkSync(path.join(base, "actual", "child"), path.join(base, "configured", "link"), "dir");
		const claudeJson = (command: string) => JSON.stringify({ mcpServers: { who: { command, type: "stdio" } } });
		fs.writeFileSync(path.join(base, "actual", "claude", ".claude.json"), claudeJson("actual"));
		fs.writeFileSync(path.join(base, "configured", "claude", ".claude.json"), claudeJson("configured"));
		// `configured/link -> actual/child`: the kernel resolves `configured/link/../claude` to `actual/claude`.
		const configured = `${path.join(base, "configured")}/link/../claude`;
		expect(fs.readFileSync(`${configured}/.claude.json`, "utf8")).toBe(claudeJson("actual"));
		process.env.CLAUDE_CONFIG_DIR = configured;
		clearFsCache();

		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: path.join(base, "project"),
			providers: ["claude"],
		});

		expect(result.items.find(server => server.name === "who")?.command).toBe("actual");
	});
});
