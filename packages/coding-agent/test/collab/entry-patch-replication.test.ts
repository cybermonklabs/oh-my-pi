/**
 * Contract: a field the host sets on an entry its guests already hold (an
 * `entry_patch` record, as an elide pass appends) reaches every live guest.
 * The TUI guest's replica entry and model context, and the web guest's
 * transcript row, read the new value, the same value as an entry written with
 * it inline, and no guest shows the record as an entry.
 *
 * And: the host's session holds entries it never sends (the
 * `tool_execution_start` record before each tool result, `entry_patch`
 * records in a welcome snapshot, other `custom` entries). The TUI guest walks
 * its replica's parent links to build its model context, after a record, at
 * the welcome and after a compaction, and that context holds what the host's
 * holds. A host of the older release (Cut17) links each entry it sends to the
 * parent its session gives it, one guests may never get; the TUI guest's
 * context holds what the host's holds from such a host too.
 *
 * A real host `SessionManager` broadcasts through `CollabHost`; the real TUI
 * `CollabGuestLink` and the real web `GuestClient` apply the frames. The
 * in-memory relay (./helpers/in-memory-relay) runs the real sockets.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateRoomKey, importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	COLLAB_PROTO,
	type CollabFrame,
	formatCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CONTEXT_NOTES_ENTRY_TYPE } from "@oh-my-pi/pi-coding-agent/session/context-notes";
import { TOOL_EXECUTION_START_CUSTOM_TYPE } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import { isEntryPatchRecord } from "@oh-my-pi/pi-utils/entry-patches";
import type { SessionEntry as WireSessionEntry } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../../../collab-web/src/lib/client";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const HEAVY = "heavy tool output";
const ELIDED = "[elided]";

/** Minimal host `InteractiveModeContext`: only the members `CollabHost` reads. */
function makeHostContext(manager: SessionManager): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: manager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

interface GuestHarness {
	guest: CollabGuestLink;
	session: AgentSession;
	dispose: () => Promise<void>;
}

/** Real TUI guest: a live `AgentSession` + `SessionManager` behind a `CollabGuestLink`; UI touchpoints are no-ops. */
function makeGuestHarness(): GuestHarness {
	const tempDir = TempDir.createSync("@pi-collab-entry-patch-");
	const manager = SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
	const session = new AgentSession({ agent, sessionManager: manager, settings: Settings.isolated(), modelRegistry });
	const ctx = {
		settings: Settings.isolated(),
		sessionManager: manager,
		session,
		statusContainer: { clear: () => {}, disposeChildren: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		ensureLoadingAnimation: () => {},
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			markActivityStart: () => {},
			markActivityEnd: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			resetActiveTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		syncRunningSubagentBadge: () => {},
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
		renderInitialMessages: () => Promise.resolve(),
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		showError: () => {},
		eventController: {
			dispatchSessionEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		eventBus: undefined,
		collabGuest: undefined,
		handleResumeSession: () => Promise.resolve(),
	} as unknown as InteractiveModeContext;
	const guest = new CollabGuestLink(ctx);
	return {
		guest,
		session,
		dispose: async () => {
			await guest.leave("test cleanup").catch(() => {});
			await session.dispose().catch(() => {});
			await tempDir.remove().catch(() => {});
		},
	};
}

/** Frames cross real WebCrypto seal/open, which settles on the event loop: poll until `predicate` holds. */
async function settleFrames(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	if (!predicate()) throw new Error("condition not met while settling collab frames");
}

/** `content` of a message entry, as the TUI replica or the web transcript holds it. */
function messageContent(entry: SessionEntry | WireSessionEntry | undefined): unknown {
	return entry?.type === "message" && "content" in entry.message ? entry.message.content : undefined;
}

/** A host holding one user message, `targetId`, that its guests receive in the welcome snapshot. */
async function startHost(): Promise<{ hostManager: SessionManager; host: CollabHost; targetId: string }> {
	const hostManager = SessionManager.inMemory();
	const targetId = hostManager.appendMessage({ role: "user", content: HEAVY, timestamp: 1 });
	const host = new CollabHost(makeHostContext(hostManager));
	await host.start("ws://localhost:8788");
	cleanups.push(() => host.stop("test done"));
	return { hostManager, host, targetId };
}

/**
 * On the live host: a control entry written with the field inline, the record
 * that sets the field on `targetId`, then one more entry. Frames apply in
 * order, so a guest holding the last entry has applied the record.
 */
async function patchLive(
	hostManager: SessionManager,
	targetId: string,
): Promise<{ controlId: string; lastId: string }> {
	const controlId = hostManager.appendMessage({ role: "user", content: ELIDED, timestamp: 2 });
	await hostManager.patchEntries([{ entryId: targetId, message: { content: ELIDED } }]);
	const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 3 });
	return { controlId, lastId };
}

