/**
 * A configuration sync turns `grep.enabled` on under a session whose prompt is bound and whose explicit tool list
 * names `grep`: the session holds the change, so `grep` waits for the rebuild, and its hidden notice says the tool is
 * available after the rebuild at a deadline. `/tan` then starts a clone of the session, whose context carries that
 * notice. Once the deadline has passed the session declares `grep`, and so must the clone's request: the settings
 * enable it, the notice the clone carries promised it, and a clone of the release declares it from its first request.
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
import { answer, gatewayModelsYml, mockGatewayFetch, toolCallAnswer } from "../helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, `/tan` on. */
const OVERLAY =
	"providers:\n  cacheRetention: long\nasync:\n  enabled: true\nmarketplace:\n  autoUpdate: off\ncompaction:\n  enabled: false\ntask:\n  enableLsp: false\n";

/** {@link OVERLAY} with `grep` gated off. */
const GREP_OFF = `${OVERLAY}grep:\n  enabled: false\n`;

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

it("declares a tool the held change enables from a /tan clone once the change is past its deadline", async () => {
	using dir = TempDir.createSync("@omp-tan-clone-held-tool-enable-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, GREP_OFF);
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
	const sessions: AgentSession[] = [];
	// The clone's first reply calls a tool, which runs past the deadline.
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
		await reloadOverlay([parent], settings, overlay, OVERLAY);
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
		await parent.prompt("after the deadline");

		const [first] = gateway.requests;
		const [cloneFirst, cloneLate, parentLate] = gateway.requests.slice(parentRequests);
		if (!first || !cloneFirst || !cloneLate || !parentLate) {
			throw new Error("Expected the session's and the clone's requests");
		}
		const declared = (request: { tools?: { name: string }[] }) => (request.tools ?? []).map(tool => tool.name);
		// Preconditions: the session declares no `grep` before the change and declares it after the deadline; the
		// clone's second request answers its call, made after the deadline.
		expect(declared(first)).not.toContain("grep");
		expect(declared(parentLate)).toContain("grep");
		expect(cloneLate.messages.length).toBeGreaterThan(cloneFirst.messages.length);

		// The clone's request after the deadline declares the tool the settings enable.
		expect(declared(cloneLate)).toContain("grep");
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		gateway.restore();
	}
}, 60_000);
