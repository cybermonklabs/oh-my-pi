/**
 * Runs a kept-alive subagent to its finished state, parks it, drops the mock's session-bound recordings,
 * collects from fresh event-loop turns for up to {@link COLLECT_BOUND_MS}, and prints whether the object
 * its check watches was collected: the parked session (`session`) or the settings overlay the run wrote
 * (`settings`), with what the check also reads. With `held`, the probe keeps that object itself: the
 * control, which must not be collected.
 *
 * Run it in a process of its own with `BUN_JSC_useConcurrentJIT=0`: in a process that has warmed the
 * session code, an optimizing-JIT plan on a background thread can keep the object reachable for seconds.
 */
import { vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { cfgContextPromotionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { localSession } from "../helpers/local-session";

const [watched, reference] = process.argv.slice(2);
if ((watched !== "session" && watched !== "settings") || (reference !== "dropped" && reference !== "held")) {
	throw new Error("usage: parked-subagent-release-probe <session|settings> <dropped|held>");
}

const AGENT_ID = "ParkedRelease";
const MOCK_API_SOURCE = "test/parked-subagent-session-release";
/**
 * How long the probe collects before it reports the object still reachable. With concurrent JIT off, a
 * release took at most 1.2 s in 80 runs with JSC's tier-up thresholds at 1 (runc and gVisor).
 */
const COLLECT_BOUND_MS = 2000;

/** What the probe keeps itself in the `held` control. */
const held: object[] = [];

/** Kept out of the main flow so no strong local binding outlives the capture. */
function weakRefToLiveSession(id: string): WeakRef<AgentSession> {
	const session = AgentRegistry.global().get(id)?.session;
	if (!session) throw new Error(`subagent ${id} has no live session to observe`);
	const live = localSession(session);
	if (reference === "held") held.push(live);
	return new WeakRef(live);
}

/** Makes a settings write in the live session's own overlay, then observes the overlay weakly. */
function writeAndObserveLiveSettings(id: string): WeakRef<Settings> {
	const session = localSession(AgentRegistry.global().get(id)?.session);
	cfgContextPromotionEnabled.set(session, true);
	if (reference === "held") held.push(session.settings);
	return new WeakRef(session.settings);
}

/** Collects from fresh event-loop turns until `ref`'s target is gone or {@link COLLECT_BOUND_MS} has passed. */
async function collect(ref: WeakRef<object>): Promise<{ collected: boolean; waitedMs: number }> {
	const started = performance.now();
	for (;;) {
		// A WeakRef target read in a job stays alive until that job ends: yield, collect, then read.
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
		Bun.gc(true);
		const waitedMs = Math.round(performance.now() - started);
		if (ref.deref() === undefined) return { collected: true, waitedMs };
		if (waitedMs >= COLLECT_BOUND_MS) return { collected: false, waitedMs };
		await Bun.sleep(50);
	}
}

/** Runs `AGENT_ID` to a finished keep-alive state; `release` drops the mock's session-bound recordings. */
async function runKeptAliveSubagent(root: string): Promise<{ release(): void; close(): void }> {
	// Under the isolated HOME: project discovery walks up from cwd and stops at os.homedir(). On Windows
	// os.tmpdir() lives under the real home, so a cwd outside the fake HOME would walk into the real
	// ~/.omp and load the developer's installed plugins as project plugins.
	const cwd = path.join(root, "home", "work");
	const artifactsDir = path.join(root, "artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({
		handler: context =>
			(context.tools ?? []).some(tool => tool.name === "yield")
				? { content: [{ type: "toolCall", name: "yield", arguments: { type: "result", data: "done" } }] }
				: { content: ["label"] },
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	const availableSpy = vi
		.spyOn(modelRegistry, "getAvailable")
		.mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	try {
		const result = await runSubprocess({
			cwd,
			artifactsDir,
			agent: { name: "task", description: "test", systemPrompt: "test", tools: ["read"], source: "bundled" },
			task: "report done",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				// No TTL timer: the probe parks explicitly through the same path the timer takes.
				"task.agentIdleTtlMs": 0,
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
				"advisor.enabled": false,
				modelRoles: { default: "mock/mock-model" },
			}),
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
		});
		if (result.exitCode !== 0) throw new Error(`the subagent run exited ${result.exitCode}: ${result.stderr}`);
	} catch (error) {
		authStorage.close();
		throw error;
	}
	return {
		// Recorded mock calls carry stream options with closures bound to the session.
		release: () => {
			mock.reset();
			availableSpy.mockRestore();
		},
		close: () => authStorage.close(),
	};
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parked-release-"));
const home = path.join(root, "home");
await fs.mkdir(home, { recursive: true });
process.env.HOME = home;
Bun.env.HOME = home;
vi.spyOn(os, "homedir").mockReturnValue(home);
setAgentDir(path.join(home, ".omp", "agent"));
AgentRegistry.resetGlobalForTests();
AgentLifecycleManager.resetGlobalForTests();
registerMockApi(MOCK_API_SOURCE);

let report: Record<string, unknown>;
try {
	const run = await runKeptAliveSubagent(root);
	try {
		if (watched === "session") {
			const sessionRef = weakRefToLiveSession(AGENT_ID);
			await AgentLifecycleManager.global().park(AGENT_ID);
			const entry = AgentRegistry.global().get(AGENT_ID);
			const parked = { status: entry?.status, session: entry?.session ?? null };
			const adoptedAtPark = AgentLifecycleManager.global().has(AGENT_ID);
			run.release();
			const collection = await collect(sessionRef);
			// Still adopted after collection: a release that came from dropping the reviver would not count.
			report = { ...collection, parked, adoptedAtPark, adoptedAfter: AgentLifecycleManager.global().has(AGENT_ID) };
		} else {
			// A write the subagent made to its own settings during the run.
			const settingsRef = writeAndObserveLiveSettings(AGENT_ID);
			await AgentLifecycleManager.global().park(AGENT_ID);
			run.release();
			const collection = await collect(settingsRef);
			const revived = localSession(await AgentLifecycleManager.global().ensureLive(AGENT_ID));
			report = { ...collection, revivedSetting: cfgContextPromotionEnabled.get(revived) };
		}
	} finally {
		run.close();
	}
} finally {
	await AgentLifecycleManager.global().dispose();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	// The subagent session opened agent.db and models.db under root; Windows cannot delete open files.
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
}

// Exit once the report is written: the process holds nothing the check still needs.
const written = Promise.withResolvers<void>();
process.stdout.write(JSON.stringify({ ...report, held: held.length }), () => written.resolve());
await written.promise;
process.exit(0);
