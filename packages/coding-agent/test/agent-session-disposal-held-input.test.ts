import { afterAll, afterEach, beforeAll, expect, test, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgCompactionKeepRecentTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

// Input a user has already given is never lost to a lifecycle transition that happens to be in
// flight. Each case below holds accepted input, or an identity move, across an await that
// disposal can overtake, and checks that the input is written exactly once, to the session it
// belongs to, before that session's session_exit. The last cases are the negative side: with
// no disposal in flight the same input is published once, to the right session, and never again.

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected bundled test model");

let tempDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];
let sessionDirs = 0;

beforeAll(async () => {
	tempDir = TempDir.createSync("@pi-disposal-held-input-");
	await initTheme();
	authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	vi.restoreAllMocks();
});

afterAll(() => {
	authStorage.close();
	tempDir.removeSync();
});

async function createSession(
	options: { baseUrl?: string; streamFn?: StreamFn; extension?: ExtensionFactory; settings?: Settings } = {},
) {
	const directory = path.join(tempDir.path(), `session-${++sessionDirs}`);
	const storage = new FileSessionStorage();
	const manager = SessionManager.create(directory, directory, storage);
	const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: options.baseUrl ? { ...model!, baseUrl: options.baseUrl } : model!,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		...(options.baseUrl ? {} : { streamFn: options.streamFn ?? mock.stream }),
	});
	let extensionRunner: ExtensionRunner | undefined;
	if (options.extension) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			options.extension,
			directory,
			new EventBus(),
			runtime,
			"disposal-held-input",
		);
		extensionRunner = new ExtensionRunner([extension], runtime, directory, manager, modelRegistry);
	}
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: options.settings ?? Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner,
	});
	sessions.push(session);
	return { session, manager, agent, storage };
}

/** One line per entry of a session file: custom types, custom messages, and message role:text. */
async function persistedRows(sessionFile: string): Promise<string[]> {
	const reopened = await SessionManager.open(sessionFile, path.dirname(sessionFile));
	const entries = reopened.getEntries();
	await reopened.close();
	return entries.map(entry => {
		if (entry.type === "custom") return entry.customType;
		if (entry.type === "custom_message") {
			return `${entry.customType}:${typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)}`;
		}
		if (entry.type !== "message") return entry.type;
		const message = entry.message;
		if (message.role === "bashExecution") return `bash:${message.output}`;
		if (message.role !== "user" && message.role !== "assistant") return message.role;
		const content = message.content;
		const text =
			typeof content === "string" ? content : content.map(part => ("text" in part ? part.text : "")).join("");
		return `${message.role}:${text}`;
	});
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a persisted session file");
	return file;
}

