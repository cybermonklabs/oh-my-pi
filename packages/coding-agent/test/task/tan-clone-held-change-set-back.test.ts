/**
 * A configuration sync changes `personality` under a session whose prompt is bound, so the session holds the change
 * and its hidden notice says the prompt is rebuilt with it by a deadline. `/tan` starts a clone on the held prompt,
 * with the session's build as the prompt it sends once the change goes out. A second sync sets `personality` back
 * before the deadline: the session's change is then no longer held and its prompt stays as it was, and the clone's
 * next notice tells its model that the prompt follows the current settings. A request the clone makes after the
 * deadline must then carry the prompt the settings give, as the session's does, and not the build of a value the
 * settings no longer have.
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
	heldOpen,
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

/** The opening of the hidden settings notice. */
const SETTINGS_NOTICE = '<system-notice id="settings">';

const MINUTE_MS = 60_000;

/** The real clock, read before the test moves it. */
const realNow = Date.now.bind(Date);

function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/**
 * Rewrites the overlay with `content` and reloads it as the config watcher does, then waits for the prompt rebuild,
 * the tool reconcile and the hold the change starts, in each of `sessions` that has them.
 */
async function reloadOverlay(sessions: AgentSession[], settings: Settings, overlay: string, content: string) {
	const calls = ["refreshBaseSystemPrompt", "reconcileBuiltinTools", "holdToolDeclarationChange"] as const;
	const spies = sessions.flatMap(session =>
		calls
			.filter(call => typeof (session as unknown as Record<string, unknown>)[call] === "function")
			.map(call => vi.spyOn(session as unknown as Record<string, () => Promise<void>>, call)),
	);
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

it("sends the prompt the settings give from a /tan clone after the deadline once the held change is set back", async () => {
	using dir = TempDir.createSync("@omp-tan-clone-held-change-set-back-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, OVERLAY);
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
	const sessions: AgentSession[] = [];
	// The clone's first reply waits for the sync that sets `personality` back; its second reply's call runs past the
	// deadline.
	let cloneFirstTurn = -1;
	let setBack: Promise<void> = Promise.resolve();
	const gateway = mockGatewayFetch(turn => {
		if (turn === cloneFirstTurn) {
			setBack = reloadOverlay(sessions, settings, overlay, OVERLAY);
			return heldOpen(toolCallAnswer(turn, "read", { path: "overlay.yml" }, { cacheWriteTokens: 100 }), setBack);
		}
		if (turn === cloneFirstTurn + 1) {
			return toolCallAnswer(turn, "read", { path: "overlay.yml" }, { cacheWriteTokens: 100 });
		}
		return answer(turn, { cacheWriteTokens: 100 });
	});
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
			toolNames: ["read"],
		});
		sessions.push(parent);
		setClock(0);
		await parent.prompt("first");
		await reloadOverlay([parent], settings, overlay, PRAGMATIC);
		setClock(MINUTE_MS);
		await parent.prompt("second");

		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			sessions.push(created.session);
			// The clone's second call runs after the deadline the change's notice gave.
			let calls = 0;
			created.session.subscribe(event => {
				if (event.type === "tool_execution_start" && ++calls === 2) setClock(8 * MINUTE_MS);
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
		await setBack;
		await parent.prompt("after the deadline");

		const parentHeld = gateway.requests[parentRequests - 1];
		const [cloneFirst, cloneSetBack, cloneLate, parentLate] = gateway.requests.slice(parentRequests);
		if (!parentHeld || !cloneFirst || !cloneSetBack || !cloneLate || !parentLate) {
			throw new Error("Expected the session's and the clone's requests");
		}
		const setBackNotice = textOf(cloneSetBack.messages.slice(cloneFirst.messages.length));
		// Preconditions: the clone starts on the held prompt; after the set-back its notice tells the model the prompt
		// follows the current settings; its last request comes after the deadline the session's notice gave; the
		// session's request then carries no `pragmatic` prompt.
		expect(withoutCacheControl(cloneFirst.system)).toBe(withoutCacheControl(parentHeld.system));
		expect(setBackNotice).toContain(SETTINGS_NOTICE);
		expect(setBackNotice).toContain('`personality`: `"pragmatic"` → `"default"`');
		expect(setBackNotice).toContain("follow their current values");
		const deadline = textOf(parentHeld.messages).match(/at the first request made at (\S+) or later/)?.[1];
		expect(Date.parse(deadline ?? "")).toBeLessThanOrEqual(Date.now());
		expect(textOf(parentLate.system)).not.toContain(PRAGMATIC_TEXT);

		// The clone's request after the deadline follows the settings, as its notice said.
		expect(textOf(cloneLate.system)).not.toContain(PRAGMATIC_TEXT);
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		gateway.restore();
	}
}, 60_000);
