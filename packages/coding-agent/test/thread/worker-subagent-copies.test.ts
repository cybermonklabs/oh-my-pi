/**
 * How many copies of a worker subagent's context main and its worker hold (INFRA-5582 parts 2 to 5, plan D96).
 * A real child `AgentSession` homed on a pooled worker (the direct-module entry, wrapped by the heap fixture),
 * watched from main as a focused view watches it, runs bash calls that each print a text of its own, against a
 * scripted OpenAI-compatible server. Near the end of its run a heap snapshot of each thread counts the copies of
 * those texts; once it is parked and its worker has stopped, main's snapshot shows what main keeps of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, prompt, removeWithRetries } from "@oh-my-pi/pi-utils";
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

	async writeModelsYml(agentDir: string): Promise<string> {
		const file = path.join(agentDir, "models.yml");
		await Bun.write(
			file,
			[
				"providers:",
				"  fake:",
				`    baseUrl: http://127.0.0.1:${this.#server.port}/v1`,
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

/** Poll a condition fed by another thread; waits on the condition itself, never a guessed duration. */
async function waitFor(check: () => boolean, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

/** Ask the worker `threadId` (through the heap fixture) for a heap snapshot of its thread. */
async function workerSnapshot(threadId: string, file: string): Promise<V8HeapSnapshot> {
	const channel = new BroadcastChannel(HEAP_CHANNEL);
	try {
		const written = Promise.withResolvers<void>();
		channel.onmessage = event => {
			const data: Partial<SubagentHeapWritten> | null = typeof event.data === "object" ? event.data : null;
			if (data?.written === file) written.resolve();
		};
		const request: SubagentHeapRequest = { path: file, threadId };
		channel.postMessage(request);
		await written.promise;
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

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: CopiesModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let jobs: AsyncJobManager;

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
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-worker-subagent-copies-"));
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

	server = new CopiesModelServer();
	const modelsPath = await server.writeModelsYml(agentDir);
	authStorage = createInMemoryAuthStorage();
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
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	// Every run goes to the one worker, which stops soon after its last session is gone.
	pool = new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs: 300,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000, entry: new URL("../fixtures/subagent-heap-worker.ts", import.meta.url) },
	});
	setSubagentWorkerPoolForTests(pool);
});

afterEach(async () => {
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
		authStorage,
		modelRegistry,
		costGate: new CostGate(settings, 0, () => {}),
		asyncJobManager: jobs,
		eventBus: new EventBus(),
		artifactsDir: path.join(root, "artifacts"),
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

/**
 * The run, watched from main as a focused view watches it, with both heaps read near its end (every result in,
 * the final model call in flight). Its own frame holds the mirror, so nothing here keeps it once it returns.
 */
async function runWatched(): Promise<WatchedRun> {
	const running = runSubprocess(runOptions());
	await waitFor(() => AgentRegistry.global().get(AGENT_ID)?.session instanceof RemoteAgentSession);
	const mirror = AgentRegistry.global().get(AGENT_ID)?.session;
	if (!(mirror instanceof RemoteAgentSession)) throw new Error("expected a worker-homed session mirror on main");
	const worker = pool.forThread(mirror.home);
	if (!worker) throw new Error("the child's worker is not in the pool");
	const unwatch = mirror.subscribe(() => {});

	// The final turn is held only if the run reaches it: a run that ends or fails first fails the test now.
	const resultLengths = await Promise.race([
		server.finalHeld(),
		running.then(result => {
			throw new Error(
				`The run ended (exit ${result.exitCode}) before its final model call: ${result.error ?? result.output}`,
			);
		}),
	]);
	// Wait until the mirror holds every result, in its messages and (watched) in its entries.
	await waitFor(
		() =>
			mirror.messages.filter(message => message.role === "toolResult").length === RESULTS &&
			mirror.sessionManager
				.getEntries()
				.filter(entry => entry.type === "message" && entry.message.role === "toolResult").length === RESULTS,
	);
	await collectGarbage();
	const main = payloadCopies("main", new HeapGraph(takeV8HeapSnapshot()));
	const file = path.join(root, "worker.heapsnapshot");
	const inWorker = payloadCopies("worker", new HeapGraph(await workerSnapshot(worker.threadId, file)));

	unwatch();
	server.release();
	const result = await running;
	return { worker, output: result.output, resultLengths, copies: [main, inWorker] };
}

describe("copies of a worker subagent's context", () => {
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
			await waitFor(() => AgentRegistry.global().get(AGENT_ID)?.status === "parked");
			await waitFor(() => !run.worker.alive);
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
