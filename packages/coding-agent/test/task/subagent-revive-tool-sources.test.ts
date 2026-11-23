/**
 * A subagent revived from its stored session builds in the directory its tools run in, project A, after the session
 * its live inputs come from moved to project B: it finds A's custom tools, project MCP servers, project extensions
 * and custom commands, and none of B's, and it keeps the user's extensions and the host's inline ones. A child of a
 * live subagent that works in the child's own directory keeps that subagent's tool sources. Each case spawns a real
 * subagent in A on a scripted model, parks it, revives it warm, drops its warm reviver as a worker's exit does, and
 * revives it cold through the persisted reviver factory.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { appendFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import { discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { importExtensionModule } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { discoverSessionExtensionPaths } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "@oh-my-pi/pi-coding-agent/thread/subagent-worker";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
	editSessionRecords,
	fixtureAgent,
	type LiveParent,
	lastToolResult,
	openReviveEnv,
	type RecordedRequest,
	type ReviveEnv,
	type RevivedSubagent,
	spawnerOptions,
	userTexts,
	WAKE_BODY,
} from "./revive-harness";

/** The custom tools of projects A and B (TA, TB). */
const TA = "ta_probe";
const TB = "tb_probe";
/** The tools of the project extensions of A and B (EA, EB), the user's extension (EU) and the host's inline one (EI). */
const EA = "ea_probe";
const EB = "eb_probe";
/** The tool of project C's extension (EC); C is a directory the root moves to without scanning it. */
const EC = "ec_probe";
const EU = "eu_probe";
const EI = "ei_probe";
/** The tool names of the MCP servers that A's and B's project configs name (MA, MB). */
const MA_PREFIX = "mcp__ma_";
const MB_PREFIX = "mcp__mb_";
/** The lesson EA saves through the memory context of the session that calls it. */
const LESSON = "Fixture lesson the revived subagent saved.";
/** A stdio MCP server with one tool. */
const MCP_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "instructions-mcp.ts");

/** A custom tool that answers the directory it runs in: its API's cwd and `pwd` through its API's exec. */
function customToolSource(name: string): string {
	return `export default api => ({
	name: ${JSON.stringify(name)},
	description: "Reports the directory the tool runs in.",
	parameters: api.arktype({}),
	loadMode: "essential",
	async execute() {
		const pwd = await api.exec("pwd", []);
		return { content: [{ type: "text", text: JSON.stringify({ cwd: api.cwd, pwd: pwd.stdout.trim() }) }] };
	},
});
`;
}

/**
 * An extension whose `session_start` hook writes its tool's name to `hookLog`, and whose tool answers `pwd` through
 * the extension API's exec; with `saves`, the tool also saves {@link LESSON} through the session's memory context.
 */
function extensionSource(name: string, hookLog: string, saves = false): string {
	const save = saves ? `await ctx.memory?.save({ content: ${JSON.stringify(LESSON)} })` : "undefined";
	return `import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.on("session_start", () => appendFileSync(${JSON.stringify(hookLog)}, ${JSON.stringify(`${name}\n`)}));
	pi.registerTool({
		name: ${JSON.stringify(name)},
		label: ${JSON.stringify(name)},
		description: "Reports the directory the extension runs in.",
		parameters: pi.arktype({}),
		loadMode: "essential",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const pwd = await pi.exec("pwd", []);
			const saved = ${save};
			return { content: [{ type: "text", text: JSON.stringify({ pwd: pwd.stdout.trim(), stored: saved?.stored ?? 0 }) }] };
		},
	});
}
`;
}

/** A custom TS command that writes the directory it runs in to `marker`. */
function commandSource(name: string, marker: string): string {
	return `export default api => ({
	name: ${JSON.stringify(name)},
	description: "Writes the directory the command runs in.",
	async execute() {
		const pwd = await api.exec("pwd", []);
		await Bun.write(${JSON.stringify(marker)}, pwd.stdout.trim());
	},
});
`;
}

