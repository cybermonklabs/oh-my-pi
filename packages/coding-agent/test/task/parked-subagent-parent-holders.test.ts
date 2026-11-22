/**
 * A parent session that runs task subagents keeps, for each one it has parked, only plain data in its own entries
 * and its Agent's messages: the results of its task calls hold no function, Map, abort signal, session, agent or
 * session manager a subagent's run made. The test runs real kept-alive subagents through the parent's `task` tool
 * against a mock model, parks them through the lifecycle manager, and walks every value reachable from the
 * parent's entries and messages before the first spawn and after the last park.
 *
 * The walk is in JS rather than over a heap snapshot: it starts at the two holders themselves and so is exact
 * about what each reaches, where a snapshot walk would first have to find them among its nodes. It follows own
 * properties, string and symbol keys, through their descriptors, so no getter runs and no cold entry is read
 * back (an accessor's functions are what it reaches there); array elements are own properties; it reads the
 * contents of each Map and Set. It cannot see the scope a closure keeps, so a function it reaches is itself the
 * finding, and so is a session, agent or session manager: it does not walk into one.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { restoreEnvValue } from "../helpers/settings-test-state";

const MOCK_API_SOURCE = "test/parked-subagent-parent-holders";
/** Subagents the parent spawns, in one assistant turn of task calls. */
const SUBAGENTS = 3;
/** The parent's prompt before any spawn, which the mock answers with a `read` call. */
const WARM_UP = "Warm up.";
/** The parent's prompt the mock answers with the task calls. */
const SPAWN = "Spawn the subagents.";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-parent-holders-"));
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
	// The sessions opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

const KINDS = ["Function", "Map", "AbortSignal", "AgentSession", "Agent", "SessionManager"] as const;
type Kind = (typeof KINDS)[number];

function kindOf(value: object): Kind | undefined {
	// Async, bound and class functions included.
	if (typeof value === "function") return "Function";
	if (value instanceof AgentSession) return "AgentSession";
	if (value instanceof Agent) return "Agent";
	if (value instanceof SessionManager) return "SessionManager";
	if (value instanceof AbortSignal) return "AbortSignal";
	if (value instanceof Map) return "Map";
	return undefined;
}

interface Held {
	counts: Record<Kind, number>;
	/** `kind at path` of each object counted, for a failure to name. */
	found: string[];
}

/** Every object of {@link KINDS} reachable from `holders`, each counted once. */
function heldObjects(holders: Readonly<Record<string, unknown>>): Held {
	const counts = Object.fromEntries(KINDS.map(kind => [kind, 0])) as Record<Kind, number>;
	const found: string[] = [];
	const seen = new Set<object>();
	const pending = Object.entries(holders).map(([at, value]) => ({ value, at }));
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const { value, at } = next;
		if ((typeof value !== "object" && typeof value !== "function") || value === null || seen.has(value)) continue;
		seen.add(value);
		const kind = kindOf(value);
		if (kind) {
			counts[kind]++;
			found.push(`${kind} at ${at}`);
			if (kind !== "Map") continue;
		}
		if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
		if (value instanceof Map) {
			for (const [key, item] of value)
				pending.push({ value: key, at: `${at}<key>` }, { value: item, at: `${at}<value>` });
		}
		if (value instanceof Set) for (const item of value) pending.push({ value: item, at: `${at}<item>` });
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
			if (!descriptor) continue;
			const field = `${at}.${String(key)}`;
			if ("value" in descriptor) pending.push({ value: descriptor.value, at: field });
			else
				pending.push(
					{ value: descriptor.get, at: `${field}<get>` },
					{ value: descriptor.set, at: `${field}<set>` },
				);
		}
	}
	return { counts, found };
}

/** The text of the user turn a request answers. */
function lastUserText(context: Context): string {
	const user = context.messages.findLast(message => message.role === "user");
	if (!user) return "";
	return typeof user.content === "string" ? user.content : JSON.stringify(user.content);
}

/**
 * The parent answers its warm-up prompt with a `read` call and its spawn prompt with {@link SUBAGENTS} task calls,
 * and ends each turn once their results are in. A subagent yields, or answers until it is offered `yield`.
 */
function respond(context: Context): MockResponse {
	if ((context.tools ?? []).some(tool => tool.name === "yield")) {
		return { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] };
	}
	const prompt = lastUserText(context);
	const tool = prompt.includes(WARM_UP) ? "read" : prompt.includes(SPAWN) ? "task" : undefined;
	if (!tool || context.messages.some(message => message.role === "toolResult" && message.toolName === tool)) {
		return { content: ["Done."] };
	}
	if (tool === "read") return { content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] };
	return {
		content: Array.from({ length: SUBAGENTS }, (_, index) => ({
			type: "toolCall" as const,
			name: "task",
			arguments: { name: `Probe${index}`, agent: "task", task: "report done", solutionSpace: "none" },
		})),
	};
}

// If this regresses, the memory of a long session that runs many subagents grows with every subagent it parks and is
// never given back, however often it compacts: a task call's result in the parent's transcript or messages keeps a
// closure, a Map or an abort signal of the subagent's finished run, or its session, and all that reaches.
it("keeps only plain data for a parked subagent in the parent's entries and messages", async () => {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	await Bun.write(path.join(cwd, "notes.txt"), "notes");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({ handler: respond });
	const modelRegistry = new ModelRegistry(authStorage);
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation((kind?: ModelKind | "all"): Model<Api>[] => [
		mock,
		...catalogAvailable(kind),
	]);
	const { session } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		model: mock,
		sessionManager: SessionManager.create(cwd, path.join(root, "sessions")),
		settings: Settings.isolated({
			// No TTL timer: the test parks explicitly through the same path the timer takes.
			"task.agentIdleTtlMs": 0,
			"task.batch": false,
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"advisor.enabled": false,
			"marketplace.autoUpdate": "off",
			modelRoles: { default: "mock/mock-model" },
		}),
		toolNames: ["task", "read"],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
	});
	try {
		// A turn with a tool call and its result before any spawn, so the walk before the spawns reaches what every
		// such turn's entries share.
		await session.prompt(WARM_UP);
		await session.waitForIdle();
		const before = heldObjects({
			entries: session.sessionManager.getEntries(),
			messages: session.agent.state.messages,
		});

		await session.prompt(SPAWN);
		await session.waitForIdle();
		const subagents = AgentRegistry.global()
			.list()
			.filter(ref => ref.kind === "sub");
		// The parent's own task calls, and no subagent of theirs.
		expect(subagents.map(ref => ref.id).sort()).toEqual(Array.from({ length: SUBAGENTS }, (_, i) => `Probe${i}`));
		const lifecycle = AgentLifecycleManager.global();
		for (const { id } of subagents) {
			await lifecycle.park(id);
			expect(AgentRegistry.global().get(id)).toMatchObject({ status: "parked", session: null });
		}
		// Recorded mock calls carry stream options bound to the sessions; they are the test's, not the parent's.
		mock.reset();

		const messages = session.agent.state.messages;
		const taskResults = messages.filter(message => message.role === "toolResult" && message.toolName === "task");
		expect(taskResults).toHaveLength(SUBAGENTS);
		const after = heldObjects({ entries: session.sessionManager.getEntries(), messages });
		expect(after.counts, after.found.join("\n")).toEqual(before.counts);
	} finally {
		await session.dispose();
		authStorage.close();
	}
}, 60_000);
