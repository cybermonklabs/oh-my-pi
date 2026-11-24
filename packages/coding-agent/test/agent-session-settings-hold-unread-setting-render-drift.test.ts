/**
 * A settings change that moves nothing the session's prompt renders (`tui.reactions` in a headless session,
 * `task.maxConcurrency` in a session with no `task` tool, `personality` in a task subagent) must be neither held nor
 * announced. The prompt build also reads state outside the settings on every rebuild (the one git checkout directly
 * under a cwd outside any repository), so a fresh render can differ from the bound prompt for a reason of its own.
 * Such a render does not make the change one the prompt moves with: no hidden settings notice may name it.
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
import { resolveActiveRepoContext } from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	RELOAD_CALLS,
	reloadOverlay,
	SETTINGS_NOTICE,
	setClock,
} from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	heldOpen,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
} from "./helpers/anthropic-gateway";
import { localSession } from "./helpers/local-session";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MINUTE_MS = 60_000;

const AGENT_ID = "RenderDriftWorker";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** Makes `dir` a git checkout, as a clone into the session's cwd leaves one. */
async function initCheckout(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const init = Bun.spawnSync(["git", "init", "-q", dir]);
	if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`);
}

describe("a settings change the prompt does not read while a fresh render differs for another reason", () => {
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-unread-render-drift-"));
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

	/**
	 * Runs a headless session with `read` alone, clones a repository into its cwd after the first request, then
	 * reloads the overlay with `change` added, and gives the notices the request after the change carries.
	 */
	async function headlessNotices(change: string): Promise<string> {
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
			// The agent clones a repository into its cwd: the next build lists it as the active project.
			await initCheckout(path.join(cwd, "project"));
			await reloadOverlay({ session, settings, overlay }, `${initial}${change}`, RELOAD_CALLS);
			setClock(MINUTE_MS);
			await session.prompt("after the change");

			const [first, changed] = gateway.requests;
			if (!first || !changed) throw new Error("Expected two requests");
			// Preconditions: the checkout is the active project a build renders, and the first request lacks it.
			expect((await resolveActiveRepoContext(cwd))?.relativeRepoRoot).toBe("project");
			expect(textOf(first.system)).not.toContain("direct-child git repo");
			return textOf(changed.messages.slice(first.messages.length));
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}

	it("is not announced as held in a headless session", async () => {
		// A headless session leaves the reaction guidance out without reading `tui.reactions`.
		expect(await headlessNotices("tui:\n  reactions: false\n")).not.toContain(SETTINGS_NOTICE);
	}, 60_000);

	it("is not announced as held when the build reads it but renders nothing of it", async () => {
		// The build reads `task.maxConcurrency`, but renders it only in the delegation guidance a session with no
		// `task` tool leaves out.
		expect(await headlessNotices("task:\n  maxConcurrency: 4\n")).not.toContain(SETTINGS_NOTICE);
	}, 60_000);

	it("is not announced as held in a task subagent", async () => {
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
		// While the subagent's first request is in flight it clones a repository into its cwd and a configuration
		// sync changes `personality`, which a subagent's prompt never renders.
		let synced: Promise<void> = Promise.resolve();
		const gateway = mockGatewayFetch(turn => {
			if (turn === 1) {
				synced = (async () => {
					await initCheckout(path.join(cwd, "project"));
					const subagent = localSession(AgentRegistry.global().get(AGENT_ID)?.session);
					await reloadOverlay(
						{ session: subagent, settings, overlay },
						`${initial}personality: pragmatic\n`,
						RELOAD_CALLS,
					);
					setClock(MINUTE_MS);
				})();
				return heldOpen(toolCallAnswer(turn, "read", { path: overlay }, { cacheWriteTokens: 100 }), synced);
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
				agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
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

			const [first, changed] = gateway.requests;
			if (!first || !changed) throw new Error("Expected the subagent's two requests");
			// Preconditions: the checkout is the active project a build renders, and the first request lacks it.
			expect((await resolveActiveRepoContext(cwd))?.relativeRepoRoot).toBe("project");
			expect(textOf(first.system)).not.toContain("direct-child git repo");

			expect(textOf(changed.messages.slice(first.messages.length))).not.toContain(SETTINGS_NOTICE);
		} finally {
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
