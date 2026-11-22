/**
 * Child process for test/session/compaction-live-context-release.test.ts. Drives a real `AgentSession`
 * (`createAgentSession` with a file-backed session and a mock model) through turns whose prompt, tool call,
 * tool result, steer, answer and custom note each carry a large body, compacts it with `session.compact()`,
 * and runs one more turn. Before the compaction it takes weak references to what the live context holds for
 * each of those messages: the bodies, the Agent's own message objects, the fragments `convertToLlm` keeps,
 * the steering wrappers `wrapSteeringForModel` keeps, the `convertToLlm` output it keeps for the messages
 * array, the append-only log's entries and the messages of the last request, and the copy of the first turn
 * the date/cwd reminder injector sent. It reads twice: right after `session.compact()` returns, before any
 * further request, and after the next request. Two holders key every message by a short string: the
 * session's persisted-message index and the date/cwd reminder injector; the probe reads which of their keys
 * for the messages' assistant turns and tool results the heap holds before the compaction and at each
 * reading. Between the readings it appends a custom entry, so the next request's persistence builds the index
 * again. It prints one JSON line: which of those values and keys were not held before the compaction; at
 * each reading, which of the ones for messages before the cut are still reachable or held and which markers
 * of those messages the heap's large strings still hold; at the compaction, which of those markers the
 * Agent's messages and the append-only log still hold; after the next request, whether the Agent's tokenizer
 * still had an estimate for them. The parent runs this with the JIT off and HOME and PI_CODING_AGENT_DIR
 * under a temp dir.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { Api, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { type MockResponse, MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import {
	DATE_CWD_REMINDER_CUSTOM_TYPE,
	isDateCwdReminderControl,
} from "@oh-my-pi/pi-coding-agent/session/date-cwd-reminder";
import {
	convertMessagesForContextView,
	convertToLlm,
	wrapSteeringForModel,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";
import { isRecord } from "@oh-my-pi/pi-utils";
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
/** The first prompt, before the observed turns: it carries the date/cwd reminder. */
const WARM_UP = "Warm-up turn.";

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

// Every answer reports a cache write, so the cache warmer confirms each request's entry, as it does for a
// real provider's.
const usage = { input: 1_000, output: 10, cacheWrite: 1_000, totalTokens: 2_010 };
let compacting = false;

/**
 * Declares a 5-minute prompt cache lifetime, so the cache warmer keeps a run armed with the last request (its
 * refresh scheduled at 90% of the lifetime) while the session sits idle (`providers.cacheWarming` is `idle` by
 * default), as with a real provider.
 */
class CachingMockModel extends MockModel {
	readonly promptCache = { short: 300 };
}

