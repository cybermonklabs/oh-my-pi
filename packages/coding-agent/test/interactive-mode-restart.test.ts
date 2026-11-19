import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import * as workerClient from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode restart", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let originalArgv: string[];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-restart-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		originalArgv = process.argv;
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "persona sessions"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.argv = originalArgv;
		await session?.dispose();
		session = undefined;
		await sessionManager.close();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function restart(
		argv: string[],
		options: { execFails?: boolean; beforeRestart?: () => void } = {},
	): Promise<string[]> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = () => {};
		mode.ui.terminal.drainInput = async () => {};
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		// Stop only at the process replacement boundary; teardown and argv production run for real.
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => {
			if (options.execFails) throw new Error("exec failed");
			return undefined as never;
		});
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		vi.spyOn(process.stderr, "write").mockReturnValue(true);
		options.beforeRestart?.();
		await mode.restart();
		const spawned = process.platform === "win32" || options.execFails;
		const command = spawned ? spawn.mock.calls[0]?.[0] : exec.mock.calls[0]?.[0];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command;
	}

	it("resumes an explicitly opened persona journal without rediscovering its ID", async () => {
		sessionManager.appendMessage({ role: "user", content: "initial request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "saved answer" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			timestamp: 2,
		});
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const transcript = sessionManager.buildSessionContext().messages;
		await sessionManager.close();
		sessionManager = await SessionManager.open(file);
		const command = await restart([
			"--session",
			file,
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--append-system-prompt",
			"persona prompt",
			"--skills",
			"/office/skills",
			"-e",
			"/office/extension.ts",
			"--model",
			"openai-codex/gpt-6.1-sol:high",
			"initial request",
		]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("openai-codex/gpt-6.1-sol:high");
		expect(parsed.messages).toEqual([]);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(file);
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual(transcript);
		} finally {
			await resumed.close();
		}
	});

	it("resumes a journal created in a flag-looking relative directory", async () => {
		using relativeDir = TempDir.createSync("-omp-restart-");
		await sessionManager.close();
		sessionManager = SessionManager.create(tempDir.path(), relativeDir.path());
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", `--session-dir=${relativeDir.path()}`]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(file));
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "saved request", timestamp: 1 },
			]);
		} finally {
			await resumed.close();
		}
	});

	it("does not resume a journal that has never materialized", async () => {
		const file = sessionManager.getSessionFile();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", "initial request"]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.resume).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(sessionManager.isSessionOnDisk()).toBe(false);
		if (!file) throw new Error("expected allocated journal path");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	/** A relaunch file as `bunRelaunchArgs` writes it: `<tmp>/omp-bun-env-XXXXXX/loaded.env`, naming itself. */
	async function relaunchFile(): Promise<{ dir: string; file: string }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bun-env-"));
		const file = path.join(dir, "loaded.env");
		await Bun.write(file, `# omp relaunch file: ${file}\nLOADED='value'\n`);
		return { dir, file };
	}

	it("builds the relaunch command, and so its relaunch file, after the cleanups and the stdout drain", async () => {
		const order: string[] = [];
		const { dir, file } = await relaunchFile();
		vi.spyOn(workerClient, "resolveCliEntryCmd").mockImplementation(() => {
			order.push("command");
			return [process.execPath, `--env-file=${file}`, "omp-entry"];
		});
		const cleanup = vi.spyOn(postmortem, "cleanup");
		const drain = vi.spyOn(postmortem, "drainStdout");
		await restart([], {
			beforeRestart: () => {
				cleanup.mockImplementation(async () => void order.push("cleanup"));
				drain.mockImplementation(async () => void order.push("drain"));
			},
		});
		await fs.rm(dir, { recursive: true, force: true });

		expect(order).toEqual(["cleanup", "drain", "command"]);
	});

	it("removes the relaunch file after the replacement it spawned exits", async () => {
		const { dir, file } = await relaunchFile();
		vi.spyOn(workerClient, "resolveCliEntryCmd").mockReturnValue([
			process.execPath,
			`--env-file=${file}`,
			"omp-entry",
		]);
		// The exec fails (as on Windows, where there is none), so the replacement is spawned.
		const command = await restart([], { execFails: true });

		expect(command).toContain(`--env-file=${file}`);
		expect(await fs.exists(dir)).toBe(false);
	});
});
