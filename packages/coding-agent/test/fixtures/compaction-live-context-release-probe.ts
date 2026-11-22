/**
 * Child process for test/session/compaction-live-context-release.test.ts. Drives a real `AgentSession`
 * (`createAgentSession` with a file-backed session and a mock model) through turns whose prompt, tool call,
 * tool result, steer, answer and custom note each carry a large body, compacts it with `session.compact()`,
 * and runs one more turn. Before the compaction it takes weak references to what the live context holds for
 * each of those messages: the bodies, the Agent's own message objects, the fragments `convertToLlm` keeps,
 * the steering wrappers `wrapSteeringForModel` keeps, the `convertToLlm` output it keeps for the messages
 * array, the append-only log's entries and the messages of the last request. It prints one JSON line: which
 * of those values were not held before the compaction, which of the ones for messages before the cut are
 * still reachable after the next request, which markers of messages before the cut the Agent's messages and
 * the heap's large strings still hold, and whether the Agent's tokenizer still had an estimate for them. The
 * parent runs this with the JIT off and HOME and PI_CODING_AGENT_DIR under a temp dir.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { convertToLlm, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const [root] = process.argv.slice(2);
if (!root) throw new Error("usage: compaction-live-context-release-probe.ts <root>");

/** Turns run before the compaction; the cut keeps none of them. */
const TURNS = 4;
/** Turns whose tool call steers the session while it runs. */
const STEERED_TURNS = new Set([1, 2]);
/** Bytes of random filler in each body: far past what a cold entry keeps in memory. */
const BODY_BYTES = 32 * 1024;
/** A heap string this large is a body or a copy of one. */
const LARGE_STRING_BYTES = BODY_BYTES;
/**
 * Kinds of body no heap string may hold once the messages are before the cut. The assistant's (ANSWER,
 * CALL, ARGS) are left out: the cold store keeps the records it read last (`ColdEntryStore.materialize`,
 * 8 at most), and each context rebuild reads every assistant entry's content (the eval state snapshot looks
 * for eval calls in the whole branch).
 */
const RELEASED_STRING_KINDS: Record<string, true> = { PROMPT: true, RESULT: true, STEER: true, NOTE: true };
/** How long a release reading polls for every expected value to be collected. */
const RELEASE_DEADLINE_MS = 10_000;
const MARKER = /\[\[([A-Z]+)-(\d+)\]\]/;
const MARKERS = /\[\[([A-Z]+-\d+)\]\]/g;

/**
 * A body starting with its marker, as one flat string. The filler is random hex: a repeated one reads as a
 * thinking loop when the model answers with it.
 */
function body(kind: string, turn: number): string {
	const filler = Buffer.from(crypto.getRandomValues(new Uint8Array(BODY_BYTES))).toString("hex");
	return Buffer.from(`[[${kind}-${turn}]] ${filler}`, "latin1").toString("latin1");
}

/** The first marker in `value`'s JSON, as `KIND-turn`. */
function markerOf(value: unknown): string | undefined {
	const match = MARKER.exec(JSON.stringify(value) ?? "");
	return match ? `${match[1]}-${match[2]}` : undefined;
}

function markersIn(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(MARKERS), match => match[1]!));
}

/** The text of a provider message, for the mock to read its request. */
function textOf(message: Context["messages"][number]): string {
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

// Every answer reports a cache write, so the cache warmer confirms each request's entry and the next
// request's entry replaces the one armed before the compaction.
const usage = { input: 1_000, output: 10, cacheWrite: 1_000, totalTokens: 2_010 };
let compacting = false;

const mock = createMockModel({
	handler: (context): MockResponse => {
		if (compacting) return { content: ["Summary of the earlier turns."], usage };
		if (!(context.tools ?? []).some(tool => tool.name === "probe")) return { content: ["label"], usage };
		const messages = context.messages;
		const prompt = messages.findLastIndex(
			message => message.role === "user" && textOf(message).includes("[[PROMPT-"),
		);
		if (prompt < 0) return { content: ["Ready."], usage };
		const turn = Number(/\[\[PROMPT-(\d+)\]\]/.exec(textOf(messages[prompt]!))?.[1]);
		if (prompt > messages.findLastIndex(message => message.role === "toolResult")) {
			const call = { turn: `[[CALL-${turn}]]`, payload: body("ARGS", turn) };
			return { content: [{ type: "toolCall", name: "probe", arguments: call }], usage };
		}
		return { content: [body("ANSWER", turn)], usage };
	},
});

/** Lists the mock first, so the compaction summarizes with it. */
class MockFirstModelRegistry extends ModelRegistry {
	override getAvailable(kind?: ModelKind | "all"): Model<Api>[] {
		return [mock, ...super.getAvailable(kind)];
	}
}

let liveSession: AgentSession | undefined;
const probeTool = {
	name: "probe",
	label: "Probe",
	description: "Returns a large result",
	parameters: type({ turn: "string", payload: "string" }),
	loadMode: "essential",
	async execute(_toolCallId: string, params: { turn: string }) {
		const turn = Number(/\d+/.exec(params.turn)?.[0]);
		if (STEERED_TURNS.has(turn)) await liveSession?.steer(body("STEER", turn));
		return { content: [{ type: "text" as const, text: body("RESULT", turn) }] };
	},
} as unknown as CustomTool;

// Under HOME: project discovery walks up from cwd and stops at os.homedir().
const cwd = path.join(root, "home", "work");
await fs.mkdir(cwd, { recursive: true });

registerMockApi("test/compaction-live-context-release-probe");
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "test-key");
const modelRegistry = new MockFirstModelRegistry(authStorage);
const settings = Settings.isolated({
	// The probe compacts by hand, once, keeping as few recent turns as the cut allows.
	"compaction.enabled": false,
	"compaction.keepRecentTokens": 1,
	"compaction.autoContinue": false,
	"provider.appendOnlyContext": "on",
	"async.enabled": false,
	"retry.enabled": false,
	"todo.enabled": false,
	"todo.reminders": false,
	"advisor.enabled": false,
	"marketplace.autoUpdate": "off",
	modelRoles: { default: "mock/mock-model" },
});
const sessionManager = SessionManager.create(cwd, path.join(root, "sessions"));
const { session } = await createAgentSession({
	cwd,
	authStorage,
	modelRegistry,
	model: mock,
	settings,
	sessionManager,
	toolNames: ["probe"],
	customTools: [probeTool],
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	promptTemplates: [],
	rules: [],
	enableMCP: false,
	enableLsp: false,
});
liveSession = session;

