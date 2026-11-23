/**
 * A configuration sync turns `grep` on (or off) under a session whose prompt is bound: the session holds the change,
 * and its hidden notice says the change is held until a deadline, with `grep` available (or still listed) until the
 * rebuild. `/tan` then starts a clone whose context carries that notice. The clone declares the tools the session has
 * once the change goes out, so the session's cached prompt is unreadable to it: it sends the build that goes out with
 * the change from its first request, once, and holds nothing. Its notices must then agree with what it declares: the
 * request that first goes out without the session's hold tells its model the change is no longer held, and names a
 * tool the notice gave as available after the rebuild as available now.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, SETTINGS_NOTICE } from "../helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	withoutCacheControl,
} from "../helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, `/tan` on. */
const OVERLAY =
	"providers:\n  cacheRetention: long\nasync:\n  enabled: true\nmarketplace:\n  autoUpdate: off\ncompaction:\n  enabled: false\ntask:\n  enableLsp: false\n";

/** {@link OVERLAY} with `grep` gated off. */
const GREP_OFF = `${OVERLAY}grep:\n  enabled: false\n`;

/** What a settings notice says of a change that is no longer held. */
const RELEASED = "the change it described is no longer held";

const MINUTE_MS = 60_000;

/** The real clock, read before the test moves it. */
const realNow = Date.now.bind(Date);

function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/**
 * Rewrites the overlay with `content` and reloads it as the config watcher does, then waits for the prompt rebuild,
 * the tool reconcile and the hold the change starts.
 */
async function reloadOverlay(session: AgentSession, settings: Settings, overlay: string, content: string) {
	const calls = ["refreshBaseSystemPrompt", "reconcileBuiltinTools", "holdToolDeclarationChange"] as const;
	const spies = calls
		.filter(call => typeof (session as unknown as Record<string, unknown>)[call] === "function")
		.map(call => vi.spyOn(session as unknown as Record<string, () => Promise<void>>, call));
	await Bun.write(overlay, content);
	await settings.reloadFromDisk();
	await Promise.resolve();
	await Promise.all(spies.flatMap(spy => spy.mock.results.map(result => result.value)));
	for (const spy of spies) spy.mockRestore();
}

function declared(request: MessagesRequest): string[] {
	return (request.tools ?? []).map(tool => tool.name);
}

interface CloneRequests {
	/** The session's request that carries the held change's notice. */
	parentHeld: MessagesRequest;
	/** The clone's first request, before the deadline. */
	cloneFirst: MessagesRequest;
	/** The clone's request after the deadline. */
	cloneLate: MessagesRequest;
}

/**
 * A session with `read` and `grep` in its tool list, started under `initial`, whose sync to `synced` is held; `/tan`
 * at two minutes starts a clone whose first reply calls `read`, which runs past the deadline.
 */