/**
 * One tool turn as `AgentSession` writes it: the user's request, the call, the
 * `tool_execution_start` record (which guests never get), the result, the
 * reply. Returns the tool result's id.
 */
function appendToolTurn(manager: SessionManager, toolText: string): string {
	manager.appendMessage({ role: "user", content: "read a.txt", timestamp: 1 });
	const call: AssistantMessage = {
		...createAssistantMessage(""),
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }],
		stopReason: "toolUse",
	};
	manager.appendMessage(call);
	manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
		toolCallId: "call-1",
		toolName: "read",
		startedAt: new Date(0).toISOString(),
	});
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: toolText }],
		isError: false,
		timestamp: 3,
	};
	const toolId = manager.appendMessage(result);
	manager.appendMessage(createAssistantMessage("done"));
	return toolId;
}

/** What a model context holds of one message: its role and its text. */
interface ContextMessageView {
	role: string;
	content?: unknown;
	summary?: unknown;
}

/** What a model context holds of each message. */
function contextView(messages: readonly AgentMessage[]): ContextMessageView[] {
	return messages.map(message => ({
		role: message.role,
		...("content" in message && { content: message.content }),
		...("summary" in message && { summary: message.summary }),
	}));
}

/** Start a host on `hostManager` and join one TUI guest to it. */
async function joinTuiGuest(hostManager: SessionManager): Promise<GuestHarness> {
	const host = new CollabHost(makeHostContext(hostManager));
	await host.start("ws://localhost:8788");
	cleanups.push(() => host.stop("test done"));
	const harness = makeGuestHarness();
	cleanups.push(harness.dispose);
	await harness.guest.join(host.link);
	return harness;
}

/** The entry types a host of the older release (Cut17) sends: no `/clear` boundary, notebook or record. */
const OLDER_HOST_ENTRY_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

/**
 * Host `hostManager` as the older release (Cut17) does and join one TUI guest
 * to it. That host sends its entries of {@link OLDER_HOST_ENTRY_TYPES}, in its
 * welcome snapshot and live, each as its session holds it: an entry whose
 * parent is one the host never sends (the `tool_execution_start` record before
 * a tool result) names that parent.
 */
async function joinOlderHost(hostManager: SessionManager): Promise<GuestHarness> {
	const roomId = "older-host-room";
	const roomKey = generateRoomKey();
	const socket = new CollabSocket({
		wsUrl: `ws://localhost:8788/r/${roomId}`,
		role: "host",
		key: await importRoomKey(roomKey),
	});
	const opened = Promise.withResolvers<void>();
	socket.onOpen = () => opened.resolve();
	socket.onFrame = (frame, fromPeer) => {
		if (frame.t !== "hello") return;
		const snapshot = hostManager.snapshotForReplication();
		const entries = snapshot.entries.filter(entry => entry.type in OLDER_HOST_ENTRY_TYPES);
		const state: Extract<CollabFrame, { t: "welcome" }>["state"] = {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "older host session",
			cwd: "/tmp",
			participants: [{ name: "Host", role: "host" }],
		};
		const welcome: CollabFrame = {
			t: "welcome",
			proto: COLLAB_PROTO,
			header: snapshot.header,
			state,
			agents: [],
			entryCount: entries.length,
		};
		socket.send(welcome, fromPeer);
		if (entries.length > 0) socket.send({ t: "snapshot-chunk", entries, final: true }, fromPeer);
	};
	hostManager.onEntryAppended = entry => {
		if (entry.type in OLDER_HOST_ENTRY_TYPES) socket.send({ t: "entry", entry });
	};
	socket.connect();
	await opened.promise;
	cleanups.push(async () => {
		hostManager.onEntryAppended = undefined;
		socket.close();
	});
	const harness = makeGuestHarness();
	cleanups.push(harness.dispose);
	await harness.guest.join(formatCollabLink("ws://localhost:8788", roomId, roomKey));
	return harness;
}

/**
 * The probe that found the older host's links dropping a guest's history: a
 * tool turn, a guest's prompt (as `CollabHost` has the host's session write
 * it), then a user message. Returns the user message's id.
 */
function toolTurnThenGuestPrompt(manager: SessionManager): string {
	appendToolTurn(manager, HEAVY);
	manager.appendCustomMessageEntry(COLLAB_PROMPT_MESSAGE_TYPE, "a guest's prompt", true, { from: "guest" }, "user");
	return manager.appendMessage({ role: "user", content: "after the guest's prompt", timestamp: 9 });
}