/** The fixture projects of one test process. */
interface Projects {
	/** Project A, the test process's cwd, where the subagent is spawned and where its tools run. */
	readonly a: string;
	/** Project B, the directory the root session moves to. */
	readonly b: string;
	/** Project C, which holds only a project extension, EC. */
	readonly c: string;
	/** A's directory as `pwd` prints it. */
	readonly realA: string;
	/** Each extension's `session_start` hook writes its tool's name here, one line per binding. */
	readonly hookLog: string;
	/** Where `/ca` and `/cb` write the directory they ran in. */
	readonly ranCa: string;
	readonly ranCb: string;
	/** EU's file, in the user's agent directory. */
	readonly userExtension: string;
	/** EI, the extension the host passes inline. */
	readonly inline: PreparedExtension;
}

/** Writes A's and B's tool sources, the user's extension EU and the host's inline extension EI. */
async function writeProjects(env: ReviveEnv): Promise<Projects> {
	const a = env.cwd;
	const b = path.join(env.root, "project-b");
	const c = path.join(env.root, "project-c");
	const hookLog = path.join(env.root, "hooks.log");
	const ranCa = path.join(env.root, "ran-ca.txt");
	const ranCb = path.join(env.root, "ran-cb.txt");
	for (const [dir, tool, extension, server, command, ran] of [
		[a, TA, EA, "ma", "ca", ranCa],
		[b, TB, EB, "mb", "cb", ranCb],
	] as const) {
		await Bun.write(path.join(dir, ".omp", "tools", `${tool}.ts`), customToolSource(tool));
		await Bun.write(
			path.join(dir, ".omp", "extensions", `${extension}.ts`),
			extensionSource(extension, hookLog, extension === EA),
		);
		await Bun.write(path.join(dir, ".omp", "commands", command, "index.ts"), commandSource(command, ran));
		await Bun.write(
			path.join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { [server]: { type: "stdio", command: process.execPath, args: [MCP_FIXTURE] } },
			}),
		);
	}
	const userExtension = path.join(getAgentDir(), "extensions", `${EU}.ts`);
	await Bun.write(userExtension, extensionSource(EU, hookLog));
	const inlineFactory: ExtensionFactory = pi => {
		pi.on("session_start", () => appendFileSync(hookLog, `${EI}\n`));
		pi.registerTool({
			name: EI,
			label: EI,
			description: "Reports the directory the host's extension runs in.",
			parameters: pi.arktype({}),
			loadMode: "essential",
			async execute() {
				const pwd = await pi.exec("pwd", []);
				return { content: [{ type: "text", text: pwd.stdout.trim() }] };
			},
		});
	};
	const inline: PreparedExtension = {
		path: "<inline-0>",
		resolvedPath: "<inline-0>",
		factory: inlineFactory,
		error: null,
	};
	await Bun.write(path.join(c, ".omp", "extensions", `${EC}.ts`), extensionSource(EC, hookLog));
	return { a, b, c, realA: await fs.realpath(a), hookLog, ranCa, ranCb, userExtension, inline };
}

/** One test process: its env, its live root, its projects, and the MCP managers the root's scans connected. */
interface ToolSourceProcess {
	readonly env: ReviveEnv;
	readonly root: LiveParent;
	readonly projects: Projects;
	close(): Promise<void>;
	/**
	 * The root session (re)starts in `dir`, as a root resumed there scans it: its cwd, its custom-tool paths, its
	 * extension paths and prepared extensions (the host's inline one last), and an MCP manager connected to the
	 * servers of `dir`'s project config.
	 */
	startRootIn(dir: string): Promise<void>;
}

