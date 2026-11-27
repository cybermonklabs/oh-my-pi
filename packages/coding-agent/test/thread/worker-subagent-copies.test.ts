/**
 * How many copies of a worker subagent's context main and its worker hold (INFRA-5582 parts 2 to 5, plan D96).
 * A real child `AgentSession` homed on a pooled worker (the direct-module entry, wrapped by the heap fixture),
 * watched from main as a focused view watches it, runs bash calls that each print a text of its own, against a
 * scripted OpenAI-compatible server. Near the end of its run a heap snapshot of each thread counts the copies of
 * those texts; once it is parked and its worker has stopped, main's snapshot shows what main keeps of it. Each wait
 * of the run has a named deadline; the last cases check those deadlines and the test's own setup and teardown.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, getAgentDir, prompt, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { type ExecutorOptions, runSubprocess } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import {
	type SubagentWorker,
	SubagentWorkerPool,
	setSubagentWorkerPoolForTests,
} from "../../src/thread/subagent-worker";
import { EventBus } from "../../src/utils/event-bus";
import type { SubagentHeapRequest, SubagentHeapWritten } from "../fixtures/subagent-heap-hook";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	collectGarbage,
	HeapGraph,
	parseV8HeapSnapshot,
	takeV8HeapSnapshot,
	type V8HeapSnapshot,
} from "../helpers/heap-snapshot";
import agentPromptTemplate from "./fixtures/worker-subagent-copies-agent.md" with { type: "text" };

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const TEST_TIMEOUT_MS = 300_000;
const SCRIPT_ID = Bun.randomUUIDv7("hex");
/** In the routed agent's system prompt only, so a request without it is never the run's own turn. */
const AGENT_MARKER = `omp-test-agent-${SCRIPT_ID}`;
const TASK = `omp-test-copies-${SCRIPT_ID}`;
const AGENT_ID = "CopiesProbe";
/** The run's bash calls; each prints a text no other call prints. */
const RESULTS = 20;
/** Lines of each printed text: 512 lines of 80 characters and a newline, 40.5 KiB. */
const LINES = 512;
const LINE_CHARS = 80;
/** Bytes of the run's printed texts together: one copy of the context this test counts. */
const CONTEXT_BYTES = RESULTS * LINES * (LINE_CHARS + 1);
/** "A subagent that is not yet parked holds at most five copies of its context." */
const MAX_COPIES = 5;
/**
 * At least this many copies in each heap while the subagent still runs: the worker runs on the context and main
 * mirrors it, so a heap that counts fewer is a snapshot search that missed the payload, not a heap without it.
 */
const MIN_HEAP_COPIES = 1;
/** Every line of every printed text starts with `P<seed>:`; the test builds that marker only to search a snapshot. */
const PAYLOAD_SEED = crypto.randomBytes(8).toString("hex");
/** Named in `test/fixtures/subagent-heap-hook.ts`, which listens on it in each worker. */
const HEAP_CHANNEL = "omp-test-subagent-heap";

// Deadlines of a run's steps, each well inside TEST_TIMEOUT_MS: a run that stalls fails at the step it stalled in,
// named in the error, rather than at the test's timeout.
/** For the run to put its session mirror on main. */
const MIRROR_STARTUP_MS = 60_000;
/** For the run to send its final model request, which the server holds. */
const FINAL_REQUEST_MS = 150_000;
/** For a worker to write the heap snapshot it was asked for, and say so. */
const SNAPSHOT_REPLY_MS = 60_000;

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

function payloadFile(index: number): string {
	return `payload-${String(index).padStart(2, "0")}.txt`;
}

/** Write the texts the run's bash calls print; none of them stays referenced here. */
async function writePayloads(dir: string): Promise<void> {
	for (let index = 0; index < RESULTS; index++) {
		const lines: string[] = [];
		for (let line = 0; line < LINES; line++) {
			const head = `P${PAYLOAD_SEED}:${index}:${line}:`;
			lines.push(
				head +
					crypto
						.randomBytes(LINE_CHARS)
						.toString("base64url")
						.slice(0, LINE_CHARS - head.length),
			);
		}
		await Bun.write(path.join(dir, payloadFile(index)), `${lines.join("\n")}\n`);
	}
}