const mock = new CachingMockModel({
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

// The date/cwd reminder rides on the first user turn: a short one of its own, whose copy with the reminder
// the probe observes apart from the observed turns' values.
await session.prompt(WARM_UP);
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

/** A turn of a provider request as the date/cwd reminder injector keys it (`#keysOf` in date-cwd-reminder.ts). */
interface ProviderTurn {
	role: Message["role"];
	timestamp: number;
	attribution: string | undefined;
	/** Among the earlier turns of its request with the same role, timestamp and attribution. */
	ordinal: number;
}

/**
 * The turns of `messages` the injector keys (the reminder controls are its own). Counted under strings of the
 * probe's own format: the probe keeps no string equal to a key it looks for in the heap.
 */
function providerTurns(messages: readonly Message[]): ProviderTurn[] {
	const counts = new Map<string, number>();
	const turns: ProviderTurn[] = [];
	for (const message of messages) {
		if (isDateCwdReminderControl(message)) continue;
		const attribution = message.role === "user" || message.role === "developer" ? message.attribution : undefined;
		const id = turnId({ role: message.role, timestamp: message.timestamp, attribution });
		const ordinal = counts.get(id) ?? 0;
		counts.set(id, ordinal + 1);
		turns.push({ role: message.role, timestamp: message.timestamp, attribution, ordinal });
	}
	return turns;
}

/** A turn's role, timestamp and attribution in the probe's own format, unlike any key. */
function turnId(turn: Pick<ProviderTurn, "role" | "timestamp" | "attribution">): string {
	return `${turn.timestamp}|${turn.role}|${turn.attribution ?? ""}`;
}

const PERSISTED_INDEX = "persisted-message index";
const DATE_CWD_REMINDER = "date/cwd reminder";

/**
 * The keys the two key holders keep for the assistant turns and tool results among `entryIds` and `turns`,
 * each with a label of the probe's own: the session's persisted-message index keys message entries
 * (`sessionMessagePersistenceKey`), the date/cwd reminder injector the turns of the requests it served
 * (`#keysOf` in date-cwd-reminder.ts). A user turn's key is the same string in both, so it tells neither apart.
 * The session's journal of the reminders placed names the turns it placed them on by the injector's keys, and
 * stays with the transcript, so a key it holds is left out. Built only after a heap snapshot is taken
 * ({@link readHeap}).
 */
function heldKeyTargets(entryIds: Iterable<string>, turns: readonly ProviderTurn[]): Map<string, string> {
	const targets = new Map<string, string>();
	for (const id of entryIds) {
		const entry = sessionManager.getEntry(id);
		if (entry?.type !== "message") continue;
		if (entry.message.role !== "assistant" && entry.message.role !== "toolResult") continue;
		const key = sessionMessagePersistenceKey(entry.message);
		if (key !== undefined) targets.set(key, `${PERSISTED_INDEX} ${entry.message.role} ${id}`);
	}
	const journaled = new Set<unknown>();
	for (const entry of sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== DATE_CWD_REMINDER_CUSTOM_TYPE) continue;
		if (isRecord(entry.data)) for (const value of Object.values(entry.data)) journaled.add(value);
	}
	for (const turn of turns) {
		if (turn.role !== "assistant" && turn.role !== "toolResult") continue;
		const base = `${turn.role}:${turn.timestamp}`;
		const key = turn.ordinal === 0 ? base : `${base}#${turn.ordinal}`;
		if (!journaled.has(key)) targets.set(key, `${DATE_CWD_REMINDER} ${turn.role} ${turn.timestamp}#${turn.ordinal}`);
	}
	return targets;
}

/** The labels of {@link heldKeyTargets}, without building their keys in the caller's frame. */
function heldKeyLabels(entryIds: Iterable<string>, turns: readonly ProviderTurn[]): string[] {
	return [...heldKeyTargets(entryIds, turns).values()];
}

function ofHolder(labels: readonly string[], holder: string): string[] {
	return labels.filter(label => label.startsWith(`${holder} `));
}

/** The provider turns of the last request before the compaction. */
let lastRequestTurns: ProviderTurn[] = [];
/** The copy of the first turn the date/cwd reminder injector sent, its reminder prepended. */
let firstTurnInjection: WeakRef<object> | undefined;

function injectionReachable(): boolean {
	return firstTurnInjection?.deref() !== undefined;
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
	const lastRequest = mock.calls.at(-1)?.context.messages ?? [];
	for (const fragment of lastRequest) {
		if (!entryMessages.has(fragment)) observe("last request message", fragment);
	}
	lastRequestTurns = providerTurns(lastRequest);
	// Once its request is done, only the injector keeps this copy.
	const injected = lastRequest.find(message => message.role === "user" && textOf(message).includes(WARM_UP));
	if (injected && !entryMessages.has(injected)) firstTurnInjection = new WeakRef(injected);
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

/**
 * One heap snapshot: the markers of `markers` that a large string in it contains, and the label of each key of
 * `keys` a string in it equals. `keys` runs after the snapshot, so the strings it builds are not in it.
 */
function readHeap(
	markers: ReadonlySet<string>,
	keys: () => ReadonlyMap<string, string>,
): { markers: string[]; keys: string[] } {
	const heap = JSON.parse(Bun.generateHeapSnapshot("v8")) as V8HeapSnapshot;
	const wanted = keys();
	const { node_fields: nodeFields, node_types: nodeTypes } = heap.snapshot.meta;
	const typeOffset = nodeFields.indexOf("type");
	const nameOffset = nodeFields.indexOf("name");
	const sizeOffset = nodeFields.indexOf("self_size");
	const typeNames = nodeTypes[typeOffset];
	if (typeOffset < 0 || nameOffset < 0 || sizeOffset < 0 || !Array.isArray(typeNames)) {
		throw new Error("Unexpected V8 heap snapshot schema");
	}
	const found = new Set<string>();
	const held = new Set<string>();
	for (let offset = 0; offset < heap.nodes.length; offset += nodeFields.length) {
		if (typeNames[heap.nodes[offset + typeOffset]!] !== "string") continue;
		const text = heap.strings[heap.nodes[offset + nameOffset]!] ?? "";
		const label = wanted.get(text);
		if (label !== undefined) held.add(label);
		if (heap.nodes[offset + sizeOffset]! < LARGE_STRING_BYTES) continue;
		for (const marker of markersIn(text)) {
			if (markers.has(marker)) found.add(marker);
		}
	}
	return { markers: [...found].sort(), keys: [...held].sort() };
}

observeLiveContext();
const everyMarker = new Set(observed.map(({ marker }) => marker));
await collect(() => false);
const unheldBefore = observed
	.filter(({ ref }) => ref.deref() === undefined)
	.map(({ holder, marker }) => `${holder} ${marker}`);
if (!injectionReachable()) unheldBefore.push("date/cwd reminder injection");
// The keys each holder kept before the compaction, by label.
const keysHeldBefore = new Set(
	readHeap(new Set(), () =>
		heldKeyTargets(
			sessionManager.getBranch().map(entry => entry.id),
			lastRequestTurns,
		),
	).keys,
);

compacting = true;
await session.compact();
compacting = false;
// The mock's record of the compaction's own request is the probe's, not the session's.
mock.reset();

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
const releasedStringMarkers = new Set(
	[...preCut].filter(marker => RELEASED_STRING_KINDS[marker.slice(0, marker.indexOf("-"))] === true),
);
// The turns of the last request before the compaction that the compacted history no longer holds.
const liveTurns = new Set(
	providerTurns(convertMessagesForContextView(session.agent.state.messages).map(({ message }) => message)).map(turnId),
);
const preCutTurns = lastRequestTurns.filter(turn => !liveTurns.has(turnId(turn)));

// At the compaction itself, before any further request: an idle session after `/compact` may send none for a
// long time.
await collect(() => reachable(preCut).length === 0 && !injectionReachable());
const reachableAtCompaction = reachable(preCut);
const dateCwdInjectionAtCompaction = injectionReachable();
const agentMessagesAtCompaction = [...markersIn(JSON.stringify(session.agent.state.messages))]
	.filter(marker => preCut.has(marker))
	.sort();
// The log's entries include the session's own assistant messages, which their entries keep: read what it holds.
const appendOnlyLogAtCompaction = [
	...markersIn(JSON.stringify(session.agent.appendOnlyContext?.log.toMessages() ?? [])),
]
	.filter(marker => preCut.has(marker))
	.sort();
const atCompaction = readHeap(releasedStringMarkers, () => heldKeyTargets(preCutIds, preCutTurns));
const heapStringsAtCompaction = atCompaction.markers;

// A non-message entry moves the leaf, so the next request's persistence builds the persisted-message index
// again rather than reading the one it had.
sessionManager.appendCustomEntry("compaction-live-context-release-probe");

await session.prompt(body("PROMPT", TURNS));
await session.waitForIdle();
mock.reset();
await collect(() => reachable(preCut).length === 0);
const reachableAfterNextRequest = reachable(preCut);
const afterNextRequest = readHeap(releasedStringMarkers, () => heldKeyTargets(preCutIds, preCutTurns));
const heapStringsAfterNextRequest = afterNextRequest.markers;

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
// Each key looked for at a reading was held before the compaction, or its reading says nothing.
const preCutKeys = heldKeyLabels(preCutIds, preCutTurns);
const keysUnheldBefore = preCutKeys.filter(label => !keysHeldBefore.has(label)).sort();

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
		persistedKeyTargets: ofHolder(preCutKeys, PERSISTED_INDEX).length,
		dateCwdKeyTargets: ofHolder(preCutKeys, DATE_CWD_REMINDER).length,
		keysUnheldBefore,
		reachableAtCompaction,
		agentMessagesAtCompaction,
		appendOnlyLogAtCompaction,
		heapStringsAtCompaction,
		persistedKeysAtCompaction: ofHolder(atCompaction.keys, PERSISTED_INDEX),
		dateCwdKeysAtCompaction: ofHolder(atCompaction.keys, DATE_CWD_REMINDER),
		dateCwdInjectionAtCompaction,
		reachableAfterNextRequest,
		heapStringsAfterNextRequest,
		persistedKeysAfterNextRequest: ofHolder(afterNextRequest.keys, PERSISTED_INDEX),
		dateCwdKeysAfterNextRequest: ofHolder(afterNextRequest.keys, DATE_CWD_REMINDER),
		tokenizerChecked,
		tokenizerKeptEstimates,
		preCutEntriesWhole,
		transcriptMissing,
	})}\n`,
);
