import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
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

// Real RPC dispatch, session and extension input handler; only model replies are scripted.
// Prompt contract, keyed by words in the text:
//   "slow"       -> the model call announces itself with a notice, then streams until aborted
//   "turn-first" -> RPC input only: the input handler starts a "slow" turn, waits until the
//                   session is busy, and leaves the input unhandled, so the prompt meets a busy agent
//   "no-key"     -> RPC input only: the input handler removes the provider's key, so the prompt
//                   fails after admission because no API key is found
// The root arrives as argv so storage can never land in an inherited cwd such as the repo checkout.
const root = process.argv[2];
if (!root || root.startsWith("-")) throw new Error("busy-rpc-agent: expected the temp root as the first argument");
process.chdir(root);
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const sessionManager = SessionManager.inMemory(cwd);
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("input", async (event, ctx) => {
			if (event.source !== "rpc") return undefined;
			if (event.text.includes("no-key")) authStorage.keys.removeRuntime("anthropic");
			if (!event.text.includes("turn-first")) return undefined;
			pi.sendUserMessage("slow");
			const deadline = Date.now() + 10_000;
			while (ctx.isIdle()) {
				if (Date.now() > deadline) throw new Error("busy-rpc-agent: the slow turn never started");
				await Bun.sleep(5);
			}
			return undefined;
		});
	},
	cwd,
	new EventBus(),
	runtime,
	"busy-input",
);
const extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
const mock = createMockModel({
	handler: context => {
		if (!JSON.stringify(context.messages.at(-1)?.content).includes("slow")) return { content: ["Done"] };
		session.emitNotice("info", "slow turn streaming", "busy-rpc-agent");
		// The delay only bounds a leaked process; the test aborts the turn or stops the agent.
		return { content: ["Done"], delayMs: 600_000 };
	},
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
