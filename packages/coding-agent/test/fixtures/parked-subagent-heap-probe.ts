/**
 * Child process for test/task/parked-subagent-heap.test.ts. Under one root session, with the persisted reviver
 * factory installed as main.ts installs it, runs `argv[4]` batches of `argv[3]` real kept-alive task subagents
 * (`runSubprocess` against a mock model that answers `yield`), parks each one through the lifecycle manager, and
 * reads the JS heap after forced collections at the end of each batch. The first batch pays every once-per-process
 * cost; each later batch's growth, divided by its size, is what the process keeps for each parked subagent plus
 * whatever the heap did once during that batch. Prints one JSON line with every reading and each later batch's
 * growth per subagent. The parent runs this with the JIT off and HOME and PI_CODING_AGENT_DIR under a temp dir.
 */
import { heapStats } from "bun:jsc";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const [root, countArg, batchesArg] = process.argv.slice(2);
const count = Number(countArg);
const batches = Number(batchesArg);
if (!root || !Number.isInteger(count) || count < 1 || !Number.isInteger(batches) || batches < 2) {
	throw new Error("usage: parked-subagent-heap-probe.ts <root> <subagents per batch> <batches, at least 2>");
}
/** Shortest time each reading polls for the heap to stop falling; see {@link settledHeap}. */
const SETTLE_MS = 2_000;
/** How long past {@link SETTLE_MS} a reading waits for every parked session to be collected. */
const RELEASE_DEADLINE_MS = 15_000;

interface HeapReading {
	heapSize: number;
	Map: number;
	Function: number;
	AsyncFunction: number;
	JSLexicalEnvironment?: number;
	/** ES module records: a module loaded once per subagent (an extension, a plugin) shows here. */
	ModuleRecord: number;
	/** CommonJS module objects (`Module` in heapStats, "Module (CommonJS)" in a heap snapshot). */
	CommonJSModule: number;
	/** Parked subagents whose session was still reachable when the reading was taken. */
	liveParkedSessions: number;
}

const mock = createMockModel({
	handler: context =>
		(context.tools ?? []).some(tool => tool.name === "yield")
			? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
			: { content: ["label"] },
});

/** Lists the mock first, as the in-process kept-alive subagent tests inject it into `getAvailable`. */
class MockFirstModelRegistry extends ModelRegistry {
	override getAvailable(kind?: ModelKind | "all"): Model<Api>[] {
		return [mock, ...super.getAvailable(kind)];
	}
}

// Under HOME: project discovery walks up from cwd and stops at os.homedir().
const cwd = path.join(root, "home", "work");
const artifactsDir = path.join(root, "artifacts");
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(artifactsDir, { recursive: true });

registerMockApi("test/parked-subagent-heap-probe");
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "test-key");
const modelRegistry = new MockFirstModelRegistry(authStorage);
const settings = Settings.isolated({
	// No TTL timer: the probe parks explicitly through the same path the timer takes.
	"task.agentIdleTtlMs": 0,
	"async.enabled": false,
	"compaction.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	"marketplace.autoUpdate": "off",
	modelRoles: { default: "mock/mock-model" },
});
const { session } = await createAgentSession({
	cwd,
	authStorage,
	modelRegistry,
	model: mock,
	settings,
	toolNames: ["read"],
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	rules: [],
	enableMCP: false,
	enableLsp: false,
});
AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
	createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
	() => 0,
);

const parkedSessions: WeakRef<object>[] = [];

/** Observes `id`'s live session weakly; kept out of the run's frames so no strong local binding outlives it. */
function observeSession(id: string): void {
	const live = AgentRegistry.global().get(id)?.session;
	if (!live) throw new Error(`subagent ${id} has no live session to observe`);
	parkedSessions.push(new WeakRef(live));
}

function liveParkedSessions(): number {
	return parkedSessions.filter(ref => ref.deref() !== undefined).length;
}