type Reply = { text: string } | { callId: string; command: string };

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
							id: reply.callId,
							type: "function",
							function: { name: "bash", arguments: JSON.stringify({ command: reply.command }) },
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

/** What one request asks of the scripted model, read from its body so the body is not kept while a reply waits. */
type Turn = { kind: "side" } | { kind: "call"; index: number } | { kind: "final"; resultLengths: number[] };

/**
 * Scripted model. The routed agent's own turns (their system prompt carries {@link AGENT_MARKER}) call bash on
 * the next payload file until {@link RESULTS} results are in; the turn after the last one is held until
 * {@link release}, so the test reads both heaps near the end of the run. Everything else → `pong`.
 */
class CopiesModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #finalHeld = Promise.withResolvers<number[]>();
	readonly #release = Promise.withResolvers<void>();

	constructor() {
		// No idle timeout: the held final response may wait on slow heap snapshots and walks for well over Bun's
		// default of 10 seconds, and a reset connection would end the run before the test releases it.
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			fetch: request => this.#fetch(request),
		});
	}

	/** Resolves, with the text length of each tool result the model received, once the final turn is held. */
	finalHeld(): Promise<number[]> {
		return this.#finalHeld.promise;
	}

	release(): void {
		this.#release.resolve();
	}

	/** The OpenAI-compatible base URL of the scripted provider. */
	get baseUrl(): string {
		return `http://127.0.0.1:${this.#server.port}/v1`;
	}

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: ${this.baseUrl}`,
				"    auth: none",
				"    api: openai-completions",
				"    models:",
				"      - id: fake-model",
				"        name: Fake Model",
				"        reasoning: false",
				"        cost: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }",
				"",
			].join("\n"),
		);
		return file;
	}

	stop(): void {
		this.#release.resolve();
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
		}
		if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
		const turn = await this.#turn(request);
		let reply: Reply = { text: "pong" };
		if (turn.kind === "call") {
			reply = { callId: `call_${turn.index}`, command: `cat ${payloadFile(turn.index)}` };
		} else if (turn.kind === "final") {
			this.#finalHeld.resolve(turn.resultLengths);
			await this.#release.promise;
			reply = { text: "copied" };
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
	}

	async #turn(request: Request): Promise<Turn> {
		const body: unknown = await request.json();
		const rawMessages: unknown =
			typeof body === "object" && body !== null ? Reflect.get(body, "messages") : undefined;
		const messages = Array.isArray(rawMessages) ? rawMessages.filter(isChatMessage) : [];
		const systemText = messages
			.filter(message => message.role === "system" || message.role === "developer")
			.map(message => messageText(message.content))
			.join("\n");
		const userText = messages
			.filter(message => message.role === "user")
			.map(message => messageText(message.content))
			.join("\n");
		if (!systemText.includes(AGENT_MARKER) || !userText.includes(TASK)) return { kind: "side" };
		const results = messages.filter(message => message.role === "tool");
		if (results.length < RESULTS) return { kind: "call", index: results.length };
		return { kind: "final", resultLengths: results.map(message => messageText(message.content).length) };
	}
}

/**
 * `wait(signal)` under a deadline: rejects with an error naming `label` once `ms` passed, and aborts `signal` once
 * the wait settled or missed its deadline, so a wait that polls stops polling.
 */
async function withDeadline<T>(label: string, ms: number, wait: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const done = new AbortController();
	try {
		return await withTimeout(wait(done.signal), ms, `${label}: missed its ${ms} ms deadline`);
	} finally {
		done.abort();
	}
}

/**
 * The first value `find` returns, polled every 10 ms until `signal` aborts. `find` reads what another thread feeds,
 * so this waits on the value itself, never a guessed duration.
 */
async function poll<T>(find: () => T | undefined, signal: AbortSignal): Promise<T> {
	for (;;) {
		const found = find();
		if (found !== undefined) return found;
		signal.throwIfAborted();
		await Bun.sleep(10);
	}
}

/** Poll a condition fed by another thread until it holds; fails, naming `label`, after `timeoutMs`. */
async function waitFor(label: string, check: () => boolean, timeoutMs = 60_000): Promise<void> {
	await withDeadline(label, timeoutMs, signal => poll(() => (check() ? true : undefined), signal));
}

/** Ask the worker `threadId` (through the heap fixture) for a heap snapshot of its thread, replied within `replyMs`. */
async function workerSnapshot(threadId: string, file: string, replyMs = SNAPSHOT_REPLY_MS): Promise<V8HeapSnapshot> {
	const channel = new BroadcastChannel(HEAP_CHANNEL);
	try {
		const written = Promise.withResolvers<void>();
		channel.onmessage = event => {
			const data: Partial<SubagentHeapWritten> | null = typeof event.data === "object" ? event.data : null;
			if (data?.written === file) written.resolve();
		};
		const request: SubagentHeapRequest = { path: file, threadId };
		channel.postMessage(request);
		await withDeadline(`snapshot reply from worker ${threadId}`, replyMs, () => written.promise);
	} finally {
		channel.close();
	}
	try {
		return parseV8HeapSnapshot(JSON.parse(await Bun.file(file).text()));
	} finally {
		await fs.rm(file, { force: true });
	}
}

/** Object kinds a retainer path names its holder by; anything else is a plain container on the way. */
function isNamedHolder(graph: HeapGraph, node: number): boolean {
	const type = graph.type(node);
	if (type === "closure") return true;
	if (type !== "object") return false;
	const name = graph.name(node);
	return name !== "" && name !== "Object" && name !== "Array" && !name.startsWith("system /");
}

interface ThreadCopies {
	readonly thread: string;
	readonly copies: number;
	/** Copies by retainer path, most first. */
	readonly holders: ReadonlyArray<{ readonly holder: string; readonly copies: number }>;
}

/**
 * The copies of the run's printed texts in `graph`: the characters of every distinct string node whose text
 * (its first 1024 characters, all the snapshot keeps) holds the payload marker, over {@link CONTEXT_BYTES}. A
 * string two holders share is one node, counted once; a piece of a text counts for its share. A snapshot with no
 * string text to search is an error, never zero copies.
 */
function payloadCopies(thread: string, graph: HeapGraph): ThreadCopies {
	const marker = `P${PAYLOAD_SEED}:`;
	let searched = 0;
	const nodes = graph.stringNodes(text => {
		if (text !== "") searched++;
		return text.includes(marker);
	});
	if (searched === 0) throw new Error(`${thread}: the heap snapshot has no string text to search for the payload`);
	const paths = graph.retainerPaths(nodes, node => isNamedHolder(graph, node));
	const byHolder = new Map<string, number>();
	let bytes = 0;
	for (const node of nodes) {
		const size = graph.selfSize(node);
		bytes += size;
		const holder = paths.get(node) ?? "?";
		byHolder.set(holder, (byHolder.get(holder) ?? 0) + size);
	}
	return {
		thread,
		copies: bytes / CONTEXT_BYTES,
		holders: [...byHolder]
			.map(([holder, held]) => ({ holder, copies: held / CONTEXT_BYTES }))
			.sort((a, b) => b.copies - a.copies),
	};
}

/** `title`, the copies of all `threads` together, then each thread's copies by holder. */
function copiesReport(title: string, threads: readonly ThreadCopies[]): string {
	const total = threads.reduce((sum, thread) => sum + thread.copies, 0);
	const lines = [`${title}: ${total.toFixed(2)} copies of the worker subagent's context`];
	for (const thread of threads) {
		lines.push(`  ${thread.thread}: ${thread.copies.toFixed(2)}`);
		for (const { holder, copies } of thread.holders) lines.push(`    ${copies.toFixed(2)}  ${holder}`);
	}
	return lines.join("\n");
}

