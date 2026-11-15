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

// Real RPC dispatch, session and prompt wait for idle; only model replies are scripted.
// A prompt holding "two-runs-first" finds the agent held by other runs for longer than its
// 30 s wait for idle: its before_agent_start handler starts run A on the agent (answered after
// 35 s) and, the moment A ends, run B (streams until aborted). Both claim the agent directly,
// as a run the prompt does not own would, and B's start is registered on A's end before the
// prompt's own wait, so B holds the agent when that wait resumes.
// The root arrives as argv so storage can never land in an inherited cwd such as the repo checkout.
const root = process.argv[2];
if (!root || root.startsWith("-"))
	throw new Error("idle-retry-rpc-agent: expected the temp root as the first argument");
process.chdir(root);
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const sessionManager = SessionManager.inMemory(cwd);
const runtime = new ExtensionRuntime();
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("before_agent_start", async event => {
			if (!event.prompt.includes("two-runs-first")) return undefined;
			void session.agent.prompt("run-a");
			void session.agent.waitForIdle().then(() => session.agent.prompt("run-b"));
			return undefined;
		});
	},
	cwd,
	new EventBus(),
	runtime,
	"idle-retry",
);
const extensionRunner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry);
const mock = createMockModel({
	// The delays are real: run A outlasts the prompt's 30 s wait; run B only bounds a leaked process.
	handler: context => {
		const last = JSON.stringify(context.messages.at(-1)?.content);
		if (last.includes("run-a")) return { content: ["Done"], delayMs: 35_000 };
		if (last.includes("run-b")) return { content: ["Done"], delayMs: 600_000 };
		return { content: ["Done"] };
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
