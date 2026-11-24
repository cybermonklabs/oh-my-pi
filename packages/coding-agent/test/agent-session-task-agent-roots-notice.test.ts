/**
 * Agent discovery scans are published under the session's cwd and its effective `extensions` roots. A configuration
 * sync that changes `extensions` moves that key, and the next committed rebuild finds no scan under it. A task
 * subagent spawned afterwards inherits the parent's roots and publishes its scan there. The parent's task tool keeps
 * the agents its committed prompt listed; an agent the new scan adds reaches the model by the hidden agent notice.
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
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { publishedAgentDiscovery } from "@oh-my-pi/pi-coding-agent/task/discovery-snapshots";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, editExtensionSources, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MINUTE_MS = 60_000;

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/** The `--config` overlay a configuration sync rewrites: one-hour entries, and subagents that run to completion. */
const OVERLAY = [
	"providers:\n  cacheRetention: long",
	"modelRoles:\n  default: anthropic/claude-opus-5-5",
	"async:\n  enabled: false",
	"compaction:\n  enabled: false",
	"retry:\n  enabled: false",
	"todo:\n  enabled: false",
	"advisor:\n  enabled: false",
	"",
].join("\n");

/** What a subagent of the `explore` agent is told it is. */
const EXPLORE_PROMPT = "You are the explore subagent.";

function agent(name: string, description: string, systemPrompt = `You are ${name}.`): AgentDefinition {
	return { name, description, systemPrompt, source: "project" };
}

function taskTool(request: MessagesRequest | undefined): string {
	const tool = request?.tools?.find(candidate => candidate.name === "task");
	if (!tool) throw new Error("Expected the task tool in the request");
	return withoutCacheControl(tool);
}

describe("a task subagent's discovery scan under extension roots a configuration sync changed", () => {
	let savedEnv: Record<string, string | undefined> = {};
	let root: string;

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-task-agent-roots-notice-"));
		const home = path.join(root, "home");
		await fs.mkdir(path.join(home, "work", "fleet"), { recursive: true });
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

	it("keeps the parent's task tool and tells the model the new agent by a notice", async () => {
		const cwd = path.join(root, "home", "work");
		const overlay = path.join(root, "overlay.yml");
		await Bun.write(overlay, OVERLAY);
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir: path.join(root, "home", ".omp", "agent"),
			configFiles: [overlay],
		});
		const discovered = [agent("explore", "Reads the repository and reports.", EXPLORE_PROMPT)];
		vi.spyOn(discoveryModule, "discoverAgents").mockImplementation(async () => ({
			agents: [...discovered],
			projectAgentsDir: null,
		}));
		// The parent's reply to `spawnTurn` calls `task`; every other reply, the subagent's among them, is text.
		let spawnTurn = 0;
		const gateway = mockGatewayFetch(turn => {
			const usage = { cacheWriteTokens: 100 };
			if (turn === spawnTurn) {
				return toolCallAnswer(
					turn,
					"task",
					{
						i: "Spawning an explorer",
						context: "The repository in the working directory.",
						tasks: [{ agent: "explore", task: "Report done.", solutionSpace: "Any report." }],
					},
					usage,
				);
			}
			return answer(turn, usage);
		});
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions({ path: () => cwd }),
			disableExtensionDiscovery: false,
			sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read", "task"],
			contextFiles: [],
			skills: [],
		});
		try {
			setClock(0);
			await session.prompt("first");
			// A configuration sync adds an extension root, which brings an agent of its own, and changes `personality`,
			// which the prompt reads: a bound prompt holds that rebuild.
			await editExtensionSources(
				{ session, settings, overlay },
				`${OVERLAY}personality: pragmatic\nextensions:\n  - ${path.join(cwd, "fleet")}\n`,
			);
			discovered.push(agent("fleet-helper", "Helps with the fleet."));
			// Past the held rebuild's deadline: this request commits the rebuild, under roots no scan was published for.
			setClock(6 * MINUTE_MS);
			await session.prompt("after the deadline");
			setClock(7 * MINUTE_MS);
			spawnTurn = gateway.requests.length + 1;
			await session.prompt("spawn an explorer");

			const [first, committed, spawning, next] = gateway.requests.filter(
				request => !withoutCacheControl(request.system).includes(EXPLORE_PROMPT),
			);
			if (!first || !committed || !spawning || !next) {
				throw new Error("Expected the parent's requests before and after the spawn");
			}
			// Preconditions: the held rebuild committed, and the subagent published its scan, with the new agent,
			// under the parent's roots.
			expect(withoutCacheControl(committed.system)).not.toBe(withoutCacheControl(first.system));
			const published = publishedAgentDiscovery(cwd, session.effectiveExtensionRoots);
			expect(published?.map(definition => definition.name)).toContain("fleet-helper");

			// The parent's request after the spawn, which carries its result, declares the tools as the one that spawned
			// it did, and tells the model of the new agent.
			expect(taskTool(spawning)).not.toContain("fleet-helper");
			expect(withoutCacheControl(next.tools)).toBe(withoutCacheControl(spawning.tools));
			const notice = withoutCacheControl(next.messages.slice(spawning.messages.length));
			expect(notice).toContain("`fleet-helper`: Helps with the fleet.");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
