/**
 * Subagent runs routed into pooled worker threads, end to end: a real worker on the
 * direct-module entry with every thread service, a real child `AgentSession` homed there,
 * and a scripted OpenAI-compatible server the worker's model registry finds through
 * `models.yml` (the worker mirror re-reads it, so no spies reach into the worker).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, logger, removeWithRetries } from "@oh-my-pi/pi-utils";
import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { AsyncJobManager } from "../../src/async/job-manager";
import type { EvalToolDescriptor } from "../../src/eval/types";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { hasRestorableTurn, INTERRUPTED_TURN_ERROR } from "../../src/session/exit-diagnostics";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { MemorySessionStorage } from "../../src/session/session-storage";
import { createEvalCustomTools } from "../../src/task/eval-tools";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { type AgentDefinition, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import type { ToolSession } from "../../src/tools";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const TEST_TIMEOUT_MS = 120_000;
/**
 * Scripted tasks are sentinels no other prompt text can contain: the session may wrap a task
 * (a date/cwd reminder prefixed to the first user turn) and sends side requests quoting other
 * text (one per discovered skill, compressing its description), so neither equality nor a
 * plain word like "hang" identifies the run's turn.
 */
const SCRIPT_ID = Bun.randomUUIDv7("hex");
const HANG_TASK = `omp-test-scripted-hang-${SCRIPT_ID}`;
const BG_JOB_TASK = `omp-test-scripted-bg-job-${SCRIPT_ID}`;
/** In the routed agent's system prompt only, so a request without it is never the run's own turn. */
const AGENT_MARKER = `omp-test-agent-${SCRIPT_ID}`;
/** The one eval custom tool of the runs that carry one. */
const LOOKUP_ROWS: EvalToolDescriptor = {
	name: "lookup_rows",
	description: "Looks up rows by key.",
	parameters: { type: "object", properties: { key: { type: "string" } } },
	language: "python",
};
/** A task whose run defines {@link PARENT_LOOKUP} in its session's JavaScript kernel through an `eval` call. */
const DEFINE_TOOL_TASK = `omp-test-scripted-define-tool-${SCRIPT_ID}`;
/** A message whose turn calls {@link PARENT_LOOKUP} with key `a`. */
const CALL_TOOL_TASK = `omp-test-scripted-call-tool-${SCRIPT_ID}`;
/** What the kernel-defined {@link PARENT_LOOKUP} answers, before `:<key>`. */
const KERNEL_ANSWER = `omp-test-kernel-answer-${SCRIPT_ID}`;
/** A tool a parent's JavaScript kernel defines ({@link DEFINE_TOOL_CODE}). */
const PARENT_LOOKUP: EvalToolDescriptor = {
	name: "parent_lookup",
	description: "Looks up rows by key in the parent's kernel.",
	parameters: { type: "object", properties: { key: { type: "string" } } },
	language: "js",
};
/** The JavaScript cell that defines {@link PARENT_LOOKUP}; `tool()` reads the name, description and parameters. */
const DEFINE_TOOL_CODE = `tool(({ key }) => ${JSON.stringify(`${KERNEL_ANSWER}:`)} + key, ${JSON.stringify(PARENT_LOOKUP)});`;

interface ChatMessage {
	role: string;
	content?: unknown;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("");
}

function isChatMessage(value: unknown): value is ChatMessage {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "role") === "string";
}

type Reply = { text: string } | { tool: string; args: Record<string, unknown> };

