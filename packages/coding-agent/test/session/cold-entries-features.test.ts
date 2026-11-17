/**
 * Every feature that reads older entries works the same on a long session whose
 * older bodies are cold: each case runs one feature on a session with three
 * compactions and two branches, and expects what the same feature gives when
 * the manager holds every entry (`coldStore: false`). The kinds features read
 * (model, thinking, service tier and mode changes, TTSR injections, to-do
 * results, session contracts) lie before the cut, so a build that dropped them
 * from older entries fails here.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import * as pruning from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionData } from "@oh-my-pi/pi-coding-agent/export/html";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { extractSessionInit, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { persistedAgentDefinition } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TITLE = "Refactor the module tree";
/** Each case writes, resumes and compares two copies of a session; one runs ten model turns. */
const CASE_TIMEOUT_MS = 60_000;
/**
 * The message fields that readers walking the whole branch read of every
 * message on a turn (the persistence check of each new message, the prompt
 * cache scan, the to-do restore, the retry checks, the prune passes,
 * extensions), so a cold message keeps them in memory.
 */
const MESSAGE_FIELDS_READ_EVERY_TURN = [
	"role",
	"stopReason",
	"timestamp",
	"toolCallId",
	"toolName",
	"isError",
	"provider",
	"model",
	"api",
	"usage",
	"responseId",
	"customType",
	"display",
	"attribution",
	"errorMessage",
	"prunedAt",
	"useless",
];

function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

