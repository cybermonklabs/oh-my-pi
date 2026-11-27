/**
 * What a worker-homed task subagent leaves in each thread once it parks while its worker still hosts another
 * subagent, and how its adoption lives on across that worker's life (INFRA-5582 part 9, plan D1, check
 * c-busy-worker-park). Real child `AgentSession`s homed on one pooled worker (the direct-module entry, wrapped by
 * a test fixture), watched from main as a focused view watches them, against a scripted OpenAI-compatible server.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import type { AuthStorage } from "../../src/session/auth-storage";
import { CostGate } from "../../src/session/cost-gate";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "../../src/task/executor";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
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

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL = "fake/fake-model";
const TEST_TIMEOUT_MS = 300_000;
const SCRIPT_ID = Bun.randomUUIDv7("hex");
/** In the routed agent's system prompt only, so a request without it is never a subagent's own turn. */
const AGENT_MARKER = `omp-test-agent-${SCRIPT_ID}`;
/** A subagent's turn, by the text its last user message carries: its task, or a follow-up. */
const TURN_PATTERN = new RegExp(`omp-test-(task|follow-up)-(\\w+)-${SCRIPT_ID}`);
/** The parked subagent's idle time before the lifecycle parks it (check c-busy-worker-park names it). */
const PARK_TTL_MS = 200;
/** How long a test pool's worker that hosts nothing lives on (production: 60 s). */
const IDLE_EXIT_MS = 300;
/** The idle time of the held-revive case's worker, and how long its revive waits on the worker's thread. */
const HELD_IDLE_MS = 1_000;
const HELD_STALL_MS = 3_000;
/** Named in `test/fixtures/subagent-heap-hook.ts`, which listens on it in each worker. */
const HEAP_CHANNEL = "omp-test-subagent-heap";
/** Named in `test/fixtures/subagent-stall-hook.ts`, which listens on it in each worker. */
const STALL_CHANNEL = "omp-test-subagent-stall";

/** The task a subagent named `name` runs; the scripted model answers it with {@link answerOf}. */
function taskOf(name: string): string {
	return `omp-test-task-${name}-${SCRIPT_ID}`;
}

function answerOf(name: string): string {
	return `omp-test-answer-${name}-${SCRIPT_ID}`;
}

/** A follow-up the scripted model answers `remembered <name>` only when the request carries the earlier turn. */
function followUpOf(name: string): string {
	return `omp-test-follow-up-${name}-${SCRIPT_ID}`;
}

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