/** Object kinds whose edges hold a run's behaviour or state rather than a record's data. */
function isRunObject(graph: HeapGraph, node: number): boolean {
	const type = graph.type(node);
	if (type === "closure") return true;
	if (type !== "object") return false;
	const name = graph.name(node);
	return name === "Map" || name === "Set" || name === "WeakMap" || name === "WeakSet";
}

/**
 * What main's registry record of the agent reaches as data: its own properties and elements, followed into plain
 * objects and arrays. Accessor pairs (how a minted ref derives `sessionFile` from its data) and object shapes are
 * the record's form, not data it holds, so the walk does not enter them.
 */
function recordRunObjects(graph: HeapGraph, record: number): string[] {
	const reached = graph.reachable(record, node => {
		const type = graph.type(node);
		return type !== "code" && type !== "object shape" && !isRunObject(graph, node);
	});
	return reached
		.filter(node => node !== record && isRunObject(graph, node))
		.map(node => `${graph.type(node)} ${graph.name(node)}`);
}

const AGENT: AgentDefinition = {
	name: "task",
	description: "copies test agent",
	systemPrompt: prompt.render(agentPromptTemplate, { marker: AGENT_MARKER }),
	source: "bundled",
	tools: ["bash"],
};

/** What a test's setup acquired; each is set once acquired, and {@link tearDown} releases exactly those. */
interface Acquired {
	/** Each of {@link ENV_KEYS} as it was before setup changed it. */
	env: Record<string, string | undefined>;
	root: string;
	server: CopiesModelServer;
	authStorage: AuthStorage;
	jobs: AsyncJobManager;
	pool: SubagentWorkerPool;
}

