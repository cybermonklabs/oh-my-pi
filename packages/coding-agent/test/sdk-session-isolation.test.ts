import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON } from "@oh-my-pi/pi-coding-agent/async";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as secrets from "@oh-my-pi/pi-coding-agent/secrets";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionDisposeOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { turnAbortKind } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { finalizeSubagentLifecycle } from "@oh-my-pi/pi-coding-agent/task/executor";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { getSessionsDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getConfigRootDir, setProfile } from "@oh-my-pi/pi-utils/dirs";

function createTtsrRule(name: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: "Avoid forbidden output",
		condition: ["forbidden"],
		scope: ["text"],
		_source: {
			provider: "test",
			providerName: "test",
			path: `/tmp/${name}.md`,
			level: "project",
		},
	};
}

const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

async function withClearedSecretEnv<T>(run: () => Promise<T>): Promise<T> {
	const removed: Array<[string, string]> = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || value.length < 8) continue;
		if (!SECRET_ENV_PATTERNS.test(name)) continue;
		removed.push([name, value]);
		delete process.env[name];
	}
	try {
		return await run();
	} finally {
		for (const [name, value] of removed) {
			process.env[name] = value;
		}
	}
}

async function withTempConfigRoot<T>(run: () => Promise<T>): Promise<T> {
	const originalProfile = getActiveProfile();
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const configDirName = `.omp-sdk-session-${Snowflake.next()}`;
	const configRoot = path.join(os.homedir(), configDirName);
	try {
		process.env.PI_CONFIG_DIR = configDirName;
		setProfile(undefined);
		return await run();
	} finally {
		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		setProfile(originalProfile);
		// The model registry opened the shared `<configRoot>/agent/models.db` cache while the
		// temp root was active; release it so Windows can delete the root.
		closeModelCache();
		removeSyncWithRetries(configRoot);
	}
}

function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) throw new Error("Expected assistant message");
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join(" ");
}