function chunks(reply: Reply): string {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const delta =
		"text" in reply
			? { role: "assistant", content: reply.text }
			: {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call_${reply.tool}`,
							type: "function",
							function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
						},
					],
				};
	const frames = [
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "text" in reply ? "stop" : "tool_calls" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * Scripted model. Only the routed agent's own turns (their system prompt carries
 * {@link AGENT_MARKER}) are scripted, by their last user message: containing
 * {@link BG_JOB_TASK} → an async `bash` call; containing {@link DEFINE_TOOL_TASK} → an `eval`
 * call running {@link DEFINE_TOOL_CODE}; containing {@link CALL_TOOL_TASK} → a
 * {@link PARENT_LOOKUP} call; containing {@link HANG_TASK} → no answer until the request is
 * aborted. A tool result is answered with `tool said: …`; everything else (the job's
 * completion notice, side requests) → `pong`.
 */
class FakeModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #hangs: Array<() => void> = [];
	#hungRequest = Promise.withResolvers<void>();
	/** The model and tool names of each of the routed agent's own requests, in order. */
	readonly runRequests: Array<{ model: string; toolNames: string[] }> = [];
	/** The text of each tool result the routed agent's own requests end on, in order. */
	readonly toolResults: string[] = [];

	constructor() {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => this.#fetch(request),
		});
	}

	get port(): number {
		return this.#server.port ?? 0;
	}

	/** Resolves once a {@link HANG_TASK} request is being held. */
	hung(): Promise<void> {
		return this.#hungRequest.promise;
	}

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${this.port}/v1`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }",
				"      - id: fake-model-2",
				"        name: Fake Model 2",
				"        reasoning: false",
				"        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }",
				"",
			].join("\n"),
		);
		return file;
	}

	stop(): void {
		for (const release of this.#hangs.splice(0)) release();
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const last = messages.at(-1);
		const lastUser = messages.findLast(message => message.role === "user");
		const userText = lastUser ? messageText(lastUser.content) : "";
		const systemText = messages
			.filter(message => message.role === "system" || message.role === "developer")
			.map(message => messageText(message.content))
			.join("\n");
		const runTurn = systemText.includes(AGENT_MARKER);
		if (runTurn && typeof body === "object" && body !== null) {
			const rawTools: unknown = Reflect.get(body, "tools");
			const toolNames = (Array.isArray(rawTools) ? rawTools : []).map(tool => {
				const fn: unknown = typeof tool === "object" && tool !== null ? Reflect.get(tool, "function") : undefined;
				return typeof fn === "object" && fn !== null ? String(Reflect.get(fn, "name")) : "";
			});
			this.runRequests.push({ model: String(Reflect.get(body, "model")), toolNames });
		}
		let reply: Reply = { text: "pong" };
		if (runTurn && last?.role === "tool") {
			const result = messageText(last.content);
			this.toolResults.push(result);
			reply = { text: `tool said: ${result}` };
		} else if (runTurn && userText.includes(BG_JOB_TASK)) {
			reply = { tool: "bash", args: { command: "echo bg-done", async: true } };
		} else if (runTurn && userText.includes(DEFINE_TOOL_TASK)) {
			reply = { tool: "eval", args: { language: "js", code: DEFINE_TOOL_CODE } };
		} else if (runTurn && userText.includes(CALL_TOOL_TASK)) {
			reply = { tool: PARENT_LOOKUP.name, args: { key: "a" } };
		} else if (runTurn && userText.includes(HANG_TASK)) {
			const held = Promise.withResolvers<void>();
			this.#hangs.push(held.resolve);
			request.signal.addEventListener("abort", () => held.resolve(), { once: true });
			this.#hungRequest.resolve();
			await held.promise;
			this.#hungRequest = Promise.withResolvers<void>();
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}
}

/** Poll a condition fed by another thread; waits on the condition itself, never a guessed duration. */
async function waitFor(check: () => boolean, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker-homed session mirror on main");
	return session;
}

const AGENT: AgentDefinition = {
	name: "task",
	description: "routing test agent",
	systemPrompt: `You are a test agent (${AGENT_MARKER}).`,
	source: "bundled",
	tools: ["read", "bash"],
};

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: FakeModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let jobs: AsyncJobManager;
let costGate: CostGate;
let eventBus: EventBus;
let lifecycleStatuses: Array<{ id: string; status: string }>;
const cleanups: Array<() => unknown> = [];

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-executor-routing-"));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	// Workers read these at start-up, so set them before the pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();

	server = new FakeModelServer();
	const modelsPath = await server.writeModelsYml(agentDir);
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = Settings.isolated({
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": true,
		modelRoles: { default: MODEL },
	});
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	costGate = new CostGate(settings, 0, () => {});
	eventBus = new EventBus();
	lifecycleStatuses = [];
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (typeof payload !== "object" || payload === null) return;
		lifecycleStatuses.push({
			id: String(Reflect.get(payload, "id")),
			status: String(Reflect.get(payload, "status")),
		});
	});
	// Every run goes to a worker here (no concurrency needed); placement itself is covered in subagent-worker.test.ts.
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 600_000,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000 },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	await AgentLifecycleManager.global().dispose();
	setSubagentWorkerPoolForTests(undefined);
	pool.dispose();
	server.stop();
	await jobs.dispose({ timeoutMs: 1_000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	authStorage.close();
	AgentStorage.close();
	closeModelCache();
	for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	await removeWithRetries(root);
});