/** The roles of the context {@link toolTurnThenGuestPrompt} leaves after a seed message. */
const PROBE_ROLES: AgentMessage["role"][] = ["user", "user", "assistant", "toolResult", "assistant", "custom", "user"];

/** Run the cleanups of the session so far, so one test can run two sessions in turn. */
async function endSession(): Promise<void> {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

// The guest writes its replica under getConfigRootDir(); redirect the config
// root to a temp HOME so the test never touches the real ~/.omp.
let homedirSpy: Mock<typeof os.homedir> | undefined;
let homeDir: TempDir | undefined;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

beforeAll(() => {
	homeDir = TempDir.createSync("@pi-collab-entry-patch-home-");
	homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir.path());
	refreshDirsFromEnv();
	installInMemoryRelay();
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("expected bundled anthropic model");
	model = bundled;
});

afterAll(async () => {
	uninstallInMemoryRelay();
	authStorage.close();
	homedirSpy?.mockRestore();
	refreshDirsFromEnv();
	await homeDir?.remove().catch(() => {});
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("collab host entry_patch → live guests", () => {
	it("sets the field on the TUI guest's replica entry and model context, and shows no record", async () => {
		const { hostManager, host, targetId } = await startHost();
		const harness = makeGuestHarness();
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		await settleFrames(() => harness.session.messages.length === 1);

		const { controlId, lastId } = await patchLive(hostManager, targetId);
		const replica = harness.session.sessionManager;
		await settleFrames(() => replica.getEntry(lastId) !== undefined);

		expect(messageContent(replica.getEntry(targetId))).toBe(ELIDED);
		expect(messageContent(replica.getEntry(targetId))).toBe(messageContent(replica.getEntry(controlId)));
		// The model context: the patched message, the control, the last entry; nothing from the record.
		expect(harness.session.messages.map(message => ("content" in message ? message.content : message.role))).toEqual([
			ELIDED,
			ELIDED,
			"after",
		]);
	});

	it("sets the field on the web guest's transcript row, and lists no record", async () => {
		const { hostManager, host, targetId } = await startHost();
		const web = new GuestClient(host.link, "web guest");
		cleanups.push(async () => web.close());
		web.connect();
		await settleFrames(() => web.getSnapshot().phase === "live" && web.getSnapshot().entries.length === 1);

		const { controlId, lastId } = await patchLive(hostManager, targetId);
		await settleFrames(() => web.getSnapshot().entries.some(entry => entry.id === lastId));

		const entries = web.getSnapshot().entries;
		expect(entries.map(entry => entry.id)).toEqual([targetId, controlId, lastId]);
		expect(entries.map(messageContent)).toEqual([ELIDED, ELIDED, "after"]);
	});

	it("sends no record past the frame ceiling, only a notice, never a truncated value", async () => {
		const { hostManager, host, targetId } = await startHost();
		const harness = makeGuestHarness();
		cleanups.push(harness.dispose);
		await harness.guest.join(host.link);
		const web = new GuestClient(host.link, "web guest");
		cleanups.push(async () => web.close());
		web.connect();
		await settleFrames(() => web.getSnapshot().phase === "live" && web.getSnapshot().entries.length === 1);

		const oversized = "x".repeat(MAX_REPLICATED_PAYLOAD_BYTES + 1);
		await hostManager.patchEntries([{ entryId: targetId, message: { content: oversized } }]);
		const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 3 });
		const replica = harness.session.sessionManager;
		await settleFrames(
			() => web.getSnapshot().entries.some(entry => entry.id === lastId) && replica.getEntry(lastId) !== undefined,
		);

		const snapshot = web.getSnapshot();
		expect(snapshot.entries.map(entry => entry.id)).toEqual([targetId, lastId]);
		// The guests keep the value they had; a resync brings the host's.
		expect(messageContent(snapshot.entries[0])).toBe(HEAVY);
		expect(snapshot.notices.map(notice => notice.message)).toContain(
			"Host entry omitted: too large to replicate (entry_patch).",
		);
		expect(replica.getEntries().filter(isEntryPatchRecord)).toEqual([]);
		expect(contextView(harness.session.messages)).toEqual([
			{ role: "user", content: HEAVY },
			{ role: "user", content: "after" },
		]);
	});
});