describe("createAgentSession session storage isolation", () => {
	const tempDirs: string[] = [];
	// One shared, fully-populated (bundled models load synchronously in the
	// constructor) registry for every case. Passing it via options skips the
	// per-call discoverAuthStorage() SQLite open and the refreshInBackground()
	// network model probe inside createAgentSession — the two real wall-clock
	// sinks here. None of these cases assert on model discovery, so an
	// ambient-credential-free in-memory auth store keeps them deterministic.
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterAll(() => {
		sharedAuthStorage.close();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		LocalProtocolHandler.resetOverrideForTests();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("uses the provided agentDir for the default persistent session root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-isolation-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const sessionFile = session.sessionFile;
			if (!sessionFile) {
				throw new Error("Expected session file path");
			}

			expect(sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
			expect(sessionFile.startsWith(getSessionsDir())).toBe(false);
		} finally {
			await session.dispose();
		}
	});
	it("keeps subagent local:// mappings from replacing the process-global override", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-local-override-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const globalOptions = {
			getArtifactsDir: () => path.join(tempDir, "active-artifacts"),
			getSessionId: () => "active-session",
		};
		const subagentOptions = {
			getArtifactsDir: () => path.join(tempDir, "parent-artifacts"),
			getSessionId: () => "parent-session",
		};
		LocalProtocolHandler.setOverride(globalOptions);

		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			enableMCP: false,
			enableLsp: false,
			agentRegistry: new AgentRegistry(),
			agentId: "Tan-local-override-test",
			agentDisplayName: "tan",
			parentTaskPrefix: "Tan-local-override-test",
			parentAgentId: "Main",
			localProtocolOptions: subagentOptions,
		});

		try {
			expect(LocalProtocolHandler.resolveOptions()).toBe(globalOptions);
		} finally {
			await session.dispose();
		}
	});

	it("does not replace a newer registry generation when creation expected the id to be absent", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-cas-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const registry = new AgentRegistry();
		const replacement = registry.register({
			id: "shared-worker",
			displayName: "replacement B",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: path.join(tempDir, "agent"),
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				agentRegistry: registry,
				agentId: "shared-worker",
				agentDisplayName: "late A",
				parentTaskPrefix: "shared-worker",
				parentAgentId: "Main",
				taskDepth: 1,
				expectedAgentRef: null,
			}),
		).rejects.toThrow("already owned by another session generation");
		expect(registry.get("shared-worker")).toBe(replacement);
		expect(replacement).toMatchObject({ status: "idle", session: null });
	});

	it("reclaims an unrevivable parked generation before a fresh same-id spawn", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-corpse-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		const lifecycle = AgentLifecycleManager.global();
		const registry = AgentRegistry.global();
		const corpse = registry.register({
			id: "reused-worker",
			displayName: "dead generation",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: path.join(tempDir, "old-worker.jsonl"),
			status: "parked",
		});

		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir, "agent"),
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				agentRegistry: registry,
				agentId: "reused-worker",
				agentDisplayName: "fresh generation",
				parentTaskPrefix: "reused-worker",
				parentAgentId: "Main",
				taskDepth: 1,
				expectedAgentRef: null,
			}));
			const replacement = registry.get("reused-worker");
			expect(replacement).toBeDefined();
			expect(replacement).not.toBe(corpse);
			expect(replacement?.session).toBe(session);
		} finally {
			await session?.dispose();
			await lifecycle.dispose();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	it("reuses the exact parked ref authorized for revival", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-revive-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, tempDir);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted worker session file");
		const registry = new AgentRegistry();
		const parked = registry.register({
			id: "revived-worker",
			displayName: "revived worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});

		const { session } = await createAgentSession({
			cwd,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sessionManager,
			agentRegistry: registry,
			agentId: "revived-worker",
			agentDisplayName: "revived worker",
			parentTaskPrefix: "revived-worker",
			parentAgentId: "Main",
			taskDepth: 1,
			expectedAgentRef: parked,
		});
		try {
			expect(registry.get("revived-worker")).toBe(parked);
			expect(parked).toMatchObject({ status: "running", session, sessionFile });
		} finally {
			await session.dispose();
		}
		expect(registry.get("revived-worker")).toBeUndefined();
	});

	it("suspends the exact Vibe owner scope before global lifecycle teardown", async () => {
		VibeSessionRegistry.resetGlobalForTests();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-vibe-dispose-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const vibeRegistry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(vibeRegistry, "suspendScope");
		const lifecycleDispose = vi.spyOn(AgentLifecycleManager.global(), "dispose");
		const parentSessionId = session.sessionManager.getSessionId();
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Expected persisted parent session file");

		await session.dispose();

		expect(suspend).toHaveBeenCalledWith(
			{ ownerId: "Main", parentSessionId, parentSessionFile },
			session.asyncJobManager,
			"stop",
		);
		expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(lifecycleDispose.mock.invocationCallOrder[0]);
	});

	it("stops the turns of its Vibe workers at its teardown", async () => {
		// If this regresses, the parent's teardown cuts a worker's turn off: the worker's branch stays restorable, and
		// `/restart` or `omp --restore` relaunches it as a plain task, though a vibe turn a restart interrupts is not
		// resumed (`docs/vibe-mode.md`).
		VibeSessionRegistry.resetGlobalForTests();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-vibe-teardown-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const manager = session.asyncJobManager;
		if (!manager) throw new Error("Expected the session to own a job manager");
		// A worker turn in flight: a job of the parent under a worker record in the parent's scope, which
		// `registerRecordForTests` keys by the `test-parent-session` id and no session file.
		vi.spyOn(sessionManager, "getSessionId").mockReturnValue("test-parent-session");
		const turnAbortReason = Promise.withResolvers<unknown>();
		const jobId = manager.register(
			"task",
			"vibe worker turn",
			({ signal }) => {
				const ended = Promise.withResolvers<string>();
				signal.addEventListener(
					"abort",
					() => {
						turnAbortReason.resolve(signal.reason);
						ended.resolve("stopped");
					},
					{ once: true },
				);
				return ended.promise;
			},
			{ ownerId: MAIN_AGENT_ID },
		);
		VibeSessionRegistry.global().registerRecordForTests({ id: "worker", ownerId: MAIN_AGENT_ID, jobId });

		await session.dispose();

		// `turnAbortKind` reads the shutdown symbol as a stop too, so the reason must not be the shutdown's.
		const reason = await turnAbortReason.promise;
		expect(reason).not.toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		expect(turnAbortKind(reason)).toBe("stop");
	});

	it("wires the discovered TTSR manager into the created session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-ttsr-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const rule = createTtsrRule("sdk-ttsr-rule");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			rules: [rule],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.ttsrManager).toBeDefined();
			expect(session.ttsrManager?.checkDelta("forbidden", { source: "text" }).map(match => match.name)).toEqual([
				rule.name,
			]);
		} finally {
			await session.dispose();
		}
	});
	it("loads configured secrets per session alongside built-in credential redaction", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(cwd, { recursive: true });

			const commonOptions = {
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			};
			const configuredSecret = "sdk-secret-token-123456";

			const existingKeySpy = spyOn(secrets, "getExistingSecretPlaceholderKey").mockImplementation(
				async () => undefined,
			);
			try {
				const withoutSecrets = await createAgentSession(commonOptions);
				try {
					const obfuscator = withoutSecrets.session.obfuscator;
					expect(obfuscator?.hasSecrets()).toBe(true);
					expect(obfuscator?.obfuscate(configuredSecret)).toBe(configuredSecret);
				} finally {
					await withoutSecrets.session.dispose();
				}
			} finally {
				existingKeySpy.mockRestore();
			}

			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			fs.writeFileSync(path.join(cwd, ".omp", "secrets.yml"), `- type: plain\n  content: ${configuredSecret}\n`);

			const withSecrets = await createAgentSession(commonOptions);
			try {
				const obfuscator = withSecrets.session.obfuscator;
				expect(obfuscator?.hasSecrets()).toBe(true);
				expect(obfuscator?.obfuscate(configuredSecret)).not.toContain(configuredSecret);
			} finally {
				await withSecrets.session.dispose();
			}
		});
	});

	it("restores keyed assistant placeholders across reloads", async () => {
		await withClearedSecretEnv(async () => {
			await withTempConfigRoot(async () => {
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-secrets-${Snowflake.next()}-`));
				tempDirs.push(tempDir);
				const cwd = path.join(tempDir, "project");
				const agentDir = path.join(tempDir, "agent");
				fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
				fs.writeFileSync(
					path.join(cwd, ".omp", "secrets.yml"),
					"- type: plain\n  content: sdk-secret-token-123456\n",
				);

				const model = getBundledModel("anthropic", "claude-sonnet-4-5");
				if (!model) throw new Error("Expected anthropic model");

				const obfuscator = new secrets.SecretObfuscator(
					[{ type: "plain", content: "sdk-secret-token-123456" }],
					await secrets.getSecretPlaceholderKey(agentDir),
				);
				const placeholder = obfuscator.obfuscate("token sdk-secret-token-123456");
				const initialManager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
				initialManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: placeholder }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
				await initialManager.flush();
				const sessionFile = initialManager.getSessionFile();
				if (!sessionFile) throw new Error("Expected persisted session file");
				await initialManager.close();

				const resumedManager = await SessionManager.open(sessionFile, path.dirname(sessionFile));
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					modelRegistry: sharedModelRegistry,
					sessionManager: resumedManager,
					model,
					settings: Settings.isolated({ "secrets.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				try {
					expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toBe(
						"token sdk-secret-token-123456",
					);
					await session.reload();
					expect(getAssistantText(session.messages.at(-1) as AssistantMessage | undefined)).toBe(
						"token sdk-secret-token-123456",
					);
				} finally {
					await session.dispose();
				}
			});
		});
	});

	it("creates the placeholder key only when an obfuscate-mode secret is configured", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-key-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });

			const commonOptions = {
				cwd,
				agentDir,
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated({ "secrets.enabled": true }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			};

			const keySpy = spyOn(secrets, "getSecretPlaceholderKey").mockImplementation(
				async () => "test-placeholder-key",
			);
			const existingKeySpy = spyOn(secrets, "getExistingSecretPlaceholderKey").mockImplementation(
				async () => "existing-placeholder-key",
			);
			try {
				const keyOnly = await createAgentSession(commonOptions);
				try {
					expect(keySpy).not.toHaveBeenCalled();
					expect(existingKeySpy).toHaveBeenCalled();
					expect(keyOnly.session.obfuscator?.obfuscate("existing-placeholder-key")).not.toContain(
						"existing-placeholder-key",
					);
				} finally {
					await keyOnly.session.dispose();
				}

				existingKeySpy.mockClear();
				// Replace-mode secrets never build a reversible keyed placeholder, so
				// startup must not create the key file; an existing key is still redacted.
				fs.writeFileSync(
					path.join(cwd, ".omp", "secrets.yml"),
					"- type: plain\n  mode: replace\n  content: replace-only-secret-123456\n",
				);
				const replaceOnly = await createAgentSession(commonOptions);
				try {
					expect(replaceOnly.session.obfuscator?.hasSecrets()).toBe(true);
					expect(keySpy).not.toHaveBeenCalled();
					expect(existingKeySpy).toHaveBeenCalled();
					expect(replaceOnly.session.obfuscator?.obfuscate("existing-placeholder-key")).not.toContain(
						"existing-placeholder-key",
					);
				} finally {
					await replaceOnly.session.dispose();
				}

				// An obfuscate-mode secret needs the key for its reversible placeholder.
				keySpy.mockClear();
				existingKeySpy.mockClear();
				fs.writeFileSync(
					path.join(cwd, ".omp", "secrets.yml"),
					"- type: plain\n  content: obfuscate-secret-123456\n",
				);
				const withObfuscate = await createAgentSession(commonOptions);
				try {
					expect(keySpy).toHaveBeenCalled();
					expect(existingKeySpy).not.toHaveBeenCalled();
				} finally {
					await withObfuscate.session.dispose();
				}
			} finally {
				keySpy.mockRestore();
				existingKeySpy.mockRestore();
			}
		});
	});

	it("redacts a pre-existing placeholder key when only ignored short secrets remain", async () => {
		await withClearedSecretEnv(async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-stale-key-${Snowflake.next()}-`));
			tempDirs.push(tempDir);
			const cwd = path.join(tempDir, "project");
			const agentDir = path.join(tempDir, "agent");
			fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
			// Only an ignored short (<8 char) plain obfuscate secret: it never becomes an
			// active secret, but a previously-created key file must still be redacted and
			// no new key must be created.
			fs.writeFileSync(path.join(cwd, ".omp", "secrets.yml"), "- type: plain\n  content: abc\n");

			const keySpy = spyOn(secrets, "getSecretPlaceholderKey").mockImplementation(
				async () => "test-placeholder-key",
			);
			const existingKeySpy = spyOn(secrets, "getExistingSecretPlaceholderKey").mockImplementation(
				async () => "existing-placeholder-key",
			);
			try {
				const session = await createAgentSession({
					cwd,
					agentDir,
					modelRegistry: sharedModelRegistry,
					settings: Settings.isolated({ "secrets.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				try {
					expect(keySpy).not.toHaveBeenCalled();
					expect(existingKeySpy).toHaveBeenCalled();
					expect(session.session.obfuscator?.hasSecrets()).toBe(true);
					expect(session.session.obfuscator?.obfuscate("existing-placeholder-key")).not.toContain(
						"existing-placeholder-key",
					);
				} finally {
					await session.session.dispose();
				}
			} finally {
				keySpy.mockRestore();
				existingKeySpy.mockRestore();
			}
		});
	});

	it("stores placeholder keys under the configured agentDir", async () => {
		await withClearedSecretEnv(async () => {
			await withTempConfigRoot(async () => {
				const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-secrets-agent-key-${Snowflake.next()}-`));
				tempDirs.push(tempDir);
				const cwd = path.join(tempDir, "project");
				const agentDir = path.join(tempDir, "agent");
				fs.mkdirSync(path.join(cwd, ".omp"), { recursive: true });
				fs.writeFileSync(
					path.join(cwd, ".omp", "secrets.yml"),
					"- type: plain\n  content: agent-dir-secret-123456\n",
				);

				const { session } = await createAgentSession({
					cwd,
					agentDir,
					modelRegistry: sharedModelRegistry,
					settings: Settings.isolated({ "secrets.enabled": true }),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				});
				try {
					expect(fs.existsSync(path.join(agentDir, "secret-placeholder.key"))).toBe(true);
					expect(fs.existsSync(path.join(getConfigRootDir(), "secret-placeholder.key"))).toBe(false);
				} finally {
					await session.dispose();
				}
			});
		});
	});
});

describe("a helper session's end releases the agents under it once its own dispose stopped them", () => {
	const tempDirs: string[] = [];
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	/** A helper session for a host session (a `/security` scan) under the agent id `Helper`, with its own job manager. */
	async function openHelper() {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-helper-end-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry,
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			agentId: "Helper",
			agentDisplayName: "helper",
			bindProcessState: false,
		});
		const manager = session.asyncJobManager;
		if (!manager) throw new Error("Expected the helper session to own a job manager");
		return { helper: session, manager };
	}

	/**
	 * A keep-alive `task` subagent of the helper whose run is still going: registered `running` with its live session.
	 * `finalize` settles its run's end as the task executor does after a stop, a resumable abort, with a release hook
	 * (an isolated run's patch capture and worktree cleanup) that must run once when the agent ends.
	 */
	function runningSubagent(id: string) {
		const disposals: Array<AgentSessionDisposeOptions | undefined> = [];
		const disposed = Promise.withResolvers<void>();
		const session = {
			dispose: async (options?: AgentSessionDisposeOptions) => {
				disposals.push(options);
				disposed.resolve();
			},
		} as unknown as AgentSession;
		AgentRegistry.global().register({
			id,
			displayName: "task",
			kind: "sub",
			parentId: "Helper",
			session,
			status: "running",
		});
		let revivals = 0;
		let releaseHooks = 0;
		const finalize = () =>
			finalizeSubagentLifecycle({
				id,
				session,
				aborted: true,
				abortKind: "signal",
				keepAlive: true,
				isolated: false,
				agentIdleTtlMs: 0,
				reviveSession: async () => {
					revivals++;
					return session;
				},
				onRelease: async () => {
					releaseHooks++;
				},
			});
		return {
			disposals,
			disposed: disposed.promise,
			finalize,
			revivals: () => revivals,
			releaseHooks: () => releaseHooks,
		};
	}

	it("releases a subagent whose run the helper's own dispose ended and adopted, so nothing revives it", async () => {
		// If this regresses, the helper releases the agents under it before its own dispose stops its jobs: the stop
		// ends a subagent's run, whose finalize adopts the subagent idle with its live session after that release, and
		// nothing releases it any more, so a message wakes it into a billed turn under the ended helper.
		const { helper, manager } = await openHelper();
		const sub = runningSubagent("Helper-Sub");
		let adoptedDuringDispose = false;
		// The subagent's run is a background job of the helper: the helper's dispose stops it, and the run finalizes.
		manager.register(
			"task",
			"subagent run",
			async ({ signal }) => {
				const stopped = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => stopped.resolve(), { once: true });
				await stopped.promise;
				await sub.finalize();
				adoptedDuringDispose = AgentLifecycleManager.global().has("Helper-Sub");
				return "stopped";
			},
			{ ownerId: "Helper", agentId: "Helper-Sub" },
		);

		await helper.dispose({ ownedJobsEnd: "stop" });

		expect(adoptedDuringDispose).toBe(true);
		expect(AgentRegistry.global().get("Helper-Sub")).toBeUndefined();
		expect(AgentLifecycleManager.global().has("Helper-Sub")).toBe(false);
		expect(sub.disposals).toEqual([{ ownedJobsEnd: "stop" }]);
		await expect(AgentLifecycleManager.global().ensureLive("Helper-Sub")).rejects.toThrow("Unknown agent");
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: "Helper-Sub", body: "Go on." });
		expect(receipt.outcome).toBe("failed");
		expect(sub.revivals()).toBe(0);
		expect(sub.releaseHooks()).toBe(1);
	});

	it("stops and releases a subagent whose run outlives the helper's wait for its jobs, so its finalize does not adopt it", async () => {
		// If this regresses, a subagent whose run the helper's dispose stopped but did not see end within its bounded
		// wait stays registered with its live session after the helper's end, and the run's later finalize adopts it:
		// a live agent under an ended helper that nothing releases. Or the finalize, run while the release disposes the
		// subagent's session, adopts it and the release's unregister drops that adoption without its release hook: an
		// isolated run's patch capture and worktree cleanup never run.
		const { helper, manager } = await openHelper();
		const sub = runningSubagent("Helper-Sub");
		const finalized = Promise.withResolvers<void>();
		// The subagent's run is a background job of the helper that the stop does not end: it ends only once its
		// session is disposed, after the helper's dispose stopped waiting for its jobs.
		manager.register(
			"task",
			"subagent run",
			async () => {
				await sub.disposed;
				await sub.finalize();
				finalized.resolve();
				return "stopped";
			},
			{ ownerId: "Helper", agentId: "Helper-Sub" },
		);

		await helper.dispose({ ownedJobsEnd: "stop" });

		expect(sub.disposals[0]).toEqual({ ownedJobsEnd: "stop" });
		expect(AgentRegistry.global().get("Helper-Sub")).toBeUndefined();
		await finalized.promise;
		expect(AgentRegistry.global().get("Helper-Sub")).toBeUndefined();
		expect(AgentLifecycleManager.global().has("Helper-Sub")).toBe(false);
		expect(sub.revivals()).toBe(0);
		expect(sub.releaseHooks()).toBe(1);
	}, 30_000);

	it("still disposes the helper when releasing the agents under it fails", async () => {
		// If this regresses, a lifecycle step that rejects (the release of the helper's agents, as a worker thread's
		// lifecycle proxy once rejected it) skips the helper's own dispose: its turn, its jobs, its kernels and its
		// browser tabs stay.
		class RejectingLifecycle extends AgentLifecycleManager {
			override releaseUnder(): Promise<void> {
				return Promise.reject(new Error("the agents under the helper cannot be released here"));
			}
		}
		AgentLifecycleManager.installGlobal(new RejectingLifecycle());
		const { helper, manager } = await openHelper();
		let jobSignal: AbortSignal | undefined;
		manager.register(
			"task",
			"background work",
			async ({ signal }) => {
				jobSignal = signal;
				const stopped = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => stopped.resolve(), { once: true });
				await stopped.promise;
				return "stopped";
			},
			{ ownerId: "Helper" },
		);

		const [disposal] = await Promise.allSettled([helper.dispose({ ownedJobsEnd: "stop" })]);

		// The helper's own dispose ran: it stopped its job and disposed its job manager.
		expect(jobSignal?.aborted).toBe(true);
		expect(turnAbortKind(jobSignal?.reason)).toBe("stop");
		expect(() => manager.register("task", "late work", async () => "late")).toThrow("Async job manager is disposed");
		// The failed release is logged; the dispose itself completes.
		expect(disposal?.status).toBe("fulfilled");
	});
});
