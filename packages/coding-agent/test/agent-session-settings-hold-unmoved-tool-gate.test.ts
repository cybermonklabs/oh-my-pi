/**
 * A tool gate's change on a bound prompt is held only when it moves the tools the session has enabled: a tool it
 * removes stays declared and its calls are refused until the rebuild, a tool it adds waits for it, and the hidden
 * settings notice names the change. A gate whose change adds and removes nothing (the gated tool is not on the
 * session's explicit tool list, or the change leaves the tool allowed) moves nothing a rebuild would send: the requests
 * keep their prompt and tools after the deadline too. Such a change must not be announced as held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	heldOpen,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { localSession } from "./helpers/local-session";
import { restoreEnvValue } from "./helpers/settings-test-state";

/** The opening of the hidden settings notice. */
const SETTINGS_NOTICE = '<system-notice id="settings">';

const MINUTE_MS = 60_000;

const AGENT_ID = "UnmovedGateWorker";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

describe("a tool gate's change that moves no tool on a bound prompt", () => {
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unmoved-tool-gate-"));
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work"), { recursive: true });
		restoreEnvValue("HOME", home);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		await Bun.write(path.join(root, "models.yml"), gatewayModelsYml());
	});

	afterEach(async () => {
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		AgentStorage.close();
		closeModelCache();
		await removeWithRetries(root);
	});

	it("is not announced as held in a session whose explicit tool list lacks the gated tools", async () => {
		const overlay = path.join(root, "overlay.yml");
		const initial = "providers:\n  cacheRetention: long\n";
		await Bun.write(overlay, initial);
		const cwd = path.join(root, "home", "work");
		const settings = await Settings.loadIsolated({ cwd, agentDir: cwd, configFiles: [overlay] });
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions({ path: () => cwd }),
			sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			setClock(0);
			await session.prompt("first");
			// `todo` is not on the list, and a top-level session may spawn tasks under either depth limit.
			await reloadOverlay(
				{ session, settings, overlay },
				`${initial}todo:\n  enabled: false\ntask:\n  maxRecursionDepth: 3\n`,
				RELOAD_CALLS,
			);
			setClock(MINUTE_MS);
			await session.prompt("after the change");
			setClock(7 * MINUTE_MS);
			await session.prompt("after the deadline");

			const [first, changed, late] = gateway.requests;
			if (!first || !changed || !late) throw new Error("Expected three requests");
			// Preconditions: no request's prompt or tools follow the change, not even the one after the deadline.
			expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(late.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(late.tools)).toBe(withoutCacheControl(first.tools));

			expect(textOf(changed.messages.slice(first.messages.length))).not.toContain(SETTINGS_NOTICE);
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);

	it("is not announced as held in a task subagent whose tool list lacks the gated tool", async () => {
		const overlay = path.join(root, "overlay.yml");
		const initial = [
			"providers:\n  cacheRetention: long",
			"modelRoles:\n  default: anthropic/claude-opus-5-5",
			"async:\n  enabled: false",
			"compaction:\n  enabled: false",
			"retry:\n  enabled: false",
			"todo:\n  enabled: false",
			"advisor:\n  enabled: false",
			"",
		].join("\n");
		await Bun.write(overlay, initial);
		const cwd = path.join(root, "home", "work");
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			configFiles: [overlay],
		});
		// A configuration sync turns `github` on while the subagent's first request is in flight; the request after
		// the deadline yields.
		let synced: Promise<void> = Promise.resolve();
		const gateway = mockGatewayFetch(turn => {
			if (turn === 1) {
				synced = (async () => {
					const subagent = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
					await reloadOverlay(
						{ session: subagent, settings, overlay },
						`${initial}github:\n  enabled: true\n`,
						RELOAD_CALLS,
					);
					setClock(MINUTE_MS);
				})();
				return heldOpen(toolCallAnswer(turn, "read", { path: overlay }, { cacheWriteTokens: 100 }), synced);
			}
			if (turn === 2) {
				setClock(7 * MINUTE_MS);
				return toolCallAnswer(turn, "read", { path: overlay }, { cacheWriteTokens: 100 });
			}
			return toolCallAnswer(turn, "yield", { type: "result", data: "done" }, { cacheWriteTokens: 100 });
		});
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		try {
			setClock(0);
			const result = await runSubprocess({
				cwd,
				artifactsDir: path.join(root, "artifacts"),
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled", tools: ["read"] },
				task: "report done",
				index: 0,
				id: AGENT_ID,
				modelOverride: "anthropic/claude-opus-5-5",
				authStorage,
				modelRegistry,
				settings,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
			});
			await synced;
			expect(result.exitCode).toBe(0);

			const [first, changed, late] = gateway.requests;
			if (!first || !changed || !late) throw new Error("Expected the subagent's three requests");
			// Preconditions: no request's prompt or tools follow the change, not even the one after the deadline.
			expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(late.system)).toBe(withoutCacheControl(first.system));
			expect(withoutCacheControl(late.tools)).toBe(withoutCacheControl(first.tools));

			expect(textOf(changed.messages.slice(first.messages.length))).not.toContain(SETTINGS_NOTICE);
		} finally {
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