// The date/cwd reminder rides on the first user turn, and its injector keeps that turn for each of the last
// conversations it served (see the test), so the observed turns follow a first turn of their own.
await session.prompt("Warm-up turn.");
await session.waitForIdle();
for (let turn = 0; turn < TURNS; turn++) {
	await session.prompt(body("PROMPT", turn));
	await session.waitForIdle();
	await session.sendCustomMessage({
		customType: "probe-note",
		content: [{ type: "text", text: body("NOTE", turn) }],
		display: false,
	});
}

interface Observed {
	holder: string;
	marker: string;
	ref: WeakRef<object>;
}

const observed: Observed[] = [];

function observe(holder: string, value: object, marker = markerOf(value)): void {
	if (marker) observed.push({ holder, marker, ref: new WeakRef(value) });
}

/**
 * Takes weak references to what the live context holds for each message, kept out of the main flow's frames
 * so no strong local binding outlives it.
 */
function observeLiveContext(): void {
	const entryMessages = new Set<object>();
	for (const entry of sessionManager.getBranch()) {
		const content =
			entry.type === "message" && "content" in entry.message
				? entry.message.content
				: entry.type === "custom_message"
					? entry.content
					: undefined;
		if (entry.type === "message") entryMessages.add(entry.message);
		if (!Array.isArray(content)) continue;
		observe("body", content);
		for (const block of content) {
			observe("body", block, markerOf(content));
			if (block.type === "toolCall") observe("body", block.arguments);
		}
	}
	const messages = session.agent.state.messages;
	for (const message of messages) {
		if (!entryMessages.has(message)) observe("agent message", message);
		for (const fragment of convertToLlm([message])) {
			if (fragment !== message) observe("convertToLlm fragment", fragment, markerOf(message));
		}
	}
	const wrapped = wrapSteeringForModel(messages);
	wrapped.forEach((wrapper, index) => {
		if (wrapper !== messages[index]) observe("steering wrapper", wrapper);
	});
	const output = convertToLlm(messages);
	for (const marker of markersIn(JSON.stringify(output))) observe("convertToLlm output array", output, marker);
	for (const fragment of session.agent.appendOnlyContext?.log.toMessages() ?? []) {
		if (!entryMessages.has(fragment)) observe("append-only log entry", fragment);
	}
	for (const fragment of mock.calls.at(-1)?.context.messages ?? []) {
		if (!entryMessages.has(fragment)) observe("last request message", fragment);
	}
	// The mock's own record of the requests is the probe's, not the session's.
	mock.reset();
}

/** `holder marker` of each observed value whose marker is in `markers` and is still reachable. */
function reachable(markers: ReadonlySet<string>): string[] {
	return observed
		.filter(({ marker, ref }) => markers.has(marker) && ref.deref() !== undefined)
		.map(({ holder, marker }) => `${holder} ${marker}`);
}

/**
 * Full collections, each from a fresh event-loop turn (a `WeakRef` keeps its target alive until the task that
 * made or read it ends), until `released` holds or {@link RELEASE_DEADLINE_MS} passes.
 */