/** A test process whose root starts in A; `roots`, where given, is the owner's extension-root policy over its projects. */
async function openToolSourceProcess(
	roots?: (projects: Projects) => EffectiveExtensionRoots,
): Promise<ToolSourceProcess> {
	const env = await openReviveEnv({ "memory.backend": "local", "mcp.startupTimeoutMs": 0 });
	const projects = await writeProjects(env);
	const root = env.createLiveParent(undefined, undefined, roots?.(projects));
	const managers: MCPManager[] = [];
	const tools = root.toolSession;
	const startRootIn = async (dir: string): Promise<void> => {
		await root.session.sessionManager.moveTo(dir);
		tools.customToolPaths = await discoverCustomToolPaths([], dir, getAgentDir());
		const extensionPaths = await discoverSessionExtensionPaths(
			{ extensionRoots: tools.effectiveExtensionRoots },
			dir,
			tools.settings,
		);
		tools.extensionPaths = extensionPaths;
		const prepared = await Promise.all(extensionPaths.map(file => importExtensionModule(file, dir)));
		root.preparedExtensions?.splice(0, root.preparedExtensions.length, ...prepared, projects.inline);
		const { manager } = await discoverAndLoadMCPTools(dir, { startupTimeoutMs: 0 });
		managers.push(manager);
		tools.mcpManager = manager;
	};
	await startRootIn(projects.a);
	env.installColdReviver(root);
	return {
		env,
		root,
		projects,
		startRootIn,
		async close() {
			for (const manager of managers) await manager.disconnectAll();
			await env.close();
		},
	};
}

/** A spawn of `id` by `parent`, with `extra` over the shared spawn inputs. */
function spawnOptions(env: ReviveEnv, parent: ToolSession, id: string, extra: Partial<ExecutorOptions> = {}) {
	return { ...spawnerOptions(parent), ...env.subagentInputs(id), ...extra };
}

/** A tool call the scripted model answers with. */
function toolCall(name: string): MockResponse {
	return { content: [{ type: "toolCall", name, arguments: {} }] };
}

/**
 * The cold-revived subagent's wake turn: it calls TA, then EA, then answers. Any other request (a spawn's, a warm
 * wake's, a person's message) is left to the harness's script.
 */
function probeTurn(request: RecordedRequest): MockResponse | undefined {
	const last = request.messages.at(-1);
	if (last?.role === "toolResult") return last.toolName === TA ? toolCall(EA) : undefined;
	const turnStart = request.messages.findLastIndex(message => message.role === "assistant");
	const woken = userTexts({ ...request, messages: request.messages.slice(turnStart + 1) }).some(text =>
		text.includes(WAKE_BODY),
	);
	return woken ? toolCall(TA) : undefined;
}

/** The tool-source tools a session holds: the custom tools, the extensions' tools and the MCP servers' tools. */
function sourceTools(session: AgentSession): string[] {
	const named = [TA, TB, EA, EB, EC, EU, EI];
	return session
		.getAllToolNames()
		.filter(name => named.includes(name) || name.startsWith(MA_PREFIX) || name.startsWith(MB_PREFIX))
		.sort();
}

/** What the cold-revived subagent's tools, extensions and commands did. */
interface ColdRun {
	readonly cold: RevivedSubagent;
	readonly warmTools: string[];
	readonly ta: unknown;
	readonly ea: unknown;
	readonly lessonInA: string | undefined;
	readonly lessonInB: boolean;
	readonly ranCa: string | undefined;
	readonly ranCb: boolean;
}

async function readOptional(file: string): Promise<string | undefined> {
	const handle = Bun.file(file);
	return (await handle.exists()) ? handle.text() : undefined;
}

function resultJson(session: AgentSession, tool: string): unknown {
	const result = lastToolResult(session, tool);
	return result && !result.isError ? JSON.parse(result.text) : result;
}

/**
 * Revives `id` cold, wakes it so it calls TA and EA, then sends it the messages `/ca` and `/cb` as a person does.
 * `warmTools` is the tool-source list of the warm revive before.
 */
async function coldRun(process: ToolSourceProcess, id: string, warmTools: string[]): Promise<ColdRun> {
	const { env, projects } = process;
	env.dropWarmReviver(id);
	const cold = await env.revive(id);
	env.respond = probeTurn;
	await env.wake(cold.session, id);
	env.respond = undefined;
	for (const command of ["/ca", "/cb"]) {
		await cold.session.prompt(command);
		await cold.session.agent.waitForIdle();
	}
	const lessons = (dir: string) => path.join(getMemoryRoot(getAgentDir(), dir), "learned.md");
	return {
		cold,
		warmTools,
		ta: resultJson(cold.session, TA),
		ea: resultJson(cold.session, EA),
		lessonInA: await readOptional(lessons(projects.a)),
		lessonInB: await Bun.file(lessons(projects.b)).exists(),
		ranCa: await readOptional(projects.ranCa),
		ranCb: await Bun.file(projects.ranCb).exists(),
	};
}