function chunks(text: string): string {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const frames = [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		{ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
	];
	return `${frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

interface TurnGate {
	readonly held: PromiseWithResolvers<void>;
	readonly open: PromiseWithResolvers<void>;
}

/**
 * Scripted model. A subagent's own turn (its system prompt carries {@link AGENT_MARKER}) is read from its last
 * user message: {@link taskOf}`(name)` → {@link answerOf}`(name)`, held first while a {@link gate} for `name`
 * is set; {@link followUpOf}`(name)` → `remembered <name>` when the request also carries that task and its
 * answer, else `forgot <name>`. Everything else → `pong`.
 */
class ParkModelServer {
	readonly #server: Bun.Server<undefined>;
	readonly #gates = new Map<string, TurnGate>();

	constructor() {
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#fetch(request) });
	}

	/** Hold the next task turn of `name` until `open()`; `held` resolves once that turn waits. */
	gate(name: string): { held: Promise<void>; open: () => void } {
		const gate: TurnGate = { held: Promise.withResolvers<void>(), open: Promise.withResolvers<void>() };
		this.#gates.set(name, gate);
		return { held: gate.held.promise, open: () => gate.open.resolve() };
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
		for (const gate of this.#gates.values()) gate.open.resolve();
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
		const systemText = messages
			.filter(message => message.role === "system" || message.role === "developer")
			.map(message => messageText(message.content))
			.join("\n");
		const lastUser = messageText(messages.findLast(message => message.role === "user")?.content);
		const turn = systemText.includes(AGENT_MARKER) ? TURN_PATTERN.exec(lastUser) : null;
		let reply = "pong";
		if (turn?.[1] === "follow-up") {
			const name = turn[2]!;
			const said = (role: string, text: string) =>
				messages.some(message => message.role === role && messageText(message.content).includes(text));
			reply =
				said("user", taskOf(name)) && said("assistant", answerOf(name)) ? `remembered ${name}` : `forgot ${name}`;
		} else if (turn?.[1] === "task") {
			const name = turn[2]!;
			const gate = this.#gates.get(name);
			if (gate) {
				this.#gates.delete(name);
				gate.held.resolve();
				await gate.open.promise;
			}
			reply = answerOf(name);
		}
		return new Response(chunks(reply), { headers: { "content-type": "text/event-stream" } });
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

function mirrorOf(id: string): RemoteAgentSession {
	const session = AgentRegistry.global().get(id)?.session;
	if (!(session instanceof RemoteAgentSession)) throw new Error(`expected a worker-homed session mirror of ${id}`);
	return session;
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

/** Block the one live worker's thread for `ms` (see the stall hook); resolves once it is blocked. */
async function stallWorker(ms: number): Promise<void> {
	const channel = new BroadcastChannel(STALL_CHANNEL);
	try {
		const stalled = Promise.withResolvers<void>();
		channel.onmessage = event => {
			if (event.data === "stalled") stalled.resolve();
		};
		channel.postMessage(ms);
		await stalled.promise;
	} finally {
		channel.close();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The walk: what a heap holds for the parked subagent
//
// Bun's V8-format snapshot names a closure by its function's name (`Function` or `AsyncFunction` when it has
// none), keeps its scope as an internal edge to a `system / JS…Environment` object, and that scope's variables as
// context edges. It records no edge from a Map or Set to its entries: an object only a table holds has no
// retainer in it, so a table is found only from what holds it.
// ─────────────────────────────────────────────────────────────────────────────

/** A function body's or block's scope object (a module's is a `system / JSModuleEnvironment`). */
const RUN_SCOPE = "system / JSLexicalEnvironment";

/**
 * A call's scope: the variables a call keeps for the closures it made. A class body's scope (private names only)
 * is shared by the class's every method, as a module's scope is by every module-level function.
 */
function isRunScope(graph: HeapGraph, node: number | undefined): boolean {
	if (node === undefined || graph.type(node) !== "object" || graph.name(node) !== RUN_SCOPE) return false;
	const variables = graph.edges(node).filter(edge => edge.type === "context");
	return variables.length === 0 || variables.some(edge => !edge.name.startsWith("#") && edge.name !== "privateBrand");
}

/** A plain object or array: data, walked through. */
function isContainer(graph: HeapGraph, node: number): boolean {
	const name = graph.name(node);
	return graph.type(node) === "object" && (name === "Object" || name === "Array");
}

function isTable(graph: HeapGraph, node: number): boolean {
	const name = graph.name(node);
	return (
		graph.type(node) === "object" && (name === "Map" || name === "Set" || name === "WeakMap" || name === "WeakSet")
	);
}

/** The scope `closure` runs in: a call's, a module's, or the global one. */
function scopeOf(graph: HeapGraph, closure: number): number | undefined {
	return graph
		.edges(closure)
		.find(edge => edge.type === "internal" && /^system \/ JS\w*Environment$/.test(graph.name(edge.to)))?.to;
}

/** A closure a call made, which keeps that call's scope; a module-level function is made by no run. */
function isRunClosure(graph: HeapGraph, node: number): boolean {
	return graph.type(node) === "closure" && isRunScope(graph, scopeOf(graph, node));
}

/** Object kinds a retainer path names its holder by; anything else is a plain container on the way. */
function isNamedHolder(graph: HeapGraph, node: number): boolean {
	const type = graph.type(node);
	if (type === "closure") return true;
	if (type !== "object") return false;
	const name = graph.name(node);
	return name !== "" && name !== "Object" && name !== "Array" && !name.startsWith("system /");
}

/** What a heap holds for the parked subagent: the objects that are its own data, each with a label. */
interface ParkedAnchors {
	readonly labels: Map<number, string>;
	/**
	 * Objects with the fields of a warm revive state: `storage` and `parentSettings`, or the release's `storage`,
	 * `live`, `cache` and `specDigest`.
	 */
	readonly reviveStates: number;
}

/**
 * The parked subagent's own objects in `graph`: its id's strings, every object with a property whose value is
 * its id (its registry record, any entry naming it), every object with the fields of a warm revive state (the
 * worker hosts no other kept-alive subagent, so each is its), and every plain object holding one of those by a
 * property (its adoption, which holds its record as `ref`).
 */
function parkedAnchors(graph: HeapGraph, agentId: string): ParkedAnchors {
	const labels = new Map<number, string>();
	const ids = new Set(graph.stringNodes(text => text === agentId));
	for (const id of ids) labels.set(id, `"${agentId}"`);
	let reviveStates = 0;
	for (let node = 0; node < graph.nodeCount; node++) {
		if (graph.type(node) !== "object") continue;
		const edges = graph.edges(node).filter(edge => edge.type === "property");
		const naming = edges.find(edge => ids.has(edge.to));
		if (naming) labels.set(node, `${graph.name(node)}{${naming.name}: "${agentId}"}`);
		const fields = new Set(edges.map(edge => edge.name));
		const reviveState =
			fields.has("storage") &&
			(fields.has("parentSettings") || (fields.has("live") && fields.has("cache") && fields.has("specDigest")));
		if (reviveState) {
			labels.set(node, "WarmReviveState");
			reviveStates++;
		}
	}
	const objects = new Set([...labels.keys()].filter(node => !ids.has(node)));
	for (const [target, retainers] of graph.retainers(objects)) {
		for (const { from, type, name } of retainers) {
			if (type === "property" && isContainer(graph, from) && !labels.has(from)) {
				labels.set(from, `${graph.name(from)}{${name}: ${labels.get(target)}}`);
			}
		}
	}
	return { labels, reviveStates };
}

/** A Function, AsyncFunction, scope or Map a heap holds for the parked subagent. */
interface ParkedHolder {
	readonly node: number;
	/** How it holds the parked subagent's objects, or how they hold it. */
	readonly via: string;
}

/** `node` as a holder's kind: a closure's name, a scope with its variables, or a table's class. */
function holderKind(graph: HeapGraph, node: number): string {
	if (!isRunScope(graph, node)) return graph.name(node);
	const variables = graph
		.edges(node)
		.filter(edge => edge.type === "context")
		.map(edge => edge.name);
	return `JSLexicalEnvironment{${variables.join(", ")}}`;
}

/** One step of a path, by the edge's kind: `.property`, `{variable}`, `[]` for an element, `<scope>` otherwise. */
function edgeStep(type: string, name: string): string {
	return type === "property" ? `.${name}` : type === "context" ? `{${name}}` : type === "element" ? "[]" : "<scope>";
}

/**
 * The closures and scopes that capture the parked subagent's objects: every call scope whose variables reach one
 * (directly, or through plain objects, as `{ reviver, state }` holds a revive state), its inner scopes, and every
 * closure that runs in one of them. Module and global scopes hold module-level names, made by no run.
 */
function capturingHolders(graph: HeapGraph, labels: ReadonlyMap<number, string>): ParkedHolder[] {
	const found: ParkedHolder[] = [];
	const seen = new Set(labels.keys());
	const reaches = new Map<number, string>(labels);
	let frontier = new Set(labels.keys());
	for (let depth = 0; depth < 4 && frontier.size > 0; depth++) {
		const next = new Set<number>();
		for (const [target, retainers] of graph.retainers(frontier)) {
			for (const { from, type, name } of retainers) {
				if (seen.has(from)) continue;
				const held = `${edgeStep(type, name)} → ${reaches.get(target)}`;
				if (isRunScope(graph, from) || isRunClosure(graph, from)) {
					seen.add(from);
					found.push({ node: from, via: `captures ${held}` });
					reaches.set(from, holderKind(graph, from));
					// A scope's closures and inner scopes keep it; a closure's holders are found by the other walk.
					if (isRunScope(graph, from)) next.add(from);
				} else if (isContainer(graph, from) && depth < 2) {
					seen.add(from);
					reaches.set(from, `${graph.name(from)}${held}`);
					next.add(from);
				}
			}
		}
		frontier = next;
	}
	return found;
}

/**
 * The closures, scopes and tables the parked subagent's objects hold: walked from them through plain objects and
 * arrays, into each closure a run made and the scopes it keeps, but not into an instance of a named class (a
 * shared service the subagent references), a table, or a module-level function (made by no run).
 */
function heldHolders(graph: HeapGraph, labels: ReadonlyMap<number, string>): ParkedHolder[] {
	const found: ParkedHolder[] = [];
	const seen = new Set(labels.keys());
	const queue = [...labels].map(([node, path]) => ({ node, path }));
	for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
		for (const edge of graph.edges(next.node)) {
			if (seen.has(edge.to)) continue;
			const intoScope = edge.type === "internal" && isRunScope(graph, edge.to);
			if (edge.type !== "property" && edge.type !== "element" && edge.type !== "context" && !intoScope) continue;
			const to = edge.to;
			const path = `${next.path}${edgeStep(edge.type, edge.name)}`;
			if (isRunClosure(graph, to) || isRunScope(graph, to)) {
				seen.add(to);
				found.push({ node: to, via: `held by ${path}` });
				queue.push({ node: to, path: holderKind(graph, to) });
			} else if (isTable(graph, to)) {
				seen.add(to);
				found.push({ node: to, via: `held by ${path}` });
			} else if (isContainer(graph, to)) {
				seen.add(to);
				queue.push({ node: to, path });
			}
		}
	}
	return found;
}

/** What one heap holds for the parked subagent: each holder's kind, how it is held, and what it reaches. */
interface ThreadWalk {
	readonly thread: string;
	readonly reviveStates: number;
	readonly holders: readonly string[];
}

function walkParked(thread: string, graph: HeapGraph, agentId: string): ThreadWalk {
	const { labels, reviveStates } = parkedAnchors(graph, agentId);
	const byNode = new Map<number, string>();
	for (const holder of [...capturingHolders(graph, labels), ...heldHolders(graph, labels)]) {
		byNode.set(holder.node, byNode.has(holder.node) ? `${byNode.get(holder.node)}; ${holder.via}` : holder.via);
	}
	const paths = graph.retainerPaths(
		[...byNode.keys()],
		node => labels.has(node) || isNamedHolder(graph, node),
		6,
		node => labels.get(node) ?? graph.name(node),
	);
	const holders = [...byNode].map(([node, via]) => `${holderKind(graph, node)} ← ${paths.get(node) ?? "?"} (${via})`);
	return { thread, reviveStates, holders: holders.sort() };
}

function walkReport(walks: readonly ThreadWalk[]): string {
	const lines = [
		"what each heap holds for the parked subagent (none expected), as `kind ← retainer path (how it holds it)`;",
		"a path that starts at `(type name)` starts at an object only a table holds:",
	];
	for (const walk of walks) {
		lines.push(`  ${walk.thread}: ${walk.holders.length} holder(s), ${walk.reviveStates} revive state(s)`);
		for (const holder of walk.holders) lines.push(`    ${holder}`);
	}
	return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const AGENT: AgentDefinition = {
	name: "task",
	description: "busy worker park test agent",
	systemPrompt: `You are a test agent (${AGENT_MARKER}).`,
	source: "bundled",
	tools: ["read"],
};

let root: string;
let cwd: string;
let savedEnv: Record<string, string | undefined> = {};
let server: ParkModelServer;
let pool: SubagentWorkerPool;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let settings: Settings;
let jobs: AsyncJobManager;
let eventBus: EventBus;
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

/** Settings of the test's runs; `idleTtlMs` 0 parks only on the test's own `park`. */
function isolatedSettings(idleTtlMs: number): Settings {
	return Settings.isolated({
		"task.agentIdleTtlMs": idleTtlMs,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"async.enabled": true,
		modelRoles: { default: MODEL },
	});
}

/** A pool that sends every run to its one worker, started on `fixture` (a test fixture over the real entry). */
function workerPool(fixture: string, idleMs: number): SubagentWorkerPool {
	return new SubagentWorkerPool({
		maxWorkers: () => 1,
		idleMs,
		hostsOnMain: false,
		worker: { initTimeoutMs: 60_000, entry: new URL(`../fixtures/${fixture}`, import.meta.url) },
	});
}

/** Replace the test's pool, before it started a worker, with `next`. */
function usePool(next: SubagentWorkerPool): void {
	pool.dispose();
	pool = next;
	setSubagentWorkerPoolForTests(next);
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-busy-worker-park-"));
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

	server = new ParkModelServer();
	const modelsPath = await server.writeModelsYml(agentDir);
	authStorage = createInMemoryAuthStorage();
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	settings = isolatedSettings(0);
	jobs = new AsyncJobManager({ maxRunningJobs: 4 });
	eventBus = new EventBus();
	pool = workerPool("subagent-heap-worker.ts", 600_000);
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

function runOptions(name: string, extra: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd,
		agent: AGENT,
		task: taskOf(name),
		index: 0,
		id: name,
		description: `busy worker park ${name}`,
		modelOverride: MODEL,
		structured: false,
		settings,
		authStorage,
		modelRegistry,
		costGate: new CostGate(settings, 0, () => {}),
		asyncJobManager: jobs,
		eventBus,
		artifactsDir: path.join(root, "artifacts"),
		enableLsp: false,
		enableMCP: false,
		taskDepth: 0,
		...extra,
	};
}

/** Send `name` its follow-up; it answers `remembered <name>` from its earlier messages. */
async function followUp(name: string): Promise<string> {
	const result = await runSubagentFollowUpTurn({
		id: name,
		agent: AGENT,
		message: followUpOf(name),
		structured: false,
		storeMaskCwd: cwd,
	});
	return result.error ?? result.output;
}

/** Cold revives go through the persisted factory a real main-thread root session hands main's lifecycle. */
function installColdReviver(): void {
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
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session,
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			eventBus,
		}),
		() => 0,
	);
}

/** Run `name` to its answer on the pool's worker, then park it; returns the worker that hosted it. */
async function runAndPark(name: string): Promise<SubagentWorker> {
	const result = await runSubprocess(runOptions(name));
	expect(result.output).toBe(answerOf(name));
	const worker = pool.forThread(mirrorOf(name).home);
	if (!worker) throw new Error(`the worker of ${name} is not in the pool`);
	await AgentLifecycleManager.global().park(name);
	expect(AgentRegistry.global().get(name)?.status).toBe("parked");
	return worker;
}

/**
 * Run `name` on the pool's one worker while a main-thread listener watches its mirror, then let its idle time
 * park it; returns that worker and how many events the listener saw. Its own frame holds the mirror, so nothing
 * here keeps it once it returns.
 */
async function runWatchedAndPark(name: string): Promise<{ worker: SubagentWorker; events: number }> {
	const gate = server.gate(name);
	const running = runSubprocess(runOptions(name));
	await gate.held;
	const mirror = mirrorOf(name);
	const worker = pool.forThread(mirror.home);
	if (!worker) throw new Error(`the worker of ${name} is not in the pool`);
	let events = 0;
	const unwatch = mirror.subscribe(() => {
		events++;
	});
	gate.open();
	const result = await running;
	unwatch();
	expect(result.output).toBe(answerOf(name));
	await waitFor(() => AgentRegistry.global().get(name)?.status === "parked");
	// The park's dispose of the live session ends on the worker before the park settles.
	await AgentLifecycleManager.global().park(name);
	return { worker, events };
}

describe("a worker-homed subagent parked while its worker hosts another", () => {
	it(
		"keeps no closure of a parked subagent's run in either thread while its worker hosts another, and revives it on a follow-up",
		async () => {
			// If this regresses, every subagent that parks while its worker still runs another keeps, until that
			// worker exits, a reviver closure, its ledger entry and its drop hook on main and a reviver closure
			// over its whole revive state on the worker.
			settings = isolatedSettings(PARK_TTL_MS);
			// The other subagent, held in its model call: a one-shot helper, which has no revive state, so each revive
			// state the worker holds is the parked subagent's.
			const busy = server.gate("Busy");
			const busyRun = runSubprocess(runOptions("Busy", { keepAlive: false }));
			await busy.held;
			const { worker, events } = await runWatchedAndPark("Parked");
			expect(mirrorOf("Busy").home).toBe(worker.threadId);

			await collectGarbage();
			const main = walkParked("main", new HeapGraph(takeV8HeapSnapshot()), "Parked");
			const file = path.join(root, "worker.heapsnapshot");
			const inWorker = walkParked("worker", new HeapGraph(await workerSnapshot(worker.threadId, file)), "Parked");
			const stillHosting = worker.alive && AgentRegistry.global().get("Busy")?.status === "running";

			busy.open();
			expect((await busyRun).output).toBe(answerOf("Busy"));
			const answer = await followUp("Parked");
			expect(
				{
					watched: events > 0,
					stillHosting,
					reviveStateInWorker: inWorker.reviveStates > 0,
					main: main.holders,
					worker: inWorker.holders,
					answer,
				},
				walkReport([main, inWorker]),
			).toEqual({
				watched: true,
				stillHosting: true,
				reviveStateInWorker: true,
				main: [],
				worker: [],
				answer: "remembered Parked",
			});
		},
		TEST_TIMEOUT_MS,
	);
});

describe("a worker-homed adoption across its worker's life", () => {
	it(
		"holds the worker from its idle exit while a revive runs on it",
		async () => {
			// If this regresses, a follow-up to a subagent parked on an idle worker loses its revive whenever the
			// revive takes longer than the worker's idle time: the pool stops the worker under it.
			usePool(workerPool("subagent-stall-worker.ts", HELD_IDLE_MS));
			const worker = await runAndPark("Held");
			// The worker hosts nothing now, so its idle exit is due in HELD_IDLE_MS. The revive the follow-up asks
			// for waits on the worker's thread for longer than that; held from its idle exit, the worker lives on.
			await stallWorker(HELD_STALL_MS);
			const answer = await followUp("Held");
			expect({ answer, home: mirrorOf("Held").home, exitReason: worker.exitReason }).toEqual({
				answer: "remembered Held",
				home: worker.threadId,
				exitReason: undefined,
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"revives cold when the worker exited before the revive reached it",
		async () => {
			// If this regresses, a follow-up that comes as its worker stops idle calls into the dead worker and
			// fails, though the subagent's transcript can revive it cold.
			usePool(workerPool("subagent-heap-worker.ts", IDLE_EXIT_MS));
			installColdReviver();
			const worker = await runAndPark("Raced");
			// The worker stops once it has hosted nothing for IDLE_EXIT_MS. The follow-up is asked as it stops, from
			// the pool's exit listener: the revive reaches the subagent's adoption only after its worker exited.
			const answered = Promise.withResolvers<string>();
			cleanups.push(
				pool.onWorkerExit(exited => {
					if (exited === worker) followUp("Raced").then(answered.resolve, answered.reject);
				}),
			);
			const answer = await answered.promise;
			expect({
				answer,
				exitReason: worker.exitReason,
				movedOff: mirrorOf("Raced").home !== worker.threadId,
			}).toEqual({ answer: "remembered Raced", exitReason: "idle", movedOff: true });
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"drops the warm revive of every adoption that names an exited worker, and the next follow-up revives cold",
		async () => {
			// If this regresses, a subagent parked on a worker that has since died keeps a warm revive into that
			// worker: its next follow-up calls a dead worker and fails instead of reviving from its transcript.
			const names = ["First", "Second"];
			const workers = [await runAndPark("First"), await runAndPark("Second")];
			const [worker] = workers;
			if (!worker) throw new Error("no worker hosted the subagents");
			worker.terminate("worker crashed: boom");
			// No warm revive is left: without a cold reviver, neither subagent can be revived.
			const lifecycle = AgentLifecycleManager.global();
			const refusals = await Promise.all(
				names.map(name =>
					lifecycle.ensureLive(name).then(
						() => "revived",
						(error: unknown) => (error instanceof Error ? error.message : String(error)),
					),
				),
			);
			installColdReviver();
			const answers = [await followUp("First"), await followUp("Second")];
			expect({
				oneWorker: workers[1] === worker,
				warmRevivesLeft: refusals.filter(refusal => !refusal.includes("no reviver registered")),
				answers,
				movedOff: names.map(name => mirrorOf(name).home !== worker.threadId),
			}).toEqual({
				oneWorker: true,
				warmRevivesLeft: [],
				answers: ["remembered First", "remembered Second"],
				movedOff: [true, true],
			});
		},
		TEST_TIMEOUT_MS,
	);
});