async function collect(released: () => boolean): Promise<void> {
	const deadline = Date.now() + RELEASE_DEADLINE_MS;
	for (;;) {
		for (let round = 0; round < 4; round++) {
			await Bun.sleep(0);
			Bun.gc(true);
		}
		if (released() || Date.now() >= deadline) return;
		await Bun.sleep(100);
	}
}

interface V8HeapSnapshot {
	snapshot: { meta: { node_fields: string[]; node_types: Array<string | string[]> } };
	nodes: number[];
	strings: string[];
}

/** The markers of `markers` that a large string in the heap contains. */
function markersInHeapStrings(markers: ReadonlySet<string>): string[] {
	const heap = JSON.parse(Bun.generateHeapSnapshot("v8")) as V8HeapSnapshot;
	const { node_fields: nodeFields, node_types: nodeTypes } = heap.snapshot.meta;
	const typeOffset = nodeFields.indexOf("type");
	const nameOffset = nodeFields.indexOf("name");
	const sizeOffset = nodeFields.indexOf("self_size");
	const typeNames = nodeTypes[typeOffset];
	if (typeOffset < 0 || nameOffset < 0 || sizeOffset < 0 || !Array.isArray(typeNames)) {
		throw new Error("Unexpected V8 heap snapshot schema");
	}
	const found = new Set<string>();
	for (let offset = 0; offset < heap.nodes.length; offset += nodeFields.length) {
		if (typeNames[heap.nodes[offset + typeOffset]!] !== "string") continue;
		if (heap.nodes[offset + sizeOffset]! < LARGE_STRING_BYTES) continue;
		for (const marker of markersIn(heap.strings[heap.nodes[offset + nameOffset]!] ?? "")) {
			if (markers.has(marker)) found.add(marker);
		}
	}
	return [...found].sort();
}

observeLiveContext();
const everyMarker = new Set(observed.map(({ marker }) => marker));
await collect(() => false);
const unheldBefore = observed
	.filter(({ ref }) => ref.deref() === undefined)
	.map(({ holder, marker }) => `${holder} ${marker}`);

compacting = true;
await session.compact();
compacting = false;

const fromCut = sessionManager.getBranchFromCut();
const fromCutIds = new Set(fromCut.map(entry => entry.id));
const preCutIds = new Set(
	sessionManager
		.getBranch()
		.filter(entry => !fromCutIds.has(entry.id))
		.map(entry => entry.id),
);
const kept = markersIn(
	JSON.stringify(fromCut.filter(entry => entry.type === "message" || entry.type === "custom_message")),
);
const preCut = new Set([...everyMarker].filter(marker => !kept.has(marker)));
const agentMessagesPreCut = [...markersIn(JSON.stringify(session.agent.state.messages))]
	.filter(marker => preCut.has(marker))
	.sort();

await session.prompt(body("PROMPT", TURNS));
await session.waitForIdle();
mock.reset();
await collect(() => reachable(preCut).length === 0);
const afterNextRequest = reachable(preCut);
const heapStringsPreCut = markersInHeapStrings(
	new Set([...preCut].filter(marker => RELEASED_STRING_KINDS[marker.slice(0, marker.indexOf("-"))] === true)),
);

const preCutEntries = sessionManager
	.getBranch()
	.filter(entry => preCutIds.has(entry.id) && (entry.type === "message" || entry.type === "custom_message"));
// A body-carrying entry left whole holds its body; reading a whole entry reads no store.
const preCutEntriesWhole = preCutEntries
	.filter(entry => !isColdEntry(entry) && markerOf(entry) !== undefined)
	.map(entry => entry.id);
// A message whose estimate the tokenizer forgot is counted from its body again, which a cold entry reads back
// from the store. Assistant entries are left out: the store may still hold their records.
let tokenizerChecked = 0;
let tokenizerKeptEstimates = 0;
for (const entry of preCutEntries) {
	if (entry.type !== "message" || entry.message.role === "assistant" || !isColdEntry(entry)) continue;
	const reads = sessionManager.coldStoreStats().materializations;
	session.agent.tokenizer.countMessage(entry.message);
	tokenizerChecked++;
	if (sessionManager.coldStoreStats().materializations === reads) tokenizerKeptEstimates++;
}
const transcript = JSON.stringify(sessionManager.getEntries());
const transcriptMissing = [...preCut].filter(marker => !transcript.includes(`[[${marker}]]`)).sort();

liveSession = undefined;
await session.dispose();
authStorage.close();

process.stdout.write(
	`${JSON.stringify({
		preCut: [...preCut].sort(),
		observed: Object.fromEntries(
			[...new Set(observed.map(({ holder }) => holder))].map(holder => [
				holder,
				observed.filter(entry => entry.holder === holder && preCut.has(entry.marker)).length,
			]),
		),
		unheldBefore,
		afterNextRequest,
		agentMessagesPreCut,
		heapStringsPreCut,
		tokenizerChecked,
		tokenizerKeptEstimates,
		preCutEntriesWhole,
		transcriptMissing,
	})}\n`,
);