let acquired: Partial<Acquired> = {};
let cwd: string;
let modelRegistry: ModelRegistry;
let settings: Settings;

/** `acquired[key]`, which a run needs setup to have acquired. */
function need<K extends keyof Acquired>(key: K): Acquired[K] {
	const value = acquired[key];
	if (value === undefined) throw new Error(`setup has not acquired ${key}`);
	return value;
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

/**
 * A temp home and work dir holding the payloads, the environment pointed at them, the scripted model server, the
 * job manager and the worker pool, each recorded in {@link acquired} as soon as it is acquired.
 */
async function setUp(): Promise<void> {
	acquired.env = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-subagent-copies-"));
	acquired.root = root;
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(root, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await writePayloads(cwd);
	// Workers read these at start-up, so set them before the pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();

	const server = new CopiesModelServer();
	acquired.server = server;
	const modelsPath = await server.writeModelsYml(agentDir);
	const authStorage = createInMemoryAuthStorage();
	acquired.authStorage = authStorage;
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = Settings.isolated({
		// Parks the child soon after its run, so the test reaches the parked state without a long wait.
		"task.agentIdleTtlMs": 300,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": true,
		modelRoles: { default: MODEL },
	});
	acquired.jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	// Every run goes to the one worker, which stops soon after its last session is gone.
	const pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 300,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000, entry: new URL("../fixtures/subagent-heap-worker.ts", import.meta.url) },
	});
	acquired.pool = pool;
	setSubagentWorkerPoolForTests(pool);
}

/** Run every step, each after the one before even when that one threw; then throw what the steps threw. */
async function runEach(steps: ReadonlyArray<() => unknown>): Promise<void> {
	const errors: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, `${errors.length} teardown steps failed`);
}

/**
 * Release what setup acquired, each on its own, so a cleanup that throws skips none of the others; then, whatever
 * threw, restore the environment and the directory caches read from it.
 */
