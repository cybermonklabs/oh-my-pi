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
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { resolveResumeTarget } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { extractSessionInit, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { persistedAgentDefinition } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TITLE = "Refactor the module tree";
/** Each case writes, resumes and compares two copies of a session; one runs ten model turns. */
const CASE_TIMEOUT_MS = 60_000;

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

/**
 * A titled session. On the current path: `c1` keeps from `u2`, `c2` from
 * `u4`, `c3` from `u7` (the cut). Before the cut lie a session contract
 * (`s0`), two to-do results (`t1`, then `t3`, the list), model changes for
 * the default and the `smol` role, a thinking level, a service tier, a TTSR
 * injection, a plan mode, a custom entry, a custom message, and a second
 * branch off `c2` (`b1`, `b2`) left for `bs`. With `interrupted`, the last
 * turn stopped after a `probe` call that never got its result.
 */
function sessionText(id: string, cwd: string, options: { interrupted?: boolean } = {}): string {
	const lines: object[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd }];
	const add = (entryType: string, entryId: string, parentId: string | null, fields: object) =>
		lines.push({ type: entryType, id: entryId, parentId, timestamp: TIMESTAMP, ...fields });
	const user = (entryId: string, parentId: string) =>
		add("message", entryId, parentId, {
			message: { role: "user", content: [{ type: "text", text: text(entryId) }], timestamp: 1 },
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
	user("u2", "x1");
	assistant("a2", "u2");
	compaction("c1", "a2", "u2");
	add("thinking_level_change", "k1", "c1", { thinkingLevel: "high", configured: "high" });
	add("model_change", "m2", "k1", { model: "anthropic/claude-haiku-4-5", role: "smol" });
	add("service_tier_change", "st", "m2", { serviceTier: { anthropic: "priority" } });
	add("ttsr_injection", "tt", "st", { injectedRules: ["no-console-log", "prefer-bun-file"] });
	add("mode_change", "md", "tt", { mode: "plan", data: { planFile: "PLAN.md" } });
	user("u3", "md");
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
	user("b1", "c2");
	assistant("b2", "b1");
	add("branch_summary", "bs", "a5", { fromId: "b2", summary: text("bs") });
	user("u6", "bs");
	assistant("a6", "u6");
	user("u7", "a6");
	assistant("a7", "u7");
	compaction("c3", "a7", "u7");
	user("u8", "c3");
	assistant("a8", "u8");
	if (options.interrupted) {
		user("u9", "a8");
		assistant("a9", "u9", { id: "call_probe", name: "probe", arguments: { value: "again" } });
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
async function writeSession(
	root: string,
	name: string,
	options: { interrupted?: boolean } = {},
): Promise<WrittenSession> {
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
	async function writeBoth(options: { interrupted?: boolean } = {}) {
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
			const written = await writeSession(root, "session");
			const manager = await open(written.file, true);
			const extensionReads: unknown[] = [];
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("turn_end", (_event, ctx) => {
						const read = (entry: SessionEntry) => {
							const fields: unknown[] = [entry.type, entry.id, entry.parentId, entry.timestamp];
							if (entry.type === "message") {
								const message = entry.message;
								fields.push(message.role, message.timestamp);
								if (message.role === "assistant") fields.push(message.stopReason);
								if (message.role === "toolResult") fields.push(message.toolCallId);
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