async function cloneOfHeldSession(initial: string, synced: string): Promise<CloneRequests> {
	using dir = TempDir.createSync("@omp-tan-clone-other-tools-held-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, initial);
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
	const sessions: AgentSession[] = [];
	let cloneFirstTurn = -1;
	const gateway = mockGatewayFetch(turn =>
		turn === cloneFirstTurn
			? toolCallAnswer(turn, "read", { path: "overlay.yml" }, { cacheWriteTokens: 100 })
			: answer(turn, { cacheWriteTokens: 100 }),
	);
	const authStorage = createInMemoryAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session: parent } = await sdk.createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			authStorage,
			modelRegistry,
			model,
			settings,
			sessionManager: SessionManager.create(dir.path(), dir.join("parent")),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read", "grep"],
		});
		sessions.push(parent);
		setClock(0);
		await parent.prompt("first");
		await reloadOverlay(parent, settings, overlay, synced);
		setClock(MINUTE_MS);
		await parent.prompt("second");

		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			sessions.push(created.session);
			// The clone's call runs past the deadline the change's notice gave.
			created.session.subscribe(event => {
				if (event.type === "tool_execution_start") setClock(8 * MINUTE_MS);
			});
			return created;
		});
		const manager = parent.asyncJobManager;
		if (!manager) throw new Error("Missing async job manager");
		let runJob: (() => Promise<unknown>) | undefined;
		vi.spyOn(manager, "register").mockImplementation((_type, _label, run) => {
			runJob = () =>
				run({
					jobId: "tan-test",
					signal: new AbortController().signal,
					reportProgress: async () => {},
					markRunning: () => {},
				});
			return "tan-test";
		});
		const context = {
			session: parent,
			sessionManager: parent.sessionManager,
			showHookConfirm: async () => true,
			rebuildChatFromMessages: () => {},
			settings,
			showError: (message: string) => {
				throw new Error(message);
			},
			showWarning: () => {},
			showStatus: () => {},
		} as unknown as InteractiveModeContext;
		const parentRequests = gateway.requests.length;
		cloneFirstTurn = parentRequests + 1;
		setClock(2 * MINUTE_MS);
		await new TanCommandController(context).start("Check the deploy host");
		if (!runJob) throw new Error("Tan did not register its job");
		await runJob();

		const parentHeld = gateway.requests[parentRequests - 1];
		const [cloneFirst, cloneLate] = gateway.requests.slice(parentRequests);
		if (!parentHeld || !cloneFirst || !cloneLate) throw new Error("Expected the session's and the clone's requests");
		return { parentHeld, cloneFirst, cloneLate };
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		gateway.restore();
	}
}

describe("a /tan clone that declares other tools than its session while the session holds a change", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("tells its model a tool the change enables is available now, and sends one prompt", async () => {
		const { parentHeld, cloneFirst, cloneLate } = await cloneOfHeldSession(GREP_OFF, OVERLAY);
		const toldFirst = textOf(cloneFirst.messages);
		// Preconditions: the session's held request declares no `grep` and tells of the held change; the clone
		// declares `grep` from its first request, which comes before the deadline, and its late request after it.
		expect(declared(parentHeld)).not.toContain("grep");
		expect(textOf(parentHeld.messages)).toContain("available after the rebuild: `grep`");
		expect(declared(cloneFirst)).toContain("grep");
		expect(cloneLate.messages.length).toBeGreaterThan(cloneFirst.messages.length);

		expect(toldFirst.slice(toldFirst.lastIndexOf(SETTINGS_NOTICE))).toContain(RELEASED);
		expect(toldFirst.slice(toldFirst.lastIndexOf(SETTINGS_NOTICE))).toContain("available now: `grep`");
		expect(textOf(cloneLate.messages.slice(cloneFirst.messages.length))).not.toContain(SETTINGS_NOTICE);
		expect(withoutCacheControl(cloneLate.system)).toBe(withoutCacheControl(cloneFirst.system));
	}, 60_000);

	it("tells its model a tool the change disables is gone now, and sends one prompt", async () => {
		const { parentHeld, cloneFirst, cloneLate } = await cloneOfHeldSession(OVERLAY, GREP_OFF);
		const toldFirst = textOf(cloneFirst.messages);
		// Preconditions: the session's held request still declares `grep` and tells of the held change; the clone
		// declares no `grep`.
		expect(declared(parentHeld)).toContain("grep");
		expect(textOf(parentHeld.messages)).toContain("`grep.enabled`: `true` → `false`");
		expect(declared(cloneFirst)).not.toContain("grep");
		expect(cloneLate.messages.length).toBeGreaterThan(cloneFirst.messages.length);

		expect(toldFirst.slice(toldFirst.lastIndexOf(SETTINGS_NOTICE))).toContain(RELEASED);
		// The inherited notice said `grep` stays listed until the rebuild and its calls are refused: the clone's prompt
		// no longer lists it and its requests no longer declare it.
		expect(toldFirst.slice(toldFirst.lastIndexOf(SETTINGS_NOTICE))).toContain(
			"Disabled by that change; gone now, no longer listed or declared: `grep`",
		);
		expect(textOf(cloneLate.messages.slice(cloneFirst.messages.length))).not.toContain(SETTINGS_NOTICE);
		expect(withoutCacheControl(cloneLate.system)).toBe(withoutCacheControl(cloneFirst.system));
	}, 60_000);
});