async function tearDown(): Promise<void> {
	const { env, root, server, authStorage, jobs, pool } = acquired;
	acquired = {};
	try {
		await runEach([
			() => AgentLifecycleManager.global().dispose(),
			() => setSubagentWorkerPoolForTests(undefined),
			() => pool?.dispose(),
			() => server?.stop(),
			() => jobs?.dispose({ timeoutMs: 1_000 }),
			() => AgentLifecycleManager.resetGlobalForTests(),
			() => AgentRegistry.resetGlobalForTests(),
			() => IrcBus.resetGlobalForTests(),
			() => authStorage?.close(),
			() => AgentStorage.close(),
			() => closeModelCache(),
			() => (root === undefined ? undefined : removeWithRetries(root)),
		]);
	} finally {
		if (env) for (const key of ENV_KEYS) setEnv(key, env[key]);
		__resetDirsFromEnvForTests();
	}
}

function runOptions(): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task: TASK,
		index: 0,
		id: AGENT_ID,
		description: "copies probe",
		modelOverride: MODEL,
		structured: false,
		settings,
		authStorage: need("authStorage"),
		modelRegistry,
		costGate: new CostGate(settings, 0, () => {}),
		asyncJobManager: need("jobs"),
		eventBus: new EventBus(),
		artifactsDir: path.join(need("root"), "artifacts"),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
	};
}

interface WatchedRun {
	readonly worker: SubagentWorker;
	readonly output: string;
	/** The text length of each tool result the model received on its final turn. */
	readonly resultLengths: readonly number[];
	readonly copies: readonly ThreadCopies[];
}

/** How a run ended, as far as a wait it ended reports it. */
type RunEnd = Pick<SingleResult, "exitCode" | "error" | "output">;

/** Rejects once `running` settles: the run was to reach `step` before it ended. */
async function endsBefore(running: Promise<RunEnd>, step: string): Promise<never> {
	const result = await running;
	throw new Error(`The run ended (exit ${result.exitCode}) before ${step}: ${result.error ?? result.output}`);
}

/** The run's session mirror on main, once the run puts it there; a run that ends first fails the wait at once. */
function mirrorStartup(running: Promise<RunEnd>, ms = MIRROR_STARTUP_MS): Promise<RemoteAgentSession> {
	return withDeadline("mirror startup", ms, signal =>
		Promise.race([
			poll(() => {
				const session = AgentRegistry.global().get(AGENT_ID)?.session;
				return session instanceof RemoteAgentSession ? session : undefined;
			}, signal),
			endsBefore(running, "its session mirror appeared on main"),
		]),
	);
}

/**
 * The text length of each tool result the model received, once the server holds the run's final request; a run
 * that ends first fails the wait at once.
 */
function finalRequest(server: CopiesModelServer, running: Promise<RunEnd>, ms = FINAL_REQUEST_MS): Promise<number[]> {
	return withDeadline("final model request", ms, () =>
		Promise.race([server.finalHeld(), endsBefore(running, "its final model call")]),
	);
}

/**
 * The run, watched from main as a focused view watches it, with both heaps read near its end (every result in,
 * the final model call in flight). Its own frame holds the mirror, so nothing here keeps it once it returns.
 */
async function runWatched(): Promise<WatchedRun> {
	const server = need("server");
	const running = runSubprocess(runOptions());
	const mirror = await mirrorStartup(running);
	const worker = need("pool").forThread(mirror.home);
	if (!worker) throw new Error("the child's worker is not in the pool");
	const unwatch = mirror.subscribe(() => {});
	let resultLengths: number[];
	let copies: ThreadCopies[];
	try {
		// The final turn is held only if the run reaches it: a run that ends or fails first fails the test now.
		resultLengths = await finalRequest(server, running);
		// Wait until the mirror holds every result, in its messages and (watched) in its entries.
		await waitFor(
			"every result in the mirror",
			() =>
				mirror.messages.filter(message => message.role === "toolResult").length === RESULTS &&
				mirror.sessionManager
					.getEntries()
					.filter(entry => entry.type === "message" && entry.message.role === "toolResult").length === RESULTS,
		);
		await collectGarbage();
		const main = payloadCopies("main", new HeapGraph(takeV8HeapSnapshot()));
		const file = path.join(need("root"), "worker.heapsnapshot");
		copies = [main, payloadCopies("worker", new HeapGraph(await workerSnapshot(worker.threadId, file)))];
	} finally {
		unwatch();
		server.release();
	}
	const result = await running;
	return { worker, output: result.output, resultLengths, copies };
}

