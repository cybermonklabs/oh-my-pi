import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ColdEntryStore, isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import {
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	};
}

async function writeEntries(dir: string, entries: object[]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	await Bun.write(file, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

/**
 * A turn whose tool call finished lies before the cut of `c1`; after the
 * compaction the process died with `call_new` started and unanswered.
 */
function interruptedSession(dir: string): Promise<string> {
	const message = (id: string, parentId: string | null, body: unknown) => ({
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: body,
	});
	return writeEntries(dir, [
		message("u1", null, { role: "user", content: `u1 ${BODY}`, timestamp: 1 }),
		message(
			"a1",
			"u1",
			assistant(
				[
					{ type: "text", text: `a1 ${BODY}` },
					{ type: "toolCall", id: "call_old", name: "bash", arguments: { command: "ls" } },
				],
				"toolUse",
			),
		),
		message("r1", "a1", {
			role: "toolResult",
			toolCallId: "call_old",
			toolName: "bash",
			content: [{ type: "text", text: `r1 ${BODY}` }],
			isError: false,
			timestamp: 3,
		}),
		message("u2", "r1", { role: "user", content: `u2 ${BODY}`, timestamp: 4 }),
		{
			type: "compaction",
			id: "c1",
			parentId: "u2",
			timestamp: TIMESTAMP,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "u2",
			tokensBefore: 1000,
		},
		message(
			"a2",
			"c1",
			assistant([{ type: "toolCall", id: "call_new", name: "bash", arguments: { command: "bun test" } }], "toolUse"),
		),
		{
			type: "custom",
			id: "x1",
			parentId: "a2",
			timestamp: TIMESTAMP,
			customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
			data: { toolCallId: "call_new", toolName: "bash", args: { command: "bun test" }, startedAt: TIMESTAMP },
		},
	]);
}

/** The custom entry type a manager that persists prune passes as appended records writes. */
const PRUNE_RECORD_TYPE = "tool_result_prune";
const PRUNABLE_RESULT_TEXT = `match line\n${BODY}`;

/**
 * A `grep` result flagged useless lies before the cut: a compaction that names
 * no kept entry cuts at itself, and the prune boundary it gives resolves
 * nowhere, so the next prune pass blanks the result. Blanking replaces only
 * its content; its large `details` stay. `now` dates the turn.
 */
function prunableResultSession(dir: string, now: number): Promise<string> {
	const message = (id: string, parentId: string | null, body: unknown) => ({
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: body,
	});
	return writeEntries(dir, [
		message("u1", null, { role: "user", content: "Investigate every module.", timestamp: now - 200 }),
		message("a1", "u1", {
			...assistant([{ type: "toolCall", id: "call_grep", name: "grep", arguments: { pattern: "TODO" } }], "toolUse"),
			timestamp: now - 180,
		}),
		message("r1", "a1", {
			role: "toolResult",
			toolCallId: "call_grep",
			toolName: "grep",
			content: [{ type: "text", text: PRUNABLE_RESULT_TEXT }],
			details: { matches: Array.from({ length: 64 }, (_, line) => `src/module-${line}.ts:1: // TODO`) },
			isError: false,
			useless: true,
			timestamp: now - 170,
		}),
		{
			type: "compaction",
			id: "c1",
			parentId: "r1",
			timestamp: TIMESTAMP,
			summary: `c1 ${BODY}`,
			firstKeptEntryId: "",
			tokensBefore: 1000,
		},
	]);
}

function open(file: string, coldStore: boolean): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true, coldStore });
}

