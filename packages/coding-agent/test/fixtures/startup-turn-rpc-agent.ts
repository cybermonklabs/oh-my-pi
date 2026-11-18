import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC dispatch and extension startup; only the model response is scripted.
// A `session_start` handler starts a turn whose model call stays open until the
// client aborts it, so the startup turn outlasts every command the client sends
// after `ready`, however slowly this process runs: no timer decides when it ends.
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const sessionManager = SessionManager.inMemory(process.cwd());
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("session_start", () => {
			pi.sendMessage(
				{ customType: "startup-announce", content: "extension started", display: true },
				{ triggerTurn: true },
			);
		});
	},
	process.cwd(),
	new EventBus(),
	runtime,
	"startup-turn",
);
const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
const mock = createMockModel({
	responses: [
		(_context, options) => {
			const { promise, resolve } = Promise.withResolvers<MockResponse>();
			const aborted = () => resolve({ stopReason: "aborted", errorMessage: "Mock aborted before responding." });
			if (options?.signal?.aborted) aborted();
			else options?.signal?.addEventListener("abort", aborted, { once: true });
			return promise;
		},
	],
	handler: { content: ["ok"] },
});
const agent = new Agent({
	getApiKey: () => "test-key",
	initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry,
	extensionRunner,
});
await runRpcMode(session);