describe("copies of a worker subagent's context", () => {
	beforeEach(setUp);
	afterEach(tearDown);

	it(
		"holds at most five copies of a worker subagent's context across both heaps, and only its registry record once parked and its worker stopped",
		async () => {
			// If this regresses, every worker subagent a session runs holds its tool output many times over across
			// main and its worker while it runs, or main keeps its run after it parked and its worker stopped.
			const run = await runWatched();
			expect(run.output).toBe("copied");
			// Every result reached the model whole, so a copy counted below is a copy of all of them.
			expect(run.resultLengths.filter(length => length >= LINES * (LINE_CHARS + 1) - 1)).toHaveLength(RESULTS);

			// Parked, and its worker stopped.
			await waitFor("the agent parked", () => AgentRegistry.global().get(AGENT_ID)?.status === "parked");
			await waitFor("its worker stopped", () => !run.worker.alive);
			await run.worker.ended;
			await collectGarbage();
			const parked = new HeapGraph(takeV8HeapSnapshot());
			const left = payloadCopies("main, parked and its worker stopped", parked);
			const records = parked
				.objectsWithStringProperty("id", AGENT_ID)
				.filter(node => parked.edges(node).some(edge => edge.type === "property" && edge.name === "displayName"));

			const running = run.copies.reduce((sum, thread) => sum + thread.copies, 0);
			const report = [
				copiesReport(
					`near the end of its run, in both heaps (at most ${MAX_COPIES}, at least ${MIN_HEAP_COPIES} in each)`,
					run.copies,
				),
				copiesReport("parked and its worker stopped, in main (none)", [left]),
			].join("\n");
			// Printed on every run, pass or fail, so a run's record carries the copies it counted.
			console.error(`two-heap copies report:\n${report}`);
			expect(
				{
					runningHeapsUnderOneCopy: run.copies
						.filter(thread => thread.copies < MIN_HEAP_COPIES)
						.map(thread => `${thread.thread}: ${thread.copies.toFixed(2)}`),
					runningCopiesAtMostFive: running <= MAX_COPIES,
					parkedCopies: left.copies,
					records: records.length,
					recordRunObjects: records.flatMap(record => recordRunObjects(parked, record)),
				},
				report,
			).toEqual({
				runningHeapsUnderOneCopy: [],
				runningCopiesAtMostFive: true,
				parkedCopies: 0,
				records: 1,
				recordRunObjects: [],
			});
		},
		TEST_TIMEOUT_MS,
	);
});

/** Whether something still accepts connections at `url`: it answers, or it refuses the connection. */
async function listening(url: string): Promise<boolean> {
	try {
		const response = await withTimeout(fetch(url), 5_000, `request to ${url}: no answer within 5000 ms`);
		await response.body?.cancel();
		return true;
	} catch (error) {
		if (error instanceof Error && Reflect.get(error, "code") === "ECONNREFUSED") return false;
		throw error;
	}
}

/** Each of {@link ENV_KEYS} as `process.env` and `Bun.env` hold it now. */
function envNow(): Record<string, Array<string | undefined>> {
	return Object.fromEntries(ENV_KEYS.map(key => [key, [process.env[key], Bun.env[key]]]));
}

/** Far below every deadline of a real run: a wait that takes longer did not fail at once. */
const PROMPT_MS = 5_000;

