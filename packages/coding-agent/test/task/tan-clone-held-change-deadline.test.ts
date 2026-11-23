/**
 * A configuration sync changes `personality`, a setting the system prompt renders, under a session whose prompt is
 * bound, so the session holds the change for at most five minutes and its hidden notice says when it goes out. `/tan`
 * then starts its clone on the parent's system prompt as sent, which is the held one. The clone runs under the new
 * settings and its context carries the notice promising the rebuild. A request the clone makes once the change is
 * five minutes old must carry the changed prompt, as the parent's next request does and as the release's clone does
 * from its first request: the clone must not keep a held prompt past the deadline its notice gives.
 */
import { afterEach, expect, it, vi } from "bun:test";
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
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	withoutCacheControl,
} from "../helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, `/tan` on. */
const OVERLAY =
	"providers:\n  cacheRetention: long\nasync:\n  enabled: true\nmarketplace:\n  autoUpdate: off\ncompaction:\n  enabled: false\ntask:\n  enableLsp: false\n";

/** {@link OVERLAY} with another `personality`, a change the system prompt renders. */
const PRAGMATIC = `${OVERLAY}personality: pragmatic\n`;

/** The first line the `pragmatic` personality renders into the system prompt. */
const PRAGMATIC_TEXT = "Pragmatic, effective senior engineer.";

const MINUTE_MS = 60_000;

/** The real clock, read before the test moves it. */
const realNow = Date.now.bind(Date);

/** Moves the clock `offsetMs` ahead of real time from now on. */
function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/**
 * Rewrites the overlay with `content` and reloads it as the config watcher does, then waits for the prompt rebuild,
 * the tool reconcile and the hold the change starts, each where the session has it.
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

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("sends the changed prompt from a /tan clone once the parent's held change is five minutes old", async () => {
	using dir = TempDir.createSync("@omp-tan-clone-held-change-deadline-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, OVERLAY);
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
	// The clone's first request is answered with a call, and the clock passes the deadline while the clone runs that
	// call, before its next request. No request is in flight when the clock moves: a stream's deadlines run on
	// `Date.now`, so a jump inside a response would time that response out and retry it.
	let cloneFirstTurn = -1;
	const gateway = mockGatewayFetch(turn => {
		if (turn !== cloneFirstTurn) return answer(turn, { cacheWriteTokens: 100 });
		return toolCallAnswer(turn, "read", { path: "overlay.yml" }, { cacheWriteTokens: 100 });
	});
	const authStorage = createInMemoryAuthStorage();
	const sessions: AgentSession[] = [];
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
			toolNames: ["read"],
		});
		sessions.push(parent);
		setClock(0);
		await parent.prompt("first");
		await reloadOverlay(parent, settings, overlay, PRAGMATIC);
		setClock(MINUTE_MS);
		await parent.prompt("second");

		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			sessions.push(created.session);
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

		const parentRequest = gateway.requests[parentRequests - 1];
		const cloneFirst = gateway.requests[parentRequests];
		const cloneLate = gateway.requests[parentRequests + 1];
		if (!parentRequest || !cloneFirst || !cloneLate)
			throw new Error("Expected the parent's and the clone's requests");
		// Preconditions: the clone starts on the parent's prompt as sent, and makes a request after the deadline.
		expect(withoutCacheControl(cloneFirst.system)).toBe(withoutCacheControl(parentRequest.system));
		expect(textOf(cloneLate.messages)).toContain("personality: pragmatic");

		// The change is eight minutes old: the clone's request carries the prompt the settings give.
		expect(textOf(cloneLate.system)).toContain(PRAGMATIC_TEXT);
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		gateway.restore();
	}
}, 60_000);