function usage() {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** An assistant message with the fields a recent Anthropic reply records. */
function assistantMessage(label: string, toolCall?: { id: string; name: string; arguments: object }) {
	return {
		role: "assistant",
		content: [{ type: "text", text: text(label) }, ...(toolCall ? [{ type: "toolCall", ...toolCall }] : [])],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(),
		stopReason: toolCall ? "toolUse" : "stop",
		timestamp: 2,
		requestControls: {
			messageIndex: 8,
			tools: { declared: ["read", "todo", "probe"], deferred: [], active: ["read", "todo", "probe"] },
			effort: { topLevel: "high", tail: "high" },
		},
		responseId: `msg_01${label}Fixture`,
		duration: 4163.076492,
		ttft: 2100.812789,
		completedAt: 1767225604163,
		contextSnapshot: { promptTokens: 40814, nonMessageTokens: 32441, toolSchemaTokens: 9132, compactionEpoch: 0 },
	};
}

function phases(label: string) {
	return [
		{
			name: `Phase ${label}`,
			tasks: Array.from({ length: 40 }, (_, index) => ({
				content: `${label} task ${index}: move module ${index} under src/tree`,
				status: index < 10 ? "completed" : "pending",
			})),
		},
	];
}

/** Custom types of a messaging extension that keeps its own state in the session. */
const ROLE_CLAIM_TYPE = "relay-role-claim";
const REPLAY_STATE_TYPE = "relay-replay-state";
const REPLAY_DELIVERED_TYPE = "relay-replay-delivered";
const CONSUMER_STATE_TYPE = "relay-consumer-state";

/** One `custom` entry of the messaging extension, with the id {@link sessionText} writes it under. */
interface RelayEntry {
	id: string;
	customType: string;
	data: object;
}

/**
 * A messaging extension's own entries in session `sessionId` (`entries`, by
 * where {@link sessionText} writes them with `relay`, all before the cut) and
 * what it restores from them (`restored`): the newest role claim on the
 * current path (`r2`, over the older `r1` and over `rb`, on the other branch
 * and newer in the file), every replay state in order, every delivery of the
 * ledger, and this session's consumer state (`q1`, not the newer `q2` of
 * another session).
 */
function relayState(sessionId: string) {
	const ownTopic = "notifications.agent.3b8f6a2e-5d41-4c9a-8e07-1f2d3c4b5a69";
	const peerTopic = "notifications.agent.9e1c7d40-2a6b-4f38-b5d2-6c8e0a1f7b34";
	const olderState = { subjects: { [ownTopic]: {} } };
	const newerState = { topics: [ownTopic, peerTopic] };
	const claim = { role: "reviewer", session_id: sessionId, client_instance_id: "client-7f3a" };
	const consumer = { session_id: sessionId, resume: { stream_id: "agent-notifications", seq: 41 } };
	const otherConsumer = {
		session_id: "0f6d2b84-7c1e-4a95-9b3d-5e8a2c6f1d07",
		resume: { stream_id: "agent-notifications", seq: 7 },
	};
	const delivered = (index: number) => ({
		event_id: `${index}c4e9a07b2f5d18e6`,
		dedupe_key: `review-request:${index}`,
		at: Date.parse(TIMESTAMP) + index * 1000,
	});
	const entry = (id: string, customType: string, data: object): RelayEntry => ({ id, customType, data });
	return {
		entries: {
			beforeC1: [
				entry("r1", ROLE_CLAIM_TYPE, { role: "planner" }),
				entry("p1", REPLAY_STATE_TYPE, olderState),
				entry("d1", REPLAY_DELIVERED_TYPE, delivered(1)),
				entry("q1", CONSUMER_STATE_TYPE, consumer),
			],
			beforeC2: [entry("d2", REPLAY_DELIVERED_TYPE, delivered(2)), entry("q2", CONSUMER_STATE_TYPE, otherConsumer)],
			beforeC3: [
				entry("r2", ROLE_CLAIM_TYPE, claim),
				entry("p2", REPLAY_STATE_TYPE, newerState),
				entry("d3", REPLAY_DELIVERED_TYPE, delivered(3)),
			],
			otherBranch: [
				entry("rb", ROLE_CLAIM_TYPE, { role: "worker" }),
				entry("d4", REPLAY_DELIVERED_TYPE, delivered(4)),
			],
		},
		restored: {
			claim,
			states: [olderState, newerState],
			ledger: [delivered(1), delivered(2), delivered(3), delivered(4)],
			consumer,
		},
	};
}

/** What {@link sessionText} adds to the session it always writes. */
interface SessionOptions {
	interrupted?: boolean;
	relay?: boolean;
	todoEdits?: boolean;
	todoEditsAfterCut?: boolean;
	olderTurns?: number;
}

/**
 * A titled session. On the current path: `c1` keeps from `u2`, `c2` from
 * `u4`, `c3` from `u7` (the cut). Before the cut lie a session contract
 * (`s0`), two to-do results (`t1`, then `t3`, the list), model changes for
 * the default and the `smol` role, a thinking level, a service tier, a TTSR
 * injection, a plan mode, a custom entry, a custom message, and a second
 * branch off `c2` (`b1`, `b2`) left for `bs`. With `interrupted`, the last
 * turn stopped after a `probe` call that never got its result. With `relay`,
 * a messaging extension's own entries ({@link relayState}) lie before the
 * cut too: before `c1`, before `c2`, before `c3` and on the other branch.
 * With `todoEdits`, the user edited the to-do list on each branch: `te` on
 * the other branch (followed by `b3`), then `ta` after `bs`, before the cut,
 * the newest snapshot of the current path. With `todoEditsAfterCut`, the
 * user edited the list twice after the cut: `e1` while `u8` ran (before
 * `a8`), then `e2` while `u10` ran, followed by `a10`, the leaf; `e2` is the
 * newest snapshot of the current path. With `olderTurns`, that many more
 * rounds lie before `u6`, each a prompt (`hu…`), a `probe` call (`ha…`), its
 * result (`hr…`), a failed reply (`he…`) and a custom message (`hn…`).
 */
function sessionText(id: string, cwd: string, options: SessionOptions = {}): string {
	const lines: object[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd }];
	const add = (entryType: string, entryId: string, parentId: string | null, fields: object) =>
		lines.push({ type: entryType, id: entryId, parentId, timestamp: TIMESTAMP, ...fields });
	const user = (entryId: string, parentId: string) =>
		add("message", entryId, parentId, {
			message: { role: "user", content: [{ type: "text", text: text(entryId) }], attribution: "user", timestamp: 1 },
		});
	const assistant = (entryId: string, parentId: string, toolCall?: { id: string; name: string; arguments: object }) =>
		add("message", entryId, parentId, { message: assistantMessage(entryId, toolCall) });
	const todo = (entryId: string, parentId: string, callId: string) =>
		add("message", entryId, parentId, {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "todo",
				content: [{ type: "text", text: text(entryId) }],
				details: { op: "replace", phases: phases(entryId) },
				isError: false,
				timestamp: 3,
			},
		});
	const compaction = (entryId: string, parentId: string, firstKeptEntryId: string) =>
		add("compaction", entryId, parentId, { summary: text(entryId), firstKeptEntryId, tokensBefore: 1000 });
	const relay = options.relay ? relayState(id).entries : undefined;
	/** Chain `entries` after `parentId`; returns the id the next entry hangs from. */
	const chain = (parentId: string, entries: readonly RelayEntry[] = []) => {
		let last = parentId;
		for (const entry of entries) {
			add("custom", entry.id, last, { customType: entry.customType, data: entry.data });
			last = entry.id;
		}
		return last;
	};

	add("session_init", "s0", null, {
		systemPrompt: [text("system prompt")],
		task: "Refactor the module tree",
		tools: ["read", "todo", "probe"],
		agent: "task",
		modelRole: "default",
	});
	user("u1", "s0");
	add("model_change", "m1", "u1", { model: "anthropic/claude-sonnet-4-5", role: "default" });
	assistant("a1", "m1", { id: "call_t1", name: "todo", arguments: { op: "replace" } });
	todo("t1", "a1", "call_t1");
	add("custom", "x1", "t1", { customType: "test-ledger", data: { checkpoints: ["first", "second"] } });
	user("u2", chain("x1", relay?.beforeC1));
	assistant("a2", "u2");
	compaction("c1", "a2", "u2");
	add("thinking_level_change", "k1", "c1", { thinkingLevel: "high", configured: "high" });
	add("model_change", "m2", "k1", { model: "anthropic/claude-haiku-4-5", role: "smol" });
	add("service_tier_change", "st", "m2", { serviceTier: { anthropic: "priority" } });
	add("ttsr_injection", "tt", "st", { injectedRules: ["no-console-log", "prefer-bun-file"] });
	add("mode_change", "md", "tt", { mode: "plan", data: { planFile: "PLAN.md" } });
	user("u3", chain("md", relay?.beforeC2));
	assistant("a3", "u3", { id: "call_t3", name: "todo", arguments: { op: "replace" } });
	todo("t3", "a3", "call_t3");
	add("custom_message", "cm", "t3", {
		customType: "test-note",
		content: [{ type: "text", text: text("cm") }],
		display: true,
	});
	user("u4", "cm");
	assistant("a4", "u4");
	compaction("c2", "a4", "u4");
	user("u5", "c2");
	assistant("a5", "u5");
	const beforeBranchSummary = chain("a5", relay?.beforeC3);
	user("b1", "c2");
	assistant("b2", chain("b1", relay?.otherBranch));
	if (options.todoEdits) {
		add("custom", "te", "b2", { customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: phases("te") } });
		assistant("b3", "te");
	}
	add("branch_summary", "bs", beforeBranchSummary, { fromId: "b2", summary: text("bs") });
	let beforeU6 = "bs";
	if (options.todoEdits) {
		add("custom", "ta", "bs", { customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: phases("ta") } });
		beforeU6 = "ta";
	}
	for (let round = 1; round <= (options.olderTurns ?? 0); round++) {
		const callId = `call_h${round}`;
		user(`hu${round}`, beforeU6);
		assistant(`ha${round}`, `hu${round}`, { id: callId, name: "probe", arguments: { value: `round ${round}` } });
		add("message", `hr${round}`, `ha${round}`, {
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName: "probe",
				content: [{ type: "text", text: text(`hr${round}`) }],
				details: { value: `round ${round}` },
				isError: false,
				timestamp: 3,
			},
		});
		add("message", `he${round}`, `hr${round}`, {
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: usage(),
				stopReason: "error",
				errorMessage: "529 overloaded_error: Overloaded",
				timestamp: 4,
			},
		});
		add("message", `hn${round}`, `he${round}`, {
			message: { role: "custom", customType: "test-note", content: text(`hn${round}`), display: true, timestamp: 5 },
		});
		beforeU6 = `hn${round}`;
	}
	user("u6", beforeU6);
	assistant("a6", "u6");
	user("u7", "a6");
	assistant("a7", "u7");
	compaction("c3", "a7", "u7");
	user("u8", "c3");
	let beforeA8 = "u8";
	if (options.todoEditsAfterCut) {
		add("custom", "e1", "u8", { customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: phases("e1") } });
		beforeA8 = "e1";
	}
	assistant("a8", beforeA8);
	if (options.interrupted) {
		user("u9", "a8");
		assistant("a9", "u9", { id: "call_probe", name: "probe", arguments: { value: "again" } });
	}
	if (options.todoEditsAfterCut) {
		user("u10", "a8");
		add("custom", "e2", "u10", { customType: USER_TODO_EDIT_CUSTOM_TYPE, data: { phases: phases("e2") } });
		assistant("a10", "e2");
	}
	const slot = serializeTitleSlot({ title: TITLE, source: "user", updatedAt: TIMESTAMP });
	return slot + lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