/** The message `wait` rejected with (or `resolved`), and whether it settled within {@link PROMPT_MS}. */
async function outcome(wait: Promise<unknown>): Promise<{ message: string; prompt: boolean }> {
	const start = performance.now();
	const message = await wait.then(
		() => "resolved",
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	return { message, prompt: performance.now() - start < PROMPT_MS };
}

describe("the copies test's setup, teardown and deadlines", () => {
	afterEach(tearDown);

	it("stops its model server, removes its temp dir and restores the environment when setup fails part way and a teardown step throws", async () => {
		// If this regresses, a setup that fails after it changed the environment, or a teardown step that throws,
		// leaves this file's model server listening, its temp dir on disk, and HOME and the agent dir pointing into
		// that dir for every later test file in the process.
		const envBefore = envNow();
		const agentDirBefore = getAgentDir();
		const refresh = spyOn(ModelRegistry.prototype, "refresh").mockRejectedValue(
			new Error("refresh failed in the control"),
		);
		try {
			await expect(setUp()).rejects.toThrow("refresh failed in the control");
		} finally {
			refresh.mockRestore();
		}
		const { root, server } = acquired;
		if (root === undefined || server === undefined) {
			throw new Error("setup failed before it acquired its temp dir and model server");
		}
		const modelsUrl = `${server.baseUrl}/models`;
		const during = {
			pool: acquired.pool !== undefined,
			listening: await listening(modelsUrl),
			rootExists: await fs.exists(root),
			home: process.env.HOME,
			agentDirInRoot: getAgentDir().startsWith(root),
		};
		// Teardown's first step throws; every later step still runs.
		const dispose = spyOn(AgentLifecycleManager.prototype, "dispose").mockRejectedValue(
			new Error("dispose failed in the control"),
		);
		try {
			await expect(tearDown()).rejects.toThrow("dispose failed in the control");
		} finally {
			dispose.mockRestore();
		}
		expect({
			during,
			after: {
				listening: await listening(modelsUrl),
				rootExists: await fs.exists(root),
				env: envNow(),
				agentDir: getAgentDir(),
			},
		}).toEqual({
			during: {
				pool: false,
				listening: true,
				rootExists: true,
				home: path.join(root, "home"),
				agentDirInRoot: true,
			},
			after: { listening: false, rootExists: false, env: envBefore, agentDir: agentDirBefore },
		});
	});

	it("fails the wait for the run's mirror or its final request at once, naming the step, when the run ends first", async () => {
		// If this regresses, a heap test whose run fails before its mirror or its final request waits out that step's
		// deadline or the test's timeout, and then fails without the run's own error.
		const server = new CopiesModelServer();
		const ended = Promise.resolve({ exitCode: 1, error: "the model is not found", output: "" });
		try {
			expect({
				mirror: await outcome(mirrorStartup(ended)),
				finalRequest: await outcome(finalRequest(server, ended)),
			}).toEqual({
				mirror: {
					message: "The run ended (exit 1) before its session mirror appeared on main: the model is not found",
					prompt: true,
				},
				finalRequest: {
					message: "The run ended (exit 1) before its final model call: the model is not found",
					prompt: true,
				},
			});
		} finally {
			server.stop();
		}
	});

	it("rejects, naming the step, once the mirror, the final request or a worker's snapshot reply misses its deadline", async () => {
		// If this regresses, a heap test whose run stalls before its mirror or its final request, or whose worker
		// never answers a snapshot request, hangs until the test's five-minute timeout without naming the step.
		const server = new CopiesModelServer();
		const stalled = Promise.withResolvers<RunEnd>().promise;
		const file = path.join(os.tmpdir(), `omp-worker-subagent-copies-${SCRIPT_ID}.heapsnapshot`);
		// Real 50 ms deadlines: these are the heavy test's own waits, and what they wait on (another thread, a
		// broadcast channel, a server) runs on the real clock, not on fake timers.
		try {
			expect({
				mirror: await outcome(mirrorStartup(stalled, 50)),
				finalRequest: await outcome(finalRequest(server, stalled, 50)),
				snapshotReply: await outcome(workerSnapshot("no-such-thread", file, 50)),
			}).toEqual({
				mirror: { message: "mirror startup: missed its 50 ms deadline", prompt: true },
				finalRequest: { message: "final model request: missed its 50 ms deadline", prompt: true },
				snapshotReply: {
					message: "snapshot reply from worker no-such-thread: missed its 50 ms deadline",
					prompt: true,
				},
			});
		} finally {
			server.stop();
		}
	});
});