describe("collab host → TUI guest model context, past entries guests never get", () => {
	/** A live tool turn, its result's field set inline or by a record, then one more message. */
	async function liveToolTurn(
		mode: "inline" | "record",
	): Promise<{ guest: ContextMessageView[]; host: ContextMessageView[] }> {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const harness = await joinTuiGuest(hostManager);
		const toolId = appendToolTurn(hostManager, mode === "inline" ? ELIDED : HEAVY);
		if (mode === "record") {
			await hostManager.patchEntries([{ entryId: toolId, message: { content: [{ type: "text", text: ELIDED }] } }]);
		}
		const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 9 });
		await settleFrames(() => harness.session.sessionManager.getEntry(lastId) !== undefined);
		const seen = {
			guest: contextView(harness.session.messages),
			host: contextView(hostManager.buildSessionContext().messages),
		};
		await endSession();
		return seen;
	}

	it("keeps the history above a tool result when a record on it arrives, as the inline control does", async () => {
		const control = await liveToolTurn("inline");
		const patched = await liveToolTurn("record");
		expect(control.guest.map(message => message.role)).toEqual([
			"user",
			"user",
			"assistant",
			"toolResult",
			"assistant",
			"user",
		]);
		expect(patched.guest).toEqual(control.guest);
		expect(patched.guest).toEqual(patched.host);
	});

	it("gives a joining guest the whole context of a session with a tool call and a record", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const toolId = appendToolTurn(hostManager, HEAVY);
		await hostManager.patchEntries([{ entryId: toolId, message: { content: [{ type: "text", text: ELIDED }] } }]);
		// The welcome snapshot carries no record, and this entry's parent is one.
		hostManager.appendMessage({ role: "user", content: "after", timestamp: 9 });

		const harness = await joinTuiGuest(hostManager);

		const guest = contextView(harness.session.messages);
		expect(guest).toHaveLength(6);
		expect(guest).toContainEqual({ role: "toolResult", content: [{ type: "text", text: ELIDED }] });
		expect(guest).toEqual(contextView(hostManager.buildSessionContext().messages));
	});

	it("rebuilds the context from a record, so a custom message's patched content shows", async () => {
		// A custom message's model message is built from its entry, so setting the
		// entry's field changes the context only through a rebuild.
		const run = async (mode: "inline" | "record"): Promise<ContextMessageView[]> => {
			const hostManager = SessionManager.inMemory();
			hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
			const noteId = hostManager.appendCustomMessageEntry("probe-note", mode === "inline" ? ELIDED : HEAVY, true);
			hostManager.appendMessage(createAssistantMessage("done"));
			const harness = await joinTuiGuest(hostManager);
			if (mode === "record") await hostManager.patchEntries([{ entryId: noteId, entry: { content: ELIDED } }]);
			const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 9 });
			await settleFrames(() => harness.session.sessionManager.getEntry(lastId) !== undefined);
			const guest = contextView(harness.session.messages);
			await endSession();
			return guest;
		};
		const control = await run("inline");
		expect(control).toContainEqual({ role: "custom", content: ELIDED });
		expect(await run("record")).toEqual(control);
	});

	it("rebuilds the whole context from a record written after an entry guests never get", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const harness = await joinTuiGuest(hostManager);
		const toolId = appendToolTurn(hostManager, HEAVY);
		hostManager.appendCustomEntry("probe-state", { step: 1 });
		await hostManager.patchEntries([{ entryId: toolId, message: { content: [{ type: "text", text: ELIDED }] } }]);
		const recordId = hostManager.getLeafId();
		if (!recordId) throw new Error("expected the record as the host's leaf");
		await settleFrames(() => harness.session.sessionManager.getEntry(recordId) !== undefined);

		const guest = contextView(harness.session.messages);
		expect(guest).toHaveLength(5);
		expect(guest).toEqual(contextView(hostManager.buildSessionContext().messages));
	});

	it("keeps a compaction's kept history when its cut starts at an entry guests never get", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "first", timestamp: 0 });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const harness = await joinTuiGuest(hostManager);
		// A cut takes in the non-message entries just before its first kept message.
		const keptId = hostManager.appendCustomEntry("probe-state", { step: 1 });
		hostManager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
		appendToolTurn(hostManager, HEAVY);
		hostManager.appendCompaction("SUMMARY", undefined, keptId, 100);
		await settleFrames(() => harness.session.messages[0]?.role === "compactionSummary");

		const guest = contextView(harness.session.messages);
		expect(guest.map(message => message.role)).toEqual([
			"compactionSummary",
			"user",
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(guest).toEqual(contextView(hostManager.buildSessionContext().messages));
	});

	it("keeps the turns after a native compaction's replay point when that point is an entry guests never get", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "first", timestamp: 0 });
		const harness = await joinTuiGuest(hostManager);
		const throughId = hostManager.appendCustomEntry("probe-state", { step: 1 });
		hostManager.appendMessage(createAssistantMessage("after the replay point"));
		hostManager.appendCompaction("SUMMARY", undefined, "", 100, {
			providerReplayThroughEntryId: throughId,
			preserveData: { anthropicCompaction: { provider: "anthropic", content: "SUMMARY", signature: "sig" } },
		});
		await settleFrames(() => harness.session.messages[0]?.role === "compactionSummary");

		const guest = contextView(harness.session.messages);
		expect(guest.map(message => message.role)).toEqual(["compactionSummary", "assistant"]);
		expect(guest).toEqual(contextView(hostManager.buildSessionContext().messages));
	});
});