/** Runs subagent `id` to a finished keep-alive state under the root session's settings, then parks it. */
async function runParkedSubagent(id: string, index: number): Promise<void> {
	const result = await runSubprocess({
		cwd,
		artifactsDir,
		agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
		task: "report done",
		index,
		id,
		modelOverride: "mock/mock-model",
		authStorage,
		modelRegistry,
		settings: session.settings,
		enableLsp: false,
		enableMCP: false,
		enableIrc: false,
		// The run's cleanup arms a timeout this long even when the cleanup finishes at once; a short one keeps
		// the timer from outliving the settle window below. It bounds the cleanup, not what the park keeps.
		cleanupGraceMs: 1_000,
	});
	if (result.exitCode !== 0) throw new Error(`subagent ${id} failed: ${result.error ?? result.output}`);
	observeSession(id);
	await AgentLifecycleManager.global().park(id);
	// Recorded mock calls carry stream options with closures bound to the session.
	mock.reset();
	const ref = AgentRegistry.global().get(id);
	if (ref?.status !== "parked" || ref.session !== null || !AgentLifecycleManager.global().has(id)) {
		throw new Error(`subagent ${id} did not park: status ${ref?.status}`);
	}
}

let spawned = 0;
async function runBatch(): Promise<void> {
	for (let index = 0; index < count; index++) {
		spawned++;
		await runParkedSubagent(`Probe${String(spawned).padStart(4, "0")}`, index);
	}
}

/**
 * Polls with forced collections, each from fresh event-loop turns so FinalizationRegistry callbacks and late
 * disposal run between them, for at least {@link SETTLE_MS} and until no parked session is reachable, and keeps the
 * smallest heap seen. Right after a batch one parked session stays reachable for a few seconds (observed: up to 6 s,
 * through no reference a heap snapshot shows) and holds about 1,000 functions, 90 Maps and up to 1.3 MB, so a
 * reading taken while it lives counts a whole session against the batch.
 */
async function settledHeap(): Promise<HeapReading> {
	let heapSize = Number.POSITIVE_INFINITY;
	const settleDeadline = Date.now() + SETTLE_MS;
	const releaseDeadline = settleDeadline + RELEASE_DEADLINE_MS;
	for (;;) {
		for (let round = 0; round < 4; round++) {
			await Bun.sleep(0);
			Bun.gc(true);
		}
		heapSize = Math.min(heapSize, heapStats().heapSize);
		const now = Date.now();
		if (now >= settleDeadline && (now >= releaseDeadline || liveParkedSessions() === 0)) break;
		await Bun.sleep(250);
	}
	const { objectTypeCounts } = heapStats();
	return {
		heapSize,
		Map: objectTypeCounts.Map ?? 0,
		Function: objectTypeCounts.Function ?? 0,
		AsyncFunction: objectTypeCounts.AsyncFunction ?? 0,
		JSLexicalEnvironment: objectTypeCounts.JSLexicalEnvironment,
		ModuleRecord: objectTypeCounts.ModuleRecord ?? 0,
		CommonJSModule: objectTypeCounts.Module ?? 0,
		liveParkedSessions: liveParkedSessions(),
	};
}

function perSubagent(after: number | undefined, before: number | undefined): number | undefined {
	return after === undefined || before === undefined ? undefined : (after - before) / count;
}

/** What the process gained, per subagent of the batch, from reading `before` to reading `after`. */
function growthPerSubagent(after: HeapReading, before: HeapReading) {
	return {
		heapSize: perSubagent(after.heapSize, before.heapSize),
		Map: perSubagent(after.Map, before.Map),
		Function: perSubagent(after.Function, before.Function),
		AsyncFunction: perSubagent(after.AsyncFunction, before.AsyncFunction),
		JSLexicalEnvironment: perSubagent(after.JSLexicalEnvironment, before.JSLexicalEnvironment),
		ModuleRecord: perSubagent(after.ModuleRecord, before.ModuleRecord),
		CommonJSModule: perSubagent(after.CommonJSModule, before.CommonJSModule),
	};
}

const readings: HeapReading[] = [];
for (let batch = 0; batch < batches; batch++) {
	await runBatch();
	readings.push(await settledHeap());
}

await AgentLifecycleManager.global().dispose();
await session.dispose();
authStorage.close();

process.stdout.write(
	`${JSON.stringify({
		count,
		readings,
		// One entry for each batch after the first, against the reading before it.
		perParkedSubagent: readings.slice(1).map((after, index) => growthPerSubagent(after, readings[index])),
	})}\n`,
);