describe("readers of the recent turns read no older body", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(
		sessionManager: SessionManager,
		dir: string,
		compaction = false,
		settings: Record<string, unknown> = {},
	): Promise<AgentSession> {
		const authStorage = await AuthStorage.create(path.join(dir, `auth-${crypto.randomUUID()}.db`));
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": compaction,
				"compaction.autoContinue": false,
				...settings,
			}),
			modelRegistry: new ModelRegistry(authStorage),
		});
		cleanups.push(() => session.dispose());
		return session;
	}

	it("warns about the pending call of a resumed session as a manager holding every entry does", async () => {
		using dir = TempDir.createSync("@omp-cold-readers-");
		const file = await interruptedSession(dir.path());
		const cold = await open(file, true);
		const whole = await open(file, false);
		expect(cold.coldStoreStats().coldEntries).toBe(3);

		const warning = describePendingToolCalls(cold.getBranchFromCut());
		expect(warning).toContain("call_new");
		expect(warning).toBe(describePendingToolCalls(whole.getBranch()));
		expect(cold.coldStoreStats().materializations).toBe(0);
	});

	it("records the pending call at exit without reading an older body", async () => {
		using dir = TempDir.createSync("@omp-cold-readers-");
		const exitRecord = async (coldStore: boolean): Promise<unknown> => {
			// The session's id is its directory's name, which must be unique: test
			// processes share session ownership leases, and a session another process
			// owns (this file run in parallel) moves to a new file at its next write,
			// a full write that reads every older body.
			const sessionDir = path.join(dir.path(), `${path.basename(dir.path())}-${coldStore ? "cold" : "whole"}`);
			const file = await interruptedSession(sessionDir);
			const session = await startSession(await open(file, coldStore), sessionDir);
			const materialize = vi.spyOn(ColdEntryStore.prototype, "materialize");
			await session.dispose();
			expect(materialize).not.toHaveBeenCalled();
			materialize.mockRestore();
			const reopened = await open(file, false);
			const exit = reopened
				.getEntries()
				.find(entry => entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE);
			await reopened.close();
			if (exit?.type !== "custom") throw new Error("Expected a session exit record");
			const data: unknown = exit.data;
			if (typeof data !== "object" || data === null) throw new Error("Expected session exit data");
			return { ...data, recordedAt: undefined };
		};

		const cold = await exitRecord(true);
		expect(cold).toMatchObject({ pendingToolCalls: [{ toolCallId: "call_new", toolName: "bash" }] });
		expect(cold).toEqual(await exitRecord(false));
	});

	it("elides a block of an entry before the cut, which goes back to the store with the placeholder", async () => {
		using dir = TempDir.createSync("@omp-cold-readers-");
		const fence = `\`\`\`ts\n${"const value = compute(a, b, c, d, e);\n".repeat(200)}\`\`\``;
		// A compaction that names no kept entry cuts at itself, and the shake boundary it gives resolves nowhere.
		const file = await writeEntries(dir.path(), [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: TIMESTAMP,
				message: { role: "user", content: "write it", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: TIMESTAMP,
				message: assistant([{ type: "text", text: `Here it is:\n${fence}\nDone. ${BODY}` }], "stop"),
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "a1",
				timestamp: TIMESTAMP,
				summary: `c1 ${BODY}`,
				firstKeptEntryId: "",
				tokensBefore: 1000,
			},
			{
				type: "message",
				id: "u2",
				parentId: "c1",
				timestamp: TIMESTAMP,
				message: { role: "user", content: `newer context\n${"tail ".repeat(4_000)}`, timestamp: 3 },
			},
		]);
		const sessionManager = await open(file, true);
		const a1 = sessionManager.getEntry("a1");
		if (!a1) throw new Error("a1 missing");
		expect(isColdEntry(a1)).toBe(true);
		const session = await startSession(sessionManager, dir.path(), true);

		const result = await session.shake("elide");

		expect(result.blocksDropped).toBe(1);
		expect(isColdEntry(a1)).toBe(true);
		const text = (entry: typeof a1) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content.map(block => (block.type === "text" ? block.text : "")).join("")
				: "";
		expect(text(a1)).not.toContain("const value = compute");
		const persisted = await open(file, false);
		const persistedA1 = persisted.getEntry("a1");
		await persisted.close();
		if (!persistedA1) throw new Error("persisted a1 missing");
		expect(text(persistedA1)).toBe(text(a1));
	});

	/**
	 * Run one finished turn, whose post-turn maintenance runs the prune passes
	 * with `compaction.dropUseless`. The context was built for the session's
	 * model before, as by the turns after a resume, so the cut is settled and
	 * the pass's own context rebuild moves no entry.
	 */
	async function finishTurnWithPrunePass(sessionManager: SessionManager, dir: string, now: number): Promise<void> {
		const session = await startSession(sessionManager, dir, false, { "compaction.dropUseless": true });
		session.buildDisplaySessionContext();
		const finalAssistant = { ...assistant([{ type: "text", text: "Continuing." }], "stop"), timestamp: now };
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	it("puts a result before the cut that a prune pass blanks back in the store, holding the blanked value", async () => {
		using dir = TempDir.createSync("@omp-cold-readers-");
		const now = Date.now();
		const file = await prunableResultSession(dir.path(), now);
		const sessionManager = await open(file, true);
		const r1 = sessionManager.getEntry("r1");
		if (r1?.type !== "message") throw new Error("r1 missing");
		expect(isColdEntry(r1)).toBe(true);

		await finishTurnWithPrunePass(sessionManager, dir.path(), now);

		expect(isColdEntry(r1)).toBe(true);
		if (r1.message.role !== "toolResult") throw new Error("r1 is not a tool result");
		expect(r1.message.prunedAt).toBeNumber();
		expect(JSON.stringify(r1.message)).not.toContain(PRUNABLE_RESULT_TEXT);
		// Whatever way the prune was persisted, a resume reads the same blanked result.
		await sessionManager.flush();
		const persisted = await open(file, false);
		const persistedR1 = persisted.getEntry("r1");
		await persisted.close();
		if (persistedR1?.type !== "message") throw new Error("persisted r1 missing");
		expect(JSON.parse(JSON.stringify(persistedR1.message))).toEqual(JSON.parse(JSON.stringify(r1.message)));
	});

	it("returns a result before the cut to the store with its previous values when persisting its prune fails", async () => {
		using dir = TempDir.createSync("@omp-cold-readers-");
		const now = Date.now();
		const sessionManager = await open(await prunableResultSession(dir.path(), now), true);
		const r1 = sessionManager.getEntry("r1");
		if (r1?.type !== "message") throw new Error("r1 missing");
		const rewriteEntries = vi
			.spyOn(sessionManager, "rewriteEntries")
			.mockRejectedValueOnce(new Error("injected rewrite failure"));

		await finishTurnWithPrunePass(sessionManager, dir.path(), now);

		expect(isColdEntry(r1)).toBe(true);
		// A pass persisted as an appended prune record has no failed rewrite to undo.
		const prunesAsRecords = sessionManager
			.getEntries()
			.some(entry => entry.type === "custom" && entry.customType === PRUNE_RECORD_TYPE);
		if (prunesAsRecords) return;
		expect(rewriteEntries).toHaveBeenCalledTimes(1);
		expect(r1.message).toMatchObject({
			content: [{ type: "text", text: PRUNABLE_RESULT_TEXT }],
			prunedAt: undefined,
		});
	});
});