describe("collab host → TUI guest model context, the host's after each live entry", () => {
	/**
	 * Once the guest holds `lastId`: its agent messages (`/dump`, context
	 * estimates) and a context rebuild from its replica both equal the host's
	 * model context.
	 */
	async function expectHostContext(harness: GuestHarness, hostManager: SessionManager, lastId: string): Promise<void> {
		await settleFrames(() => harness.session.sessionManager.getEntry(lastId) !== undefined);
		const host = contextView(hostManager.buildSessionContext().messages);
		expect(contextView(harness.session.messages)).toEqual(host);
		expect(contextView(harness.session.buildDisplaySessionContext().messages)).toEqual(host);
	}

	const NOTES = { version: 1, text: "Keep the rollback plan." };

	it("adds a live custom message to the context", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const harness = await joinTuiGuest(hostManager);
		const noteId = hostManager.appendCustomMessageEntry("probe-note", "a note for the model", true);
		await expectHostContext(harness, hostManager, noteId);
		expect(contextView(harness.session.messages)).toContainEqual({ role: "custom", content: "a note for the model" });
	});

	it("drops the history before a live /clear boundary", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "before the clear", timestamp: 0 });
		hostManager.appendMessage(createAssistantMessage("reply"));
		const harness = await joinTuiGuest(hostManager);
		hostManager.appendResetBoundary();
		const lastId = hostManager.appendMessage({ role: "user", content: "after the clear", timestamp: 1 });
		await expectHostContext(harness, hostManager, lastId);
		expect(contextView(harness.session.messages)).toEqual([{ role: "user", content: "after the clear" }]);
	});

	it("adds the context notebook a live entry writes", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const harness = await joinTuiGuest(hostManager);
		hostManager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, NOTES);
		const lastId = hostManager.appendMessage({ role: "user", content: "after the notes", timestamp: 1 });
		await expectHostContext(harness, hostManager, lastId);
		expect(harness.session.messages.map(message => message.role)).toEqual(["custom", "user", "user"]);
	});

	it("gives a joining guest the context of a session with a /clear boundary and a notebook", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "before the clear", timestamp: 0 });
		hostManager.appendMessage(createAssistantMessage("reply"));
		hostManager.appendResetBoundary();
		hostManager.appendCustomEntry(CONTEXT_NOTES_ENTRY_TYPE, NOTES);
		const lastId = hostManager.appendMessage({ role: "user", content: "after the clear", timestamp: 1 });
		const harness = await joinTuiGuest(hostManager);
		await expectHostContext(harness, hostManager, lastId);
		expect(harness.session.messages.map(message => message.role)).toEqual(["custom", "user"]);
	});

	it("keeps the whole context after a tool turn and a guest's prompt from an older host, whose links name entries it never sends", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const harness = await joinOlderHost(hostManager);
		const lastId = toolTurnThenGuestPrompt(hostManager);
		await expectHostContext(harness, hostManager, lastId);
		expect(harness.session.messages.map(message => message.role)).toEqual(PROBE_ROLES);
	});

	it("keeps the whole context after a tool turn and a guest's prompt from a host that links each entry to one it sends", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const harness = await joinTuiGuest(hostManager);
		const lastId = toolTurnThenGuestPrompt(hostManager);
		await expectHostContext(harness, hostManager, lastId);
		expect(harness.session.messages.map(message => message.role)).toEqual(PROBE_ROLES);
	});

	it("gives a joining guest the whole context of a session with a tool turn and a guest's prompt from an older host", async () => {
		const hostManager = SessionManager.inMemory();
		hostManager.appendMessage({ role: "user", content: "seed", timestamp: 0 });
		const lastId = toolTurnThenGuestPrompt(hostManager);
		const harness = await joinOlderHost(hostManager);
		await expectHostContext(harness, hostManager, lastId);
		expect(harness.session.messages.map(message => message.role)).toEqual(PROBE_ROLES);
	});
});