/** Revives `id` warm, wakes it once and parks it again; returns the warm revive's tool-source list. */
async function warmRevive(env: ReviveEnv, id: string): Promise<string[]> {
	const warm = await env.revive(id);
	await env.wake(warm.session, id);
	const tools = sourceTools(warm.session);
	await env.park(id);
	return tools;
}

/** The cases of row (p) that check every clause on the cold revive. */
function defineColdRunCases(title: string, result: () => ColdRun | undefined, projects: () => Projects | undefined) {
	it(`${title}: the tool list holds A's tools (TA, MA's, ea), eu and ei, and none of B's, as the warm revive's does`, () => {
		const run = result();
		if (!run) throw new Error("The test process did not start");
		const tools = sourceTools(run.cold.session);
		expect(tools.filter(name => [TB, EB].includes(name) || name.startsWith(MB_PREFIX))).toEqual([]);
		expect(tools).toEqual(expect.arrayContaining([TA, EA, EU, EI]));
		expect(tools.some(name => name.startsWith(MA_PREFIX))).toBe(true);
		expect(run.warmTools.filter(name => [TB, EB].includes(name) || name.startsWith(MB_PREFIX))).toEqual([]);
		expect(run.warmTools).toEqual(expect.arrayContaining([TA, EA, EU, EI]));
		expect(run.cold.build.options.cwd).toBe(projects()?.a);
	}, 30_000);

	it(`${title}: a call of TA reads api.cwd as A and runs its exec command in A`, () => {
		expect(result()?.ta).toEqual({ cwd: projects()?.a, pwd: projects()?.realA });
	}, 30_000);

	it(`${title}: EA's pi.exec runs in A, and the lesson it saves through its memory context is under A's project`, () => {
		const run = result();
		expect(run?.ea).toEqual({ pwd: projects()?.realA, stored: 1 });
		expect(run?.lessonInA).toContain(LESSON);
		expect(run?.lessonInB).toBe(false);
	}, 30_000);

	it(`${title}: /ca from A runs in A, and /cb from B runs no command`, () => {
		const run = result();
		expect(run?.ranCa).toBe(projects()?.realA);
		expect(run?.ranCb).toBe(false);
	}, 30_000);
}

describe("a live root restarted in B, whose custom-tool paths, extensions and MCP manager are B's", () => {
	const id = "RootInB";
	let process: ToolSourceProcess | undefined;
	let run: ColdRun | undefined;

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		await env.spawn(spawnOptions(env, root.toolSession, id));
		await env.park(id);
		const warmTools = await warmRevive(env, id);
		await process.startRootIn(projects.b);
		run = await coldRun(process, id, warmTools);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	defineColdRunCases(
		"restarted root",
		() => run,
		() => process?.projects,
	);

	it("restarted root: the cold revive passes none of B's custom-tool paths and no MCP manager, and masks B's project secrets", () => {
		const options = run?.cold.build.options;
		expect(options?.preloadedCustomToolPaths).toBeUndefined();
		expect(options?.mcpManager).toBeUndefined();
		expect(options?.secretsProjectDirs).toEqual(process ? [process.projects.b] : []);
	}, 30_000);
});

describe("a live root restarted in B and then moved to C, whose project extension it never scanned", () => {
	const id = "RootInBThenC";
	let process: ToolSourceProcess | undefined;
	let coldTools: string[] = [];

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		await env.spawn(spawnOptions(env, root.toolSession, id));
		await env.park(id);
		await process.startRootIn(projects.b);
		// The root moves on to C as `/move` moves it; its extensions stay those it was built with in B.
		await root.session.sessionManager.moveTo(projects.c);
		env.dropWarmReviver(id);
		coldTools = sourceTools((await env.revive(id)).session);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	it("root in B, then C: the tool list holds ea, eu and ei, and neither eb nor ec", () => {
		expect(coldTools).toEqual(expect.arrayContaining([EA, EU, EI]));
		expect(coldTools.filter(name => name === EB || name === EC)).toEqual([]);
	}, 30_000);
});

