/**
 * Spawns three structured subagents from three parent sessions with a kernel-defined tool, keeps what
 * the executor carries past each run (a parked child's revive capture), collects from fresh event-loop
 * turns, and prints how many parent sessions are still alive, with what the kept options hold.
 * With `held`, the probe keeps the parent sessions itself: the control, in which all three stay alive.
 *
 * Run it in a process of its own with `BUN_JSC_useConcurrentJIT=0`: in a process that has warmed the
 * subagent code, an optimizing-JIT plan on a background thread can keep a parent session reachable.
 */
import { vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const reference = process.argv[2];
if (reference !== "dropped" && reference !== "held") {
	throw new Error("usage: structured-subagent-spawner-release-probe <dropped|held>");
}

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

/** The bare tool session structured-subagent.test.ts builds. */
function session(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"isolation.backend": "rcopy",
			"task.enableLsp": true,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
const roots = { explicit: [], mode: "merge" as const, configured: [], configuredLevel: "user" as const };
const extensionRoots = () => roots;
// createAgentSession gives every tool session its own protocol options; the fallback
// built from a bare test session would close over that session.
const localProtocolOptions = { getArtifactsDir: () => null, getSessionId: () => null };
const descriptor = {
	name: "review_echo",
	description: "Echo a review note.",
	parameters: { type: "object", properties: {} },
	language: "python" as const,
};
// What the executor carries past the run; these four end with it.
const runScoped = new Set(["onProgress", "onToolResult", "onCleanupDeferred", "signal"]);
const kept: Array<Partial<executorModule.ExecutorOptions>> = [];
vi.spyOn(executorModule, "runSubprocess").mockImplementation(async executorOptions => {
	kept.push(Object.fromEntries(Object.entries(executorOptions).filter(([key]) => !runScoped.has(key))));
	return result();
});

const held: ToolSession[] = [];
const spawners: WeakRef<ToolSession>[] = [];
async function spawn(): Promise<void> {
	const parent = session();
	Object.assign(parent, { effectiveExtensionRoots: extensionRoots, localProtocolOptions });
	if (reference === "held") held.push(parent);
	spawners.push(new WeakRef(parent));
	const customTools = createEvalCustomTools(parent, [descriptor]);
	const run = await runStructuredSubagent({
		session: parent,
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		customTools,
		retainArtifacts: true,
	});
	await fs.rm(run.artifactsDir, { recursive: true, force: true });
}

for (let i = 0; i < 3; i++) await spawn();
// The spy's call log holds each run's whole options; keep only `kept`.
vi.restoreAllMocks();
for (let pass = 0; pass < 3; pass++) {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
	Bun.gc(true);
}
const remaining = spawners.filter(ref => ref.deref() !== undefined).length;

// With its spawner gone, the child's kernel-defined tool reports itself unavailable.
let toolText: string | undefined;
if (remaining === 0) {
	const outcome = await kept[0]!.customTools![0]!.execute("call-1", {}, undefined, undefined as never, undefined);
	const first = outcome.content[0];
	toolText = first?.type === "text" ? first.text : undefined;
}

process.stdout.write(
	JSON.stringify({
		kept: kept.length,
		extensionRootsKept: kept.every(options => options.extensionRoots?.() === roots),
		customToolNames: kept.map(options => options.customTools?.map(tool => tool.name)),
		remaining,
		toolText,
		held: held.length,
	}),
);
