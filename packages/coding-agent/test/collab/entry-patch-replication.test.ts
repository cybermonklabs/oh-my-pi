/**
 * Contract: a field the host sets on an entry its guests already hold (an
 * `entry_patch` record, as an elide pass appends) reaches every live guest.
 * The TUI guest's replica entry and model context, and the web guest's
 * transcript row, read the new value, the same value as an entry written with
 * it inline, and no guest shows the record as an entry.
 *
 * A real host `SessionManager` broadcasts through `CollabHost`; the real TUI
 * `CollabGuestLink` and the real web `GuestClient` apply the frames. The
 * in-memory relay (./helpers/in-memory-relay) runs the real sockets.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { MAX_REPLICATED_PAYLOAD_BYTES } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";
import type { SessionEntry as WireSessionEntry } from "@oh-my-pi/pi-wire";
import { GuestClient } from "../../../collab-web/src/lib/client";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
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

	it("sends a record past the frame ceiling as one that sets nothing, with a notice, never a truncated value", async () => {
		const { hostManager, host, targetId } = await startHost();
		const web = new GuestClient(host.link, "web guest");
		cleanups.push(async () => web.close());
		web.connect();
		await settleFrames(() => web.getSnapshot().phase === "live" && web.getSnapshot().entries.length === 1);

		const oversized = "x".repeat(MAX_REPLICATED_PAYLOAD_BYTES + 1);
		await hostManager.patchEntries([{ entryId: targetId, message: { content: oversized } }]);
		const lastId = hostManager.appendMessage({ role: "user", content: "after", timestamp: 3 });
		await settleFrames(() => web.getSnapshot().entries.some(entry => entry.id === lastId));

		const snapshot = web.getSnapshot();
		expect(snapshot.entries.map(entry => entry.id)).toEqual([targetId, lastId]);
		// The guest keeps the value it had; a resync brings the host's.
		expect(messageContent(snapshot.entries[0])).toBe(HEAVY);
		expect(snapshot.notices.map(notice => notice.message)).toContain(
			"Host entry omitted: too large to replicate (entry_patch).",
		);
	});
});
