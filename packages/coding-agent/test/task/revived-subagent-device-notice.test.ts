/**
 * A parked subagent revived by a restarted process sends the system prompt it was spawned with, stored in its session.
 * That prompt's catalog lists the `xd://` devices the subagent was parked with. Once a fresh build renders differently
 * (here a skill installed before the restart), the stored prompt's first block no longer matches the current render;
 * a rebuild that reproduces the stored prompt (a tool an extension registers at the first turn) must still credit the
 * devices it lists, so the wake's request tells the model of no inventory change.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Message } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";
import { restoreEnvValue } from "../helpers/settings-test-state";

const AGENT_ID = "ReviveDevices";
const MOCK_API_SOURCE = "test/revived-subagent-device-notice";
const MOUNT_NOTICE = "xd:// device inventory changed";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-revive-device-notice-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

/** Registers a tool at each binding's first turn, as an extension whose discovery starts at `session_start` does. */
const registersAtFirstTurn: ExtensionFactory = pi => {
	let registered = false;
	pi.on("before_agent_start", () => {
		if (registered) return;
		registered = true;
		pi.registerTool({
			name: "late_tool",
			loadMode: "essential",
			label: "late_tool",
			description: "Tool registered at the first turn",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "late_tool ok" }] };
			},
		});
	});
};

/** The text every message of a request carries. */
function textOf(messages: readonly Message[]): string {
	return messages
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(block => (block.type === "text" ? block.text : "")).join(""),
		)
		.join("\n");
}

interface RecordedRequest {
	systemPrompt: string;
	messages: string;
}

it("sends no device inventory notice from a cold-revived subagent whose stored prompt lists its devices", async () => {
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const requests: RecordedRequest[] = [];
	let requested = Promise.withResolvers<void>();
	const mock = createMockModel({
		handler: context => {
			requests.push({
				systemPrompt: (context.systemPrompt ?? []).join("\n"),
				messages: textOf(context.messages),
			});
			requested.resolve();
			if (requests.length === 1) {
				return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
			}
			return { content: ["ack"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"async.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const preparedExtensions = [
		{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: registersAtFirstTurn, error: null },
	];
	let revived: AgentSession | undefined;
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			preloadedPreparedExtensions: preparedExtensions,
			settings,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		expect(result.exitCode).toBe(0);
		await AgentLifecycleManager.global().park(AGENT_ID);
		const parked = requests.at(-1);
		if (!parked) throw new Error("Expected the spawn's request");

		// A skill is installed before the restart: a fresh render lists it, the stored prompt does not.
		await Bun.write(
			path.join(root, "home", ".omp", "agent", "skills", "release-checklist", "SKILL.md"),
			"---\nname: release-checklist\ndescription: Walks a release through its checklist.\n---\n\nCheck every box.\n",
		);
		const owner = {
			sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
			effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
			preparedExtensions,
		} as unknown as AgentSession;
		const ref = AgentRegistry.global().get(AGENT_ID);
		if (!ref) throw new Error(`${AGENT_ID} is not registered`);
		const reviver = await createPersistedSubagentReviverFactory({
			session: owner,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
		})(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		revived = localSession(await reviver(ref));

		requested = Promise.withResolvers<void>();
		const before = requests.length;
		await revived.deliverIrcMessage({ id: "irc-wake", from: "Main", to: AGENT_ID, body: "one more", ts: 1 });
		await requested.promise;
		await revived.agent.waitForIdle();
		const wake = requests[before];
		if (!wake) throw new Error("Expected the wake's request");
		// Preconditions: the wake sends the stored prompt, which lists the devices, and the spawn sent no notice.
		expect(wake.systemPrompt).toBe(parked.systemPrompt);
		expect(wake.systemPrompt).toContain("xd://");
		expect(parked.messages).not.toContain(MOUNT_NOTICE);
		// No device was mounted or unmounted since that prompt was built.
		expect(wake.messages).not.toContain(MOUNT_NOTICE);
	} finally {
		await revived?.dispose();
		authStorage.close();
	}
}, 30_000);