interface WrittenSession {
	file: string;
	id: string;
	cwd: string;
	sessionDir: string;
}

/** Write the session to its own directory under `root`, as `name`, with a session id of its own. */
async function writeSession(root: string, name: string, options: SessionOptions = {}): Promise<WrittenSession> {
	const id = crypto.randomUUID();
	const cwd = path.join(root, name, "project");
	const sessionDir = path.join(root, name, "sessions");
	fs.mkdirSync(cwd, { recursive: true });
	const file = path.join(sessionDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	await Bun.write(file, sessionText(id, cwd, options));
	return { file, id, cwd, sessionDir };
}

/** What a client or the model receives. */
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** {@link wire} without timestamps: each run stamps the entries and messages it adds with its own clock. */
function wireUndated(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value), (key, field: unknown) => (key === "timestamp" ? undefined : field));
}

/** The probe tool: echoes its `value`, its result flagged useless so prune passes may drop it. */
function probeTool(executed: string[]): AgentTool {
	const schema = type({ value: "string" });
	const tool: AgentTool<typeof schema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Echo a value",
		parameters: schema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params, useless: true };
		},
	};
	return tool as AgentTool;
}

/** The `data` of every `customType` entry among `entries`, filtered as the messaging extension filters them. */
function customData(entries: readonly SessionEntry[], customType: string): unknown[] {
	return entries.flatMap(entry =>
		entry.type === "custom" && entry.customType === customType && "data" in entry ? [entry.data] : [],
	);
}