function anthropicStream(text: string): string {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function launchCompletion(session: AgentSession, name: string) {
	const owner = session.sessionManager.getSessionId();
	return session.queueLaunchCompletion({
		event: "daemon-completed",
		completionId: `${name}-completion`,
		owner,
		daemon: {
			name,
			id: `${name}-id`,
			state: "exited",
			createdAt: 1,
			startedAt: 1,
			exitedAt: 2,
			exitCode: 7,
			restartCount: 0,
			outputBytes: 0,
			owner,
			persist: false,
			detached: false,
		},
	});
}

/** Runs `initial` with its request held, so `accept` can queue input while the turn streams. */
async function withHeldFirstTurn(accept: (session: AgentSession) => Promise<void>) {
	const first = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
	let calls = 0;
	const created = await createSession({
		streamFn: async (requestModel, context, options) => {
			if (++calls === 1) {
				first.resolve();
				await release.promise;
			}
			return mock.stream(requestModel, context, options);
		},
	});
	const initial = created.session.prompt("initial");
	await withTimeout(first.promise, 15_000, "The first request did not start");
	await accept(created.session);
	release.resolve();
	await initial;
	return created;
}

// F1: the agent barrier and every abort are set before any callback runs, and a callback that
// throws neither leaves them unset nor stops the rest of teardown.
test("a disposer that throws inside beginDispose leaves the barrier set: the held request is never sent", async () => {
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requests.push(request.url);
			return new Response(anthropicStream("sent after disposal"), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	try {
		const { session, agent } = await createSession({ baseUrl: `http://127.0.0.1:${server.port}` });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		agent.addBeforeModelCall(async () => {
			entered.resolve();
			await release.promise;
		});
		let later = false;
		session.addDisposer(() => {
			throw new Error("resource close failed");
		});
		session.addDisposer(() => {
			later = true;
		});
		const running = session.prompt("must not reach the provider").catch(() => undefined);
		await withTimeout(entered.promise, 15_000, "The model-call hook did not run");

		let thrown: unknown;
		try {
			session.beginDispose();
		} catch (error) {
			thrown = error;
		}
		release.resolve();
		await running;
		await session.dispose().catch(() => undefined);

		expect(requests).toEqual([]);
		expect(agent.isDisposing).toBe(true);
		expect(later).toBe(true);
		expect(thrown).toBeUndefined();
	} finally {
		server.stop(true);
	}
}, 30_000);

// F2: disposal is not staleness. A launch completion queued while the session was live is
// recorded, and its receipt resolves.
test("a launch completion queued before disposal is recorded once and its receipt resolves", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	const receipt = launchCompletion(session, "queued-before-disposal").then(
		() => "resolved",
		(error: unknown) => `rejected: ${String(error)}`,
	);
	const file = sessionFileOf(manager);
	session.beginDispose();
	await session.dispose();

	expect(await receipt).toBe("resolved");
	const rows = await persistedRows(file);
	expect(rows.filter(row => row.includes("queued-before-disposal"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

// F3: every identity move publishes its outgoing identity and kept input before its first await,
// so a move that outlasts dispose()'s wait still leaves the final record in the outgoing file.
for (const operation of ["newSession", "fork", "branch"] as const) {
	test(`a ${operation} whose successor write outlasts the disposal wait leaves the kept input and session_exit in the outgoing file`, async () => {
		const { session, manager, storage } = await withHeldFirstTurn(async session => {
			await session.sendCustomMessage(
				{ customType: "kept-held-move", content: `before ${operation}`, display: true },
				{ deliverAs: "nextTurn" },
			);
		});
		const outgoing = sessionFileOf(manager);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const write = storage.writeLinesAtomic.bind(storage);
		let successor = "";
		vi.spyOn(storage, "writeLinesAtomic").mockImplementation(async (file, lines, options) => {
			if (file !== outgoing && !successor) {
				successor = file;
				entered.resolve();
				await release.promise;
			}
			await write(file, lines, options);
		});
		const rootUser = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
		if (!rootUser) throw new Error("Expected the initial user message");
		const moving =
			operation === "branch"
				? session.branch(rootUser.id)
				: operation === "fork"
					? session.fork()
					: session.newSession();
		const settled = moving.then(
			value => ({ value }),
			(error: unknown) => ({ error: String(error) }),
		);
		try {
			await withTimeout(entered.promise, 15_000, "The manager did not reach the successor write");
			session.beginDispose();
			// The wait elapses while the successor write is held.
			await session.dispose({ drainTimeoutMs: 200 });
		} finally {
			release.resolve();
		}
		const result = await settled;

		// newSession() and fork() report a cancellation as false; branch() as { cancelled: true }.
		if (operation === "branch") expect(result).toMatchObject({ value: { cancelled: true } });
		else expect(result).toEqual({ value: false });
		const rows = await persistedRows(outgoing);
		expect(rows.filter(row => row === `kept-held-move:before ${operation}`)).toHaveLength(1);
		expect(rows.filter(row => row === "session_exit")).toHaveLength(1);
		expect(rows.at(-1)).toBe("session_exit");
		expect(await Bun.file(successor).exists()).toBe(false);
	}, 30_000);
}

// F7: a /delete begun into disposal keeps the deletion, and the kept input reaches the successor's
// file although the successor has no assistant turn.
test("a /delete overtaken by disposal writes the kept input to its successor and leaves the outgoing file deleted", async () => {
	const { session, manager } = await withHeldFirstTurn(async session => {
		await session.sendCustomMessage(
			{ customType: "kept-delete-input", content: "accepted before delete", display: true },
			{ deliverAs: "nextTurn" },
		);
	});
	const outgoing = sessionFileOf(manager);
	const newSession = manager.newSession.bind(manager);
	vi.spyOn(manager, "newSession").mockImplementation(options => {
		const moving = newSession(options);
		queueMicrotask(() => session.beginDispose());
		return moving;
	});

	expect(await session.newSession({ drop: true })).toBe(true);
	const successor = sessionFileOf(manager);
	await session.dispose();

	expect(successor).not.toBe(outgoing);
	expect(await Bun.file(outgoing).exists()).toBe(false);
	const rows = await persistedRows(successor);
	expect(rows.filter(row => row === "kept-delete-input:accepted before delete")).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

// F5: an accepted IRC wake record is withdrawable before any await: one waiting on a compaction's
// session_before_compact hook, and one waiting on a pooled prompt rebuild.
test("an accepted IRC wake waiting on a held compaction is recorded once when disposal outlasts the compaction", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const settings = Settings.isolated({ "compaction.enabled": false });
	cfgCompactionKeepRecentTokens.set(settings, 1);
	const { session, manager } = await createSession({
		settings,
		extension: pi => {
			pi.on("session_before_compact", async event => {
				entered.resolve();
				await release.promise;
				return {
					compaction: {
						summary: "must not commit",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			});
		},
	});
	await session.prompt("first task");
	await session.prompt("second task");
	const file = sessionFileOf(manager);
	const compacting = session.compact(undefined, { mode: "soft" }).catch(() => undefined);
	try {
		await withTimeout(entered.promise, 15_000, "The compaction hook did not run");
		const receipt = await session.deliverIrcMessage({
			id: "held-compaction-wake",
			from: "peer",
			to: "main",
			body: "accepted while compacting",
			ts: Date.now(),
		});
		expect(receipt).toBe("woken");
		session.beginDispose();
		await withTimeout(session.dispose(), 15_000, "dispose() did not finish while the compaction waited");
	} finally {
		release.resolve();
		await compacting;
	}

	const rows = await persistedRows(file);
	expect(rows.filter(row => row.includes("accepted while compacting"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

test("an accepted IRC wake waiting on a pooled prompt rebuild is recorded once when disposal outlasts the rebuild", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	await session.setWorkPoolYieldItems([{ id: "item", index: 0 }]);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const refresh = session.refreshBaseSystemPrompt.bind(session);
	vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async () => {
		entered.resolve();
		await release.promise;
		await refresh();
	});
	const transition = session.setWorkPoolYieldItems([]);
	const file = sessionFileOf(manager);
	try {
		await withTimeout(entered.promise, 15_000, "The pooled rebuild did not start");
		const receipt = await session.deliverIrcMessage({
			id: "held-pool-wake",
			from: "peer",
			to: "main",
			body: "accepted behind the pool rebuild",
			ts: Date.now(),
		});
		expect(receipt).toBe("woken");
		session.beginDispose();
		await session.dispose();
	} finally {
		release.resolve();
		await transition.catch(() => undefined);
	}
	const tick = Promise.withResolvers<void>();
	setImmediate(tick.resolve);
	await tick.promise;

	const rows = await persistedRows(file);
	expect(rows.filter(row => row.includes("accepted behind the pool rebuild"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

// A seventh place: a user Bash result that finished while a turn streamed waits for that turn's
// end; disposal took it from that wait and dropped it.
test("a user Bash result waiting for the streaming turn's end is recorded once at disposal", async () => {
	const first = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const mock = createMockModel({ handler: () => ({ content: ["answer"] }) });
	const { session, manager } = await createSession({
		streamFn: async (requestModel, context, options) => {
			first.resolve();
			await release.promise;
			return mock.stream(requestModel, context, options);
		},
	});
	const running = session.prompt("initial").catch(() => undefined);
	await withTimeout(first.promise, 15_000, "The first request did not start");
	const result = await session.executeBash("printf held-bash-result");
	expect(result.output).toContain("held-bash-result");
	const file = sessionFileOf(manager);
	session.beginDispose();
	release.resolve();
	await running;
	await session.dispose();

	const rows = await persistedRows(file);
	expect(rows.filter(row => row.startsWith("bash:") && row.includes("held-bash-result"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

// Negative side: with no disposal in flight, accepted input is published exactly once, to the
// session it belongs to, and a later disposal with nothing in flight adds nothing.
test("with no disposal in flight a launch completion is delivered once, and a later disposal adds no second copy", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	await launchCompletion(session, "delivered-live");
	await session.waitForIdle();
	const file = sessionFileOf(manager);
	const before = (await persistedRows(file)).filter(row => row.includes("delivered-live"));
	await session.dispose();

	expect(before).toHaveLength(1);
	const rows = await persistedRows(file);
	expect(rows.filter(row => row.includes("delivered-live"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

test("with no disposal in flight an IRC wake records its message once, and a later disposal adds no second copy", async () => {
	const { session, manager } = await createSession();
	await session.prompt("initial");
	expect(
		await session.deliverIrcMessage({
			id: "live-wake",
			from: "peer",
			to: "main",
			body: "woken live",
			ts: Date.now(),
		}),
	).toBe("woken");
	await session.waitForIdle();
	const file = sessionFileOf(manager);
	await session.dispose();

	const rows = await persistedRows(file);
	expect(rows.filter(row => row.includes("woken live"))).toHaveLength(1);
	expect(rows.at(-1)).toBe("session_exit");
}, 30_000);

test("a fork with no disposal in flight carries its pending input into the fork once, never back into the outgoing file", async () => {
	const { session, manager } = await withHeldFirstTurn(async session => {
		await session.sendCustomMessage(
			{ customType: "kept-fork-input", content: "accepted before fork", display: true },
			{ deliverAs: "nextTurn" },
		);
	});
	const outgoing = sessionFileOf(manager);
	expect(await session.fork()).toBe(true);
	const successor = sessionFileOf(manager);
	await session.dispose();

	expect(successor).not.toBe(outgoing);
	const outgoingRows = await persistedRows(outgoing);
	expect(outgoingRows.filter(row => row.startsWith("kept-fork-input"))).toHaveLength(0);
	expect(outgoingRows).not.toContain("session_exit");
	const successorRows = await persistedRows(successor);
	expect(successorRows.filter(row => row === "kept-fork-input:accepted before fork")).toHaveLength(1);
	expect(successorRows.filter(row => row === "session_exit")).toHaveLength(1);
}, 30_000);

test("a disposal with nothing in flight writes no input entry and creates no file for a session that never ran a turn", async () => {
	const { session, manager } = await createSession();
	const file = manager.getSessionFile();
	await session.dispose();

	expect(file === undefined || !(await Bun.file(file).exists())).toBe(true);
}, 30_000);