describe("a spawner that passed no custom-tool paths and no MCP manager, its root restarted in B", () => {
	const id = "SpawnerPassedNone";
	let process: ToolSourceProcess | undefined;
	let run: ColdRun | undefined;

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		await env.spawn(
			spawnOptions(env, root.toolSession, id, { preloadedCustomToolPaths: undefined, mcpManager: undefined }),
		);
		await env.park(id);
		const warmTools = await warmRevive(env, id);
		await process.startRootIn(projects.b);
		run = await coldRun(process, id, warmTools);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	defineColdRunCases(
		"spawner passed none",
		() => run,
		() => process?.projects,
	);
});

describe("a nested subagent whose parent is parked, under a root with no tool session and no MCP manager, restarted in B", () => {
	const parentId = "ParkedToolParent";
	const id = "ParkedToolChild";
	let process: ToolSourceProcess | undefined;
	let run: ColdRun | undefined;

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		await env.spawn(spawnOptions(env, root.toolSession, parentId));
		await env.spawn(spawnOptions(env, env.toolSessionOf(parentId), id));
		await env.park(id);
		const warmTools = await warmRevive(env, id);
		await env.park(parentId);
		await process.startRootIn(projects.b);
		MCPManager.setInstance(undefined);
		env.installColdReviver(env.hostRoot(root));
		run = await coldRun(process, id, warmTools);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	defineColdRunCases(
		"parked parent, host root",
		() => run,
		() => process?.projects,
	);
});

describe("a record with no spawn spec, in a process with no MCP manager, its root restarted in B", () => {
	const id = "NoSpecRecord";
	let process: ToolSourceProcess | undefined;
	let run: ColdRun | undefined;

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		const spawned = await env.spawn(spawnOptions(env, root.toolSession, id, { mcpManager: undefined }));
		await env.park(id);
		const warmTools = await warmRevive(env, id);
		await editSessionRecords(spawned.sessionFile, record => {
			if (record.type !== "session_init") return false;
			delete record.spawnSpec;
			return true;
		});
		await process.startRootIn(projects.b);
		root.toolSession.mcpManager = undefined;
		MCPManager.setInstance(undefined);
		run = await coldRun(process, id, warmTools);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	defineColdRunCases(
		"record with no spec",
		() => run,
		() => process?.projects,
	);
});