/**
 * What the messaging extension restores after a resume, each read through the
 * accessor it uses: the newest role claim on the current path (`getBranch()`),
 * and the replay states, the ledger and this session's consumer state from
 * every entry (`getEntries()`).
 */
function relayRestored(manager: SessionManager): unknown {
	const entries = manager.getEntries();
	return wire({
		claim: customData(manager.getBranch(), ROLE_CLAIM_TYPE).at(-1),
		states: customData(entries, REPLAY_STATE_TYPE),
		ledger: customData(entries, REPLAY_DELIVERED_TYPE),
		consumer: customData(entries, CONSUMER_STATE_TYPE).findLast(
			data => isRecord(data) && data.session_id === manager.getSessionId(),
		),
	});
}

describe("features that read older entries, on a session whose older bodies are cold", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	function tempRoot(): string {
		const dir = TempDir.createSync("@omp-cold-features-");
		cleanups.push(() => dir.removeSync());
		return dir.path();
	}

	async function open(
		file: string,
		coldStore: boolean,
		options: { throwIfMissing?: boolean } = {},
	): Promise<SessionManager> {
		const manager = await SessionManager.open(file, path.dirname(file), new FileSessionStorage(), {
			suppressBreadcrumb: true,
			coldStore,
			...options,
		});
		cleanups.push(() => manager.close());
		return manager;
	}

	/** The session resumed with the store, its older bodies cold, and with every entry held. */
	async function openBoth(file: string): Promise<{ cold: SessionManager; whole: SessionManager }> {
		const cold = await open(file, true);
		const whole = await open(file, false);
		expect(cold.coldStoreStats().coldEntries).toBeGreaterThan(10);
		expect(whole.coldStoreStats().coldEntries).toBe(0);
		return { cold, whole };
	}

	/** Two copies, each with its own session id, so each manager owns the file it writes. */
	async function writeBoth(options: SessionOptions = {}) {
		const root = tempRoot();
		const coldCopy = await writeSession(root, "cold", options);
		const wholeCopy = await writeSession(root, "whole", options);
		const cold = await open(coldCopy.file, true);
		const whole = await open(wholeCopy.file, false);
		expect(cold.coldStoreStats().coldEntries).toBeGreaterThan(10);
		return { coldCopy, wholeCopy, cold, whole };
	}

	async function startSession(
		manager: SessionManager,
		options: { tools?: AgentTool[]; responses?: MockResponse[]; settings?: Record<string, unknown> } = {},
		extensionRunner?: ExtensionRunner,
	) {
		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({ responses: options.responses ?? [] });
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: options.tools ?? [],
				messages: manager.buildSessionContext().messages,
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, ...options.settings }),
			modelRegistry,
			extensionRunner,
		});
		session.subscribe(() => {});
		cleanups.push(() => session.dispose());
		return { session, mock, modelRegistry };
	}

	it(
		"resumes by path and by id with the entries and model context a manager holding every entry gives",
		async () => {
			const written = await writeSession(tempRoot(), "session");
			const { cold, whole } = await openBoth(written.file);
			expect(wire(cold.getEntries())).toEqual(wire(whole.getEntries()));
			expect(wire(cold.buildSessionContext().messages)).toEqual(wire(whole.buildSessionContext().messages));

			const target = await resolveResumeTarget(written.id.slice(0, 8), written.cwd, written.sessionDir);
			if (!target) throw new Error("The session was not found by its id");
			const byId = await open(target.session.path, true);
			expect(wire(byId.buildSessionContext().messages)).toEqual(wire(whole.buildSessionContext().messages));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"goes on with an interrupted turn as --restore does, sending the model what it sends with every entry held",
		async () => {
			const { cold, whole } = await writeBoth({ interrupted: true });
			const restored = async (manager: SessionManager) => {
				const executed: string[] = [];
				const { session, mock } = await startSession(manager, {
					tools: [probeTool(executed)],
					responses: [{ content: ["done after restore"], stopReason: "stop" }],
				});
				expect(await session.restoreInterruptedTurn()).toBe(true);
				await session.waitForIdle();
				return { executed, sent: wireUndated(mock.calls.map(call => call.context.messages)) };
			};
			const fromCold = await restored(cold);
			expect(fromCold.executed).toEqual(["again"]);
			expect(fromCold).toEqual(await restored(whole));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"moves in the tree to an entry before the cut, and to the other branch, with the context of every entry held",
		async () => {
			const { cold, whole } = await writeBoth();
			for (const target of ["u3", "b2"]) {
				cold.branch(target);
				whole.branch(target);
				expect(wire(cold.getBranch())).toEqual(wire(whole.getBranch()));
				expect(wire(cold.buildSessionContext().messages)).toEqual(wire(whole.buildSessionContext().messages));
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"forks without an entry and from an entry before the cut into the transcripts every entry held gives",
		async () => {
			const { cold, whole } = await writeBoth();
			const forkedEntries = async (file: string | undefined) => {
				if (!file) throw new Error("The fork wrote no session file");
				return wire((await open(file, false)).getEntries());
			};
			const coldFork = await cold.fork();
			const wholeFork = await whole.fork();
			expect(await forkedEntries(coldFork?.newSessionFile)).toEqual(await forkedEntries(wholeFork?.newSessionFile));
			const coldBranch = cold.createBranchedSession("a5");
			const wholeBranch = whole.createBranchedSession("a5");
			const fromEntry = await forkedEntries(coldBranch);
			expect(fromEntry).toEqual(await forkedEntries(wholeBranch));
			expect(JSON.stringify(fromEntry)).toContain(text("u1"));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"exports the same session data into the HTML export as a manager holding every entry",
		async () => {
			const written = await writeSession(tempRoot(), "session");
			const { cold, whole } = await openBoth(written.file);
			// The export embeds this, read through the accessors, in its document.
			expect(wire(buildSessionData(cold))).toEqual(wire(buildSessionData(whole)));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"opens a seance of it (forkFrom with seance) with the history every entry held gives",
		async () => {
			const root = tempRoot();
			const written = await writeSession(root, "session");
			const seance = async (coldStore: boolean) => {
				const forked = await SessionManager.forkFrom(
					written.file,
					written.cwd,
					path.join(root, coldStore ? "cold-seance" : "whole-seance"),
					new FileSessionStorage(),
					{ seance: true, suppressBreadcrumb: true, coldStore },
				);
				cleanups.push(() => forked.close());
				return { entries: wire(forked.getEntries()), context: wire(forked.buildSessionContext().messages) };
			};
			expect(await seance(true)).toEqual(await seance(false));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"compacts it again from the same preparation, into the same context",
		async () => {
			const { cold, whole } = await writeBoth();
			const preparation = (manager: SessionManager) =>
				wire(prepareCompaction(manager.getBranch(), { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 }));
			expect(preparation(cold)).toBeDefined();
			expect(preparation(cold)).toEqual(preparation(whole));
			for (const manager of [cold, whole]) {
				manager.appendCompaction("summary of the work so far", undefined, "u8", 2000);
				manager.buildSessionContext();
			}
			expect(wireUndated(cold.buildSessionContext().messages)).toEqual(
				wireUndated(whole.buildSessionContext().messages),
			);
			expect(cold.coldStoreStats().coldEntries).toBeGreaterThan(whole.coldStoreStats().coldEntries);
		},
		CASE_TIMEOUT_MS,
	);

	it.each<{ feature: string; read: (manager: SessionManager) => unknown; expected: unknown }>([
		{
			feature: "the TTSR rules injected",
			read: (manager: SessionManager) => manager.buildSessionContext().injectedTtsrRules,
			expected: ["no-console-log", "prefer-bun-file"],
		},
		{
			feature: "the model of each role",
			read: (manager: SessionManager) => ({
				models: manager.buildSessionContext().models,
				lastRole: manager.getLastModelChangeRole(),
			}),
			expected: {
				models: { default: "anthropic/claude-sonnet-4-5", smol: "anthropic/claude-haiku-4-5" },
				lastRole: "smol",
			},
		},
		{
			feature: "the thinking level",
			read: (manager: SessionManager) => {
				const context = manager.buildSessionContext();
				return { thinkingLevel: context.thinkingLevel, configured: context.configuredThinkingLevel };
			},
			expected: { thinkingLevel: "high", configured: "high" },
		},
		{
			feature: "the service tier",
			read: (manager: SessionManager) => manager.buildSessionContext().serviceTier,
			expected: { anthropic: "priority" },
		},
		{
			feature: "the mode",
			read: (manager: SessionManager) => {
				const context = manager.buildSessionContext();
				return { mode: context.mode, data: context.modeData };
			},
			expected: { mode: "plan", data: { planFile: "PLAN.md" } },
		},
		{
			feature: "the title",
			read: (manager: SessionManager) => manager.getSessionName(),
			expected: TITLE,
		},
	])(
		"restores $feature after a resume as a manager holding every entry does",
		async ({ read, expected }) => {
			const written = await writeSession(tempRoot(), "session");
			const { cold, whole } = await openBoth(written.file);
			expect(read(cold)).toEqual(expected);
			expect(read(cold)).toEqual(read(whole));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"restores the to-do list after a resume as a session over every entry does",
		async () => {
			const { cold, whole } = await writeBoth();
			const coldPhases = (await startSession(cold)).session.getTodoPhases();
			expect(wire(coldPhases)).toEqual(wire(phases("t3")));
			expect(wire(coldPhases)).toEqual(wire((await startSession(whole)).session.getTodoPhases()));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"restores each branch's to-do list after a move in the tree, reading the other branch's cold to-do edit back from the store, as a session over every entry does",
		async () => {
			// A to-do edit before the cut is cold; a move onto its branch that restored nothing, or the
			// live branch's list, would hand the user the wrong plan, and a move back would lose the live one.
			const { cold, whole } = await writeBoth({ todoEdits: true });
			const coldSession = (await startSession(cold)).session;
			const wholeSession = (await startSession(whole)).session;
			expect(wire(coldSession.getTodoPhases())).toEqual(wire(phases("ta")));
			expect(wire(coldSession.getTodoPhases())).toEqual(wire(wholeSession.getTodoPhases()));

			// The manager's move, read as the to-do tracker reads the branch before the context is rebuilt.
			const branchList = (manager: SessionManager) => wire(getLatestTodoPhasesFromEntries(manager.getBranch()));
			const before = cold.coldStoreStats().materializations;
			cold.branch("b3");
			whole.branch("b3");
			expect(branchList(cold)).toEqual(wire(phases("te")));
			expect(cold.coldStoreStats().materializations).toBe(before + 1);
			expect(branchList(cold)).toEqual(branchList(whole));
			cold.branch("a8");
			whole.branch("a8");
			expect(branchList(cold)).toEqual(wire(phases("ta")));
			expect(branchList(cold)).toEqual(branchList(whole));

			// The session's move in the tree, which rebuilds the context and then the to-do list.
			for (const [target, label] of [
				["b3", "te"],
				["a8", "ta"],
			]) {
				await coldSession.navigateTree(target);
				await wholeSession.navigateTree(target);
				expect(wire(coldSession.getTodoPhases())).toEqual(wire(phases(label)));
				expect(wire(coldSession.getTodoPhases())).toEqual(wire(wholeSession.getTodoPhases()));
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"restores the to-do list after a move in the tree to an entry after the cut whose newest snapshot is a cold to-do edit, reading it back from the store, and the live list after a move back, as a session over every entry does",
		async () => {
			// A to-do edit from the cut on that is not the newest snapshot is cold; a move to an entry before
			// the newer edit that restored nothing, or the live list, would hand the user the wrong plan, and a
			// move back would lose the live one.
			const { cold, whole } = await writeBoth({ todoEditsAfterCut: true });
			const coldSession = (await startSession(cold)).session;
			const wholeSession = (await startSession(whole)).session;
			const coldness = (id: string) => {
				const entry = cold.getEntry(id);
				if (!entry) throw new Error(`${id} was not loaded`);
				return isColdEntry(entry);
			};
			expect({ e1: coldness("e1"), e2: coldness("e2") }).toEqual({ e1: true, e2: false });
			expect(wire(coldSession.getTodoPhases())).toEqual(wire(phases("e2")));
			expect(wire(coldSession.getTodoPhases())).toEqual(wire(wholeSession.getTodoPhases()));

			// The manager's move, read as the to-do tracker reads the branch before the context is rebuilt.
			const branchList = (manager: SessionManager) => wire(getLatestTodoPhasesFromEntries(manager.getBranch()));
			const before = cold.coldStoreStats().materializations;
			cold.branch("a8");
			whole.branch("a8");
			expect(branchList(cold)).toEqual(wire(phases("e1")));
			expect(cold.coldStoreStats().materializations).toBeGreaterThan(before);
			expect(branchList(cold)).toEqual(branchList(whole));
			cold.branch("a10");
			whole.branch("a10");
			expect(branchList(cold)).toEqual(wire(phases("e2")));
			expect(branchList(cold)).toEqual(branchList(whole));

			// The session's move in the tree, which rebuilds the context and then the to-do list.
			for (const [target, label] of [
				["a8", "e1"],
				["a10", "e2"],
			]) {
				await coldSession.navigateTree(target);
				await wholeSession.navigateTree(target);
				expect(wire(coldSession.getTodoPhases())).toEqual(wire(phases(label)));
				expect(wire(coldSession.getTodoPhases())).toEqual(wire(wholeSession.getTodoPhases()));
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"restores a messaging extension's role claim, replay states, ledger and consumer state after a resume as a manager holding every entry does",
		async () => {
			// Custom entries stay whole before the cut; a resume that dropped or re-linked them would hand the
			// extension r1 or rb as its claim, a ledger missing rows, or q2's consumer state.
			const written = await writeSession(tempRoot(), "session", { relay: true });
			const { cold, whole } = await openBoth(written.file);
			const expected = wire(relayState(written.id).restored);
			const before = cold.coldStoreStats().materializations;
			expect(relayRestored(cold)).toEqual(expected);
			expect(relayRestored(cold)).toEqual(relayRestored(whole));
			expect(cold.coldStoreStats().materializations).toBe(before);
		},
		CASE_TIMEOUT_MS,
	);

	/** A parent session with a subagent transcript `Worker.jsonl` of the same shape in its artifacts directory. */
	async function withSubagent(): Promise<string> {
		const written = await writeSession(tempRoot(), "parent");
		const child = path.join(written.file.slice(0, -".jsonl".length), "Worker.jsonl");
		await Bun.write(child, sessionText(crypto.randomUUID(), written.cwd));
		return child;
	}

	it(
		"revives a subagent from the contract a manager holding every entry reads",
		async () => {
			const child = await withSubagent();
			// A revival reopens the transcript fresh and rebuilds the agent from its contract.
			const revived = async (coldStore: boolean) => {
				const reopened = await open(child, coldStore, { throwIfMissing: true });
				const init = extractSessionInit(reopened.getEntries());
				if (!init) throw new Error("The subagent has no contract");
				return { init: wire(init), definition: wire(persistedAgentDefinition("Worker", init)) };
			};
			const fromCold = await revived(true);
			expect(fromCold.init).toMatchObject({ task: "Refactor the module tree", tools: ["read", "todo", "probe"] });
			expect(fromCold).toEqual(await revived(false));
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"reads a subagent's own transcript as a manager holding every entry does",
		async () => {
			const child = await withSubagent();
			const { cold, whole } = await openBoth(child);
			expect(wire(cold.buildSessionContext({ transcript: true }).messages)).toEqual(
				wire(whole.buildSessionContext({ transcript: true }).messages),
			);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"reads no older body on the ten turns after the first one following a resume, with tool calls, prune passes and an extension reading every entry's small fields",
		async () => {
			const root = tempRoot();
			// More older rounds than the eight records a store keeps parsed: a read of a field gone cold
			// that every turn repeats over every message misses that cache and reads the store again.
			const written = await writeSession(root, "session", { olderTurns: 9 });
			const manager = await open(written.file, true);
			const extensionReads: unknown[] = [];
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("turn_end", (_event, ctx) => {
						const read = (entry: SessionEntry) => {
							const fields: unknown[] = [entry.type, entry.id, entry.parentId, entry.timestamp];
							if (entry.type === "message") {
								for (const field of MESSAGE_FIELDS_READ_EVERY_TURN)
									fields.push(Reflect.get(entry.message, field));
							}
							if (entry.type === "custom") fields.push(entry.data);
							return fields;
						};
						extensionReads.push(ctx.sessionManager.getEntries().map(read));
						extensionReads.push(ctx.sessionManager.getBranch().map(read));
					});
				},
				root,
				new EventBus(),
				runtime,
				"entry-reader",
			);
			const modelRegistry = new ModelRegistry(await AuthStorage.create(":memory:"));
			const extensionRunner = new ExtensionRunner([extension], runtime, root, manager, modelRegistry);
			const turns = 11;
			const responses: MockResponse[] = [];
			for (let turn = 0; turn < turns; turn++) {
				responses.push({ content: [{ type: "toolCall", name: "probe", arguments: { value: `turn ${turn}` } }] });
				responses.push({ content: [`turn ${turn} done`], stopReason: "stop" });
			}
			const executed: string[] = [];
			const { session } = await startSession(
				manager,
				{
					tools: [probeTool(executed)],
					responses,
					settings: { "compaction.supersedeReads": true, "compaction.dropUseless": true },
				},
				extensionRunner,
			);
			const prunePasses = vi.spyOn(pruning, "pruneSupersededToolResults");

			await session.prompt("turn 0");
			await session.waitForIdle();
			const afterFirstTurn = manager.coldStoreStats();
			expect(afterFirstTurn.coldEntries).toBeGreaterThan(10);
			for (let turn = 1; turn < turns; turn++) {
				await session.prompt(`turn ${turn}`);
				await session.waitForIdle();
			}

			expect(executed).toHaveLength(turns);
			expect(prunePasses.mock.calls.length).toBeGreaterThanOrEqual(turns);
			expect(extensionReads.length).toBeGreaterThanOrEqual(2 * turns);
			expect(manager.coldStoreStats().materializations).toBe(afterFirstTurn.materializations);
		},
		CASE_TIMEOUT_MS,
	);
});
