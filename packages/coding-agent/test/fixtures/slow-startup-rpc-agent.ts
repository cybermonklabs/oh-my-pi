import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { RpcLiveSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Real RPC startup with one slow `session_start` handler that starts no turn: the case where an
// extension makes startup long without making a turn out of it. The handler blocks for
// OMP_STARTUP_HANDLER_MS, which is the delay under test rather than a wait for a condition, and
// reports the time it returned on stderr, so a test can tell a command answered while startup ran
// from one that waited startup out. The `input` handler reports whether it saw that return, so a
// test can tell a turn that started after the `session_start` broadcast from one that overtook it.
const handlerMs = Number(process.env.OMP_STARTUP_HANDLER_MS ?? "8000");
const authStorage = await AuthStorage.create(path.join(process.cwd(), "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(process.cwd(), "models.yml"));
const sessionManager = SessionManager.inMemory(process.cwd());
const runtime = new ExtensionRuntime();
let sessionStartReturned = false;
const extension = await loadExtensionFromFactory(
	pi => {
		pi.on("session_start", async () => {
			await Bun.sleep(handlerMs);
			process.stderr.write(`startup-handler-returned ${Date.now()}\n`);
			sessionStartReturned = true;
			return undefined;
		});
		pi.on("input", () => {
			const order = sessionStartReturned ? "after" : "before";
			process.stderr.write(`input-handler-ran ${order}-session-start ${Date.now()}\n`);
			return undefined;
		});
	},
	process.cwd(),
	new EventBus(),
	runtime,
	"slow-startup",
);
const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
const mock = createMockModel({ handler: { content: ["ok"] } });
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

/**
 * The live controller the `live_*` rows drive, as in `live-rpc-agent.ts`: a live row must depend on
 * neither the machine's audio device nor its realtime credentials.
 */
class FakeLiveSession implements RpcLiveSession {
	muted = false;
	#stopped: Promise<void> | undefined;
	constructor(readonly options: LiveSessionControllerOptions) {}

	get sdpAnswer(): string | undefined {
		return this.options.sdpOffer === undefined ? undefined : `answer to ${this.options.sdpOffer}`;
	}

	async start(): Promise<void> {
		this.options.callbacks.onPhase("listening");
	}

	toggleMute(): void {
		this.muted = !this.muted;
	}

	stop(): Promise<void> {
		// `onTerminal` retires the bridge, which stops the controller again: stop once, as the sibling
		// fixture does.
		this.#stopped ??= (async () => {
			this.options.callbacks.onTerminal();
		})();
		return this.#stopped;
	}
}

await runRpcMode(session, { createLiveSession: options => new FakeLiveSession(options) });