function runOptions(id: string, task: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task,
		index: 0,
		id,
		description: `routing ${id}`,
		modelOverride: MODEL,
		structured: false,
		settings,
		authStorage,
		modelRegistry,
		costGate,
		asyncJobManager: jobs,
		eventBus,
		artifactsDir: path.join(root, "artifacts"),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
		...extra,
	};
}

/** A real main-thread root session, as main.ts hands the persisted reviver factory. */
function rootSession(): AgentSession {
	const model = modelRegistry.find("fake", "fake-model");
	if (!model) throw new Error("fake model missing from the main registry");
	const agent = new Agent({ initialState: { model, systemPrompt: ["root"], tools: [] }, convertToLlm });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(cwd),
		settings,
		modelRegistry,
		agentId: MAIN_AGENT_ID,
	});
	cleanups.push(() => session.dispose());
	return session;
}

describe("subagent runs routed into pooled workers", () => {
	it(
		"completes non-transferable storage runs inline while the file default runs in a worker",
		async () => {
			const storage = new MemorySessionStorage();
			const inline = await runSubprocess(runOptions("InlineStorage", "ping", { sessionStorage: storage }));
			expect(inline.error).toBeUndefined();
			expect(inline.output).toBe("pong");
			const local = AgentRegistry.global().get("InlineStorage")?.session;
			expect(local).toBeInstanceOf(AgentSession);
			const transcript = local?.sessionManager.getSessionFile();
			if (!transcript) throw new Error("inline child has no transcript");
			expect(await storage.readText(transcript)).toContain("pong");
			const followUp = await runSubagentFollowUpTurn({
				id: "InlineStorage",
				agent: AGENT,
				message: "again",
				structured: false,
				storeMaskCwd: cwd,
			});
			expect(followUp.output).toBe("pong");
			await AgentLifecycleManager.global().park("InlineStorage");
			const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: "InlineStorage", body: "wake" });
			expect(receipt.outcome).toBe("revived");
			const woken = AgentRegistry.global().get("InlineStorage")?.session;
			expect(woken).toBeInstanceOf(AgentSession);
			await waitFor(() => !woken?.isStreaming && !woken?.ircWakesPending);

			const file = await runSubprocess(runOptions("FileStorage", "ping"));
			expect(file.error).toBeUndefined();
			expect(file.output).toBe("pong");
			expect(pool.forThread(mirrorOf(AgentRegistry.global().get("FileStorage")?.session).home)?.alive).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"warms a worker with a throwaway session sealed off from main, then runs subagents there",
		async () => {
			const failures: string[] = [];
			const unregister = logger.registerLogSink(event => {
				if (event.message.startsWith("Subagent worker warm-up")) failures.push(event.message);
			});
			cleanups.push(unregister);
			const lease = await pool.acquire();
			const worker = lease.worker;
			if (!worker) throw new Error("the pool kept the run on the main thread");
			try {
				await worker.link.call("warmUp", { cwd, settings, modelRegistry });
			} finally {
				lease.release();
			}
			expect(failures).toEqual([]);
			// The warm-up session registered only in its private registry.
			expect(AgentRegistry.global().list()).toEqual([]);
			const result = await runSubprocess(runOptions("AfterWarmUp", "ping"));
			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			expect(mirrorOf(AgentRegistry.global().get("AfterWarmUp")?.session).home).toBe(worker.threadId);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps a lone spawn on the main thread under the default policy, counted while it runs",
		async () => {
			const mainPool = new SubagentWorkerPool({ maxWorkers: () => 4, idleMs: 600_000 });
			setSubagentWorkerPoolForTests(mainPool);
			cleanups.push(() => mainPool.dispose());
			let countedWhileRunning = 0;
			const result = await runSubprocess(
				runOptions("OnMain", "ping", {
					onProgress: () => {
						countedWhileRunning = Math.max(countedWhileRunning, mainPool.mainRuns);
					},
				}),
			);
			expect(result.output).toBe("pong");
			expect(AgentRegistry.global().get("OnMain")?.session).toBeInstanceOf(AgentSession);
			expect(mainPool.workers()).toEqual([]);
			expect(countedWhileRunning).toBe(1);
			expect(mainPool.runsInFlight).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs the child in a worker: main mirror, result, progress, lifecycle frames, cost, async jobs",
		async () => {
			const progress: AgentProgress[] = [];
			const result = await runSubprocess(runOptions("Bg", BG_JOB_TASK, { onProgress: p => progress.push(p) }));

			expect(result.error).toBeUndefined();
			expect(result.exitCode).toBe(0);
			// bash call → its "backgrounded" result → the job's completion notice → final answer.
			expect(result.output).toBe("pong");
			expect(result.requests).toBe(3);
			// The child stays adopted and live in its worker; main holds its mirror.
			const ref = AgentRegistry.global().get("Bg");
			const mirror = mirrorOf(ref?.session);
			expect(pool.forThread(mirror.home)?.alive).toBe(true);
			expect(mirror.instanceKey.startsWith(`${mirror.home}:`)).toBe(true);
			expect(progress.length).toBeGreaterThan(0);
			expect(progress.at(-1)?.status).toBe("completed");
			expect(lifecycleStatuses.filter(frame => frame.id === "Bg").map(frame => frame.status)).toEqual([
				"started",
				"completed",
			]);
			// The requests' cost landed on main's gate.
			expect(costGate.spent).toBeGreaterThan(0);
			// The async bash job the child started ran as a row of main's manager.
			const bash = jobs.getAllJobs().filter(job => job.type === "bash");
			expect(bash.map(job => job.status)).toEqual(["completed"]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"clears a finished worker-homed child's ircWakesPending on main, so its idle TTL can park it",
		async () => {
			const result = await runSubprocess(runOptions("Parkable", "ping"));
			expect(result.output).toBe("pong");
			const mirror = mirrorOf(AgentRegistry.global().get("Parkable")?.session);
			// The run's IRC wake hold is released after the result without a session event.
			await waitFor(() => !mirror.ircWakesPending);
			await AgentLifecycleManager.global().park("Parkable");
			expect(AgentRegistry.global().get("Parkable")?.status).toBe("parked");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stores each eval tool's descriptor in the spawn spec of a run placed in a worker",
		async () => {
			const customTools = createEvalCustomTools({ settings } as unknown as ToolSession, [LOOKUP_ROWS]);
			const result = await runSubprocess(runOptions("EvalTools", "ping", { customTools }));
			expect(result.output).toBe("pong");
			// The tools crossed into the worker as views; the spawn there read the descriptors they carried.
			const mirror = mirrorOf(AgentRegistry.global().get("EvalTools")?.session);
			await waitFor(() => !mirror.ircWakesPending);
			await AgentLifecycleManager.global().park("EvalTools");
			const peek = await SessionManager.peekSessionInit(path.join(root, "artifacts", "EvalTools.jsonl"));
			if (!peek?.init) throw new Error("the worker run stored no session_init");
			// Read as stored JSON, so the file also loads where the spawn spec's reader does not exist.
			const stored = peek.init as unknown as { spawnSpec?: { tools?: { customTools?: unknown } } };
			expect(stored.spawnSpec?.tools?.customTools).toEqual([LOOKUP_ROWS]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"aborts the worker run when main's signal aborts",
		async () => {
			const controller = new AbortController();
			const running = runSubprocess(runOptions("Hang", HANG_TASK, { signal: controller.signal }));
			await server.hung();
			controller.abort(new Error("stop from main"));
			const result = await running;
			expect(result.aborted).toBe(true);
			expect(result.exitCode).not.toBe(0);
			expect(lifecycleStatuses.filter(frame => frame.id === "Hang").at(-1)?.status).toBe("aborted");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"cuts a detached worker run off when main's job manager shuts down, leaving its turn for --restore",
		async () => {
			// If this regresses, the manager's shutdown reason (a symbol, which cannot cross) reaches the worker as
			// text, which reads as a stop: the run's turn ends on a stop record and `omp --restore` drops it.
			const manager = new AsyncJobManager({});
			cleanups.push(() => manager.dispose({ timeoutMs: 1_000 }));
			const run = Promise.withResolvers<SingleResult>();
			manager.register("task", "Shutdown", async ({ signal }) => {
				const result = await runSubprocess(runOptions("Shutdown", HANG_TASK, { signal, detached: true }));
				run.resolve(result);
				return result.output;
			});
			await server.hung();
			await manager.dispose({ timeoutMs: 30_000 });
			const result = await run.promise;
			expect(result.aborted).toBe(true);
			// The shutdown releases the run's ref; its transcript stays where the run wrote it.
			const branch = (await SessionManager.open(path.join(root, "artifacts", "Shutdown.jsonl"))).getBranch();
			const tail = branch.filter(entry => entry.type === "message").at(-1);
			expect(
				tail?.type === "message" && tail.message.role === "assistant" ? tail.message.errorMessage : undefined,
			).toBe(INTERRUPTED_TURN_ERROR);
			expect(hasRestorableTurn(branch)).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"revives a parked worker-homed child in a worker for a follow-up turn and for an IRC message",
		async () => {
			const first = await runSubprocess(runOptions("Parked", "ping"));
			expect(first.output).toBe("pong");
			const lifecycle = AgentLifecycleManager.global();
			await lifecycle.park("Parked");
			const parked = AgentRegistry.global().get("Parked");
			expect(parked?.status).toBe("parked");
			expect(parked?.session).toBeNull();

			// Warm revive: the worker's reviver crossed to main's lifecycle as a function.
			const followUp = await runSubagentFollowUpTurn({
				id: "Parked",
				agent: AGENT,
				message: "again",
				structured: false,
				storeMaskCwd: cwd,
			});
			expect(followUp.error).toBeUndefined();
			expect(followUp.output).toBe("pong");
			const revived = mirrorOf(AgentRegistry.global().get("Parked")?.session);
			expect(pool.forThread(revived.home)?.alive).toBe(true);

			await lifecycle.park("Parked");
			expect(AgentRegistry.global().get("Parked")?.status).toBe("parked");
			const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: "Parked", body: "hello from main" });
			expect(receipt.outcome).toBe("revived");
			const woken = mirrorOf(AgentRegistry.global().get("Parked")?.session);
			expect(woken).not.toBe(revived);
			expect(pool.forThread(woken.home)?.alive).toBe(true);
			// Let the wake turn settle before teardown.
			await waitFor(() => !woken.isStreaming && !woken.ircWakesPending);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails a first run whose worker dies mid-run instead of hanging, naming the worker",
		async () => {
			const running = runSubprocess(runOptions("Lost", HANG_TASK));
			await server.hung();
			const [worker] = pool.workers();
			if (!worker) throw new Error("no pooled worker");
			worker.terminate("worker crashed: boom");
			const result = await running;
			expect(result.exitCode).toBe(1);
			expect(result.error).toBe(`Subagent worker ${worker.threadId} exited mid-run: worker crashed: boom`);
			// If this mark regresses, `omp --restore` reads the lost run's result, which the parent's agent loop records
			// as its process exit ends the workers, as the subagent's settled failure and never goes on with its turn.
			expect(result.workerLost).toBe(true);
			const ref = AgentRegistry.global().get("Lost");
			expect(ref?.session).toBeNull();
			// Its transcript survives: the ref stays revivable through the persisted factory.
			expect(ref?.status).toBe("parked");
			expect(lifecycleStatuses.filter(frame => frame.id === "Lost").map(frame => frame.status)).toEqual([
				"started",
				"failed",
			]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"fails a turn whose worker dies with an error naming it, and cold-revives the agent in a new worker",
		async () => {
			const first = await runSubprocess(runOptions("Crash", "ping"));
			expect(first.output).toBe("pong");
			const home = mirrorOf(AgentRegistry.global().get("Crash")?.session).home;
			const worker = pool.forThread(home);
			if (!worker) throw new Error("home worker missing");

			const turn = runSubagentFollowUpTurn({
				id: "Crash",
				agent: AGENT,
				message: HANG_TASK,
				structured: false,
				storeMaskCwd: cwd,
			});
			await server.hung();
			worker.terminate("worker crashed: boom");
			const failed = await turn;
			expect(failed.exitCode).toBe(1);
			expect(failed.error).toContain(`Subagent worker ${home}`);
			expect(failed.error).toContain("boom");
			const ref = AgentRegistry.global().get("Crash");
			expect(ref?.status).toBe("parked");
			expect(ref?.session).toBeNull();

			// The warm reviver died with its worker; the persisted factory revives into the pool.
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: rootSession(),
					authStorage,
					modelRegistry,
					settings,
					enableLsp: false,
					eventBus,
				}),
				() => 0,
			);
			const revived = mirrorOf(await lifecycle.ensureLive("Crash"));
			expect(revived.home).not.toBe(home);
			expect(pool.forThread(revived.home)?.alive).toBe(true);
			expect(AgentRegistry.global().get("Crash")?.session).toBe(revived);
			const again = await runSubagentFollowUpTurn({
				id: "Crash",
				agent: AGENT,
				message: "again",
				structured: false,
				storeMaskCwd: cwd,
			});
			expect(again.output).toBe("pong");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"kills a worker-homed child whose transcript directory is gone, and marks the transcript its session writes back",
		async () => {
			const running = runSubprocess(runOptions("WorkerGone", HANG_TASK));
			await server.hung();
			const ref = AgentRegistry.global().get("WorkerGone");
			if (!ref?.sessionFile) throw new Error("no session file on the ref");
			mirrorOf(ref.session);
			await fs.rm(path.dirname(ref.sessionFile), { recursive: true, force: true });

			// The child's dispose (in its worker) writes the vanished transcript back; the kill then marks it.
			expect(await AgentLifecycleManager.global().release("WorkerGone", ref, { tombstone: true })).toBe(true);
			await running;

			expect(await fs.exists(ref.sessionFile)).toBe(true);
			expect(await fs.exists(`${ref.sessionFile}.tombstone`)).toBe(true);
			expect(AgentRegistry.global().get("WorkerGone")?.status).toBe("aborted");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a cold revive in a subagent worker starts on the spawn's model, flags and custom tools",
		async () => {
			settings.setModelRole("task", MODEL);
			const customTools = createEvalCustomTools({ settings } as unknown as ToolSession, [LOOKUP_ROWS]);
			// The agent lists `lsp`, which the spawn's LSP setting (off) keeps out of its tools.
			const agent: AgentDefinition = { ...AGENT, tools: ["read", "bash", "lsp"] };
			const first = await runSubprocess(
				runOptions("ColdInWorker", "ping", { agent, modelOverride: "@task", customTools, enableLsp: false }),
			);
			expect(first.output).toBe("pong");
			expect(server.runRequests.at(-1)?.toolNames).toContain(LOOKUP_ROWS.name);
			const mirror = mirrorOf(AgentRegistry.global().get("ColdInWorker")?.session);
			const home = mirror.home;
			await waitFor(() => !mirror.ircWakesPending);
			const lifecycle = AgentLifecycleManager.global();
			await lifecycle.park("ColdInWorker");
			// The subagent's worker exits after the park, and its warm reviver with it.
			const worker = pool.forThread(home);
			if (!worker) throw new Error("home worker missing");
			worker.terminate("worker exited after the park");
			await waitFor(() => pool.forThread(home)?.alive !== true);
			// Between the park and the revive the role moves, and the root's LSP policy is on.
			settings.setModelRole("task", "fake/fake-model-2");
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: rootSession(),
					authStorage,
					modelRegistry,
					settings,
					enableLsp: true,
					eventBus,
				}),
				() => 0,
			);
			const sentAt = server.runRequests.length;
			const receipt = await IrcBus.global().send({
				from: MAIN_AGENT_ID,
				to: "ColdInWorker",
				body: "hello from main",
			});
			expect(receipt.outcome).toBe("revived");
			const woken = mirrorOf(AgentRegistry.global().get("ColdInWorker")?.session);
			expect(woken.home).not.toBe(home);
			await waitFor(() => server.runRequests.length > sentAt);
			const [wake] = server.runRequests.slice(sentAt);
			expect(wake?.model).toBe("fake-model");
			expect(wake?.toolNames).toContain(LOOKUP_ROWS.name);
			expect(wake?.toolNames).not.toContain("lsp");
			// Let the wake turn settle before teardown.
			await waitFor(() => !woken.isStreaming && !woken.ircWakesPending);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"a cold revive of a subagent whose live parent is homed in a worker serves the tools the parent's kernel defines",
		async () => {
			const warnings: string[] = [];
			cleanups.push(
				logger.registerLogSink(event => {
					if (event.level === "warn") warnings.push(event.message);
				}),
			);
			// The parent runs in a worker and defines `parent_lookup` in its JavaScript kernel; it stays live there.
			const parentAgent: AgentDefinition = { ...AGENT, tools: ["read", "bash", "eval"] };
			const parentRun = await runSubprocess(runOptions("KernelParent", DEFINE_TOOL_TASK, { agent: parentAgent }));
			expect(parentRun.exitCode).toBe(0);
			const parent = mirrorOf(AgentRegistry.global().get("KernelParent")?.session);
			await waitFor(() => !parent.ircWakesPending);
			// Its child carries the tool's descriptor in its spawn spec.
			const customTools = createEvalCustomTools({ settings } as unknown as ToolSession, [PARENT_LOOKUP]);
			const childRun = await runSubprocess(
				runOptions("KernelChild", "ping", { customTools, parentAgentId: "KernelParent" }),
			);
			expect(childRun.output).toBe("pong");
			expect(server.runRequests.at(-1)?.toolNames).toContain(PARENT_LOOKUP.name);
			const child = mirrorOf(AgentRegistry.global().get("KernelChild")?.session);
			await waitFor(() => !child.ircWakesPending);
			// Killed, the child has no warm reviver; its parent lives on in its worker.
			const lifecycle = AgentLifecycleManager.global();
			expect(await lifecycle.release("KernelChild", undefined, { tombstone: true })).toBe(true);
			expect(AgentRegistry.global().get("KernelChild")?.status).toBe("aborted");
			expect(AgentRegistry.global().get("KernelParent")?.session).toBe(parent);
			expect(pool.forThread(parent.home)?.alive).toBe(true);
			lifecycle.setPersistedSubagentReviverFactory(
				createPersistedSubagentReviverFactory({
					session: rootSession(),
					authStorage,
					modelRegistry,
					settings,
					enableLsp: false,
					eventBus,
				}),
				() => 0,
			);
			const resultsBefore = server.toolResults.length;
			const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: "KernelChild", body: CALL_TOOL_TASK });
			expect(receipt.outcome).toBe("revived");
			const woken = mirrorOf(AgentRegistry.global().get("KernelChild")?.session);
			await waitFor(() => server.toolResults.length > resultsBefore);
			// The revived child's call reached the parent's kernel, which answered it.
			expect(server.toolResults.slice(resultsBefore).join("\n")).toContain(`${KERNEL_ANSWER}:a`);
			expect(warnings.filter(message => message.includes("no live kernel defines"))).toEqual([]);
			// Let the wake turn settle before teardown.
			await waitFor(() => !woken.isStreaming && !woken.ircWakesPending);
		},
		TEST_TIMEOUT_MS,
	);
});