describe("an owner's explicit-only extension policy naming EU only, its root restarted in B", () => {
	const id = "ExplicitOnly";
	let process: ToolSourceProcess | undefined;
	let coldTools: string[] = [];
	let warmTools: string[] = [];

	beforeAll(async () => {
		process = await openToolSourceProcess(projects => ({
			explicit: [projects.userExtension],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		}));
		const { env, root, projects } = process;
		await env.spawn(spawnOptions(env, root.toolSession, id));
		await env.park(id);
		warmTools = await warmRevive(env, id);
		await process.startRootIn(projects.b);
		env.dropWarmReviver(id);
		coldTools = sourceTools((await env.revive(id)).session);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	it("explicit-only: the tool list holds eu and neither ea nor eb, as the warm revive's does", () => {
		for (const tools of [coldTools, warmTools]) {
			expect(tools).toContain(EU);
			expect(tools.filter(name => name === EA || name === EB)).toEqual([]);
		}
	}, 30_000);
});

describe("a restricted (plan-mode) subagent, whose extensions are its parent's hooks, its root restarted in B", () => {
	const id = "RestrictedHooks";
	let process: ToolSourceProcess | undefined;
	let coldHooks: string[] = [];
	let warmHooks: string[] = [];

	/** The hooks that ran while `step` ran, from the hook log. */
	async function hooksDuring(hookLog: string, step: () => Promise<void>): Promise<string[]> {
		await fs.rm(hookLog, { force: true });
		await step();
		const lines = (await readOptional(hookLog))?.split("\n").filter(Boolean) ?? [];
		return [...new Set(lines)].sort();
	}

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		const agent = fixtureAgent({ tools: ["read", "grep", "yield"] });
		await env.spawn({ ...spawnerOptions(root.toolSession, true), ...env.subagentInputs(id, agent) });
		await env.park(id);
		warmHooks = await hooksDuring(projects.hookLog, async () => {
			await env.revive(id);
			await env.park(id);
		});
		await process.startRootIn(projects.b);
		env.dropWarmReviver(id);
		coldHooks = await hooksDuring(projects.hookLog, async () => {
			await env.revive(id);
		});
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	it("restricted: the cold revive runs the hooks of EU, EI and EA and none of EB's, as the warm revive does", () => {
		expect(coldHooks).toEqual([EA, EI, EU].sort());
		expect(warmHooks).toEqual([EA, EI, EU].sort());
	}, 30_000);
});

describe("worker mode on, the subagent placed in a worker, its root restarted in B", () => {
	const id = "WorkerPlaced";
	let process: ToolSourceProcess | undefined;
	let pool: SubagentWorkerPool | undefined;
	let acquire: Mock<SubagentWorkerPool["acquire"]> | undefined;
	let cold: RevivedSubagent | undefined;

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root, projects } = process;
		await env.spawn(spawnOptions(env, root.toolSession, id));
		await env.park(id);
		await process.startRootIn(projects.b);
		// Every revive this pool places goes to a worker, which this test process does not start.
		pool = new SubagentWorkerPool({ maxWorkers: () => 1, idleMs: 600_000, hostsOnMain: false });
		acquire = vi.spyOn(pool, "acquire").mockRejectedValue(new Error("The revive was placed in a worker"));
		setSubagentWorkerPoolForTests(pool);
		env.dropWarmReviver(id);
		cold = await env.revive(id);
	}, 90_000);

	afterAll(async () => {
		setSubagentWorkerPoolForTests(undefined);
		pool?.dispose();
		await process?.close();
	}, 30_000);

	it("worker-placed: the cold revive runs on the main thread, and its tool list holds MA's tools and not MB's", () => {
		expect(acquire).not.toHaveBeenCalled();
		const tools = cold ? sourceTools(cold.session) : [];
		expect(tools.some(name => name.startsWith(MA_PREFIX))).toBe(true);
		expect(tools.filter(name => name.startsWith(MB_PREFIX))).toEqual([]);
	}, 30_000);
});

describe("a nested child of a live subagent that works in its own directory, the root not moved", () => {
	const parentId = "WorktreeParent";
	const id = "WorktreeChild";
	let process: ToolSourceProcess | undefined;
	let parent: ToolSession | undefined;
	let warm: RevivedSubagent | undefined;
	let cold: RevivedSubagent | undefined;
	let worktree = "";

	beforeAll(async () => {
		process = await openToolSourceProcess();
		const { env, root } = process;
		worktree = path.join(env.root, "worktree");
		await fs.mkdir(worktree, { recursive: true });
		await env.spawn(spawnOptions(env, root.toolSession, parentId, { cwd: worktree }));
		parent = env.toolSessionOf(parentId);
		await env.spawn(spawnOptions(env, parent, id));
		await env.park(id);
		warm = await env.revive(id);
		await env.park(id);
		env.dropWarmReviver(id);
		cold = await env.revive(id);
	}, 90_000);

	afterAll(async () => {
		await process?.close();
	}, 30_000);

	it("worktree child: the cold revive takes the live parent's custom-tool paths, MCP manager and extensions, and no secretsProjectDirs, as the warm revive does", () => {
		for (const revived of [cold, warm]) {
			const options = revived?.build.options;
			expect(options?.cwd).toBe(worktree);
			expect(options?.preloadedCustomToolPaths).toBe(parent?.customToolPaths);
			expect(options?.mcpManager).toBe(parent?.mcpManager);
			expect(options?.preloadedPreparedExtensions).toBe(parent?.preparedExtensions);
			expect(options?.secretsProjectDirs).toBeUndefined();
		}
	}, 30_000);
});
