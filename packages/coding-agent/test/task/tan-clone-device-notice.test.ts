/**
 * `/tan` starts its clone on the parent's system prompt as sent, a fixed prompt that lists the parent's `xd://`
 * devices in its catalog. The clone's first request sends that prompt byte for byte; it must not also carry a hidden
 * notice that the device inventory changed: no device was mounted or unmounted since that prompt was built, and the
 * release sent no such notice.
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
import { answer, gatewayModelsYml, mockGatewayFetch, textOf, withoutCacheControl } from "../helpers/anthropic-gateway";

const MOUNT_NOTICE = "xd:// device inventory changed";

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

it("sends no device inventory notice from a /tan clone of a prompt that lists the devices", async () => {
	using dir = TempDir.createSync("@omp-tan-clone-device-notice-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	const authStorage = createInMemoryAuthStorage();
	const sessions: AgentSession[] = [];
	const settings = Settings.isolated({
		"providers.cacheRetention": "long",
		"async.enabled": true,
		"marketplace.autoUpdate": "off",
		"compaction.enabled": false,
		"task.enableLsp": false,
	});
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
		});
		sessions.push(parent);
		await parent.prompt("first");

		const realCreate = sdk.createAgentSession;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async options => {
			const created = await realCreate(options);
			sessions.push(created.session);
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
		await new TanCommandController(context).start("Check the deploy host");
		if (!runJob) throw new Error("Tan did not register its job");
		await runJob();

		const parentRequest = gateway.requests[parentRequests - 1];
		const cloneRequest = gateway.requests[parentRequests];
		if (!parentRequest || !cloneRequest) throw new Error("Expected the parent's and the clone's requests");
		// Preconditions: the clone sends the parent's prompt as sent, which lists the devices, and the parent's request
		// carried no notice.
		expect(withoutCacheControl(cloneRequest.system)).toBe(withoutCacheControl(parentRequest.system));
		expect(textOf(cloneRequest.system)).toContain("xd://ast_edit");
		expect(textOf(parentRequest.messages)).not.toContain(MOUNT_NOTICE);

		// Nothing was mounted after that prompt was built: no message tells the clone the inventory changed.
		expect(textOf(cloneRequest.messages)).not.toContain(MOUNT_NOTICE);
	} finally {
		await Promise.all(sessions.map(session => session.dispose()));
		authStorage.close();
		gateway.restore();
	}
}, 60_000);
