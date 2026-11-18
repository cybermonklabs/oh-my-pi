/**
 * RPC runtime for the stdin-EOF test of subagent commands: `runRpcMode` over a
 * real SDK session, with one subagent (`Worker`) in the roster that is idle
 * between its turns. Its session double queues next-run steers and never runs
 * a turn; it appends `queued <text>`, `taken back <text>` and `prompt` lines to
 * `<cwd>/subagent-queue.log`. An extension holds `new_session` (a serial
 * command) on a confirm dialog only the client's disconnect ends, cancelling
 * the switch when the dialog fails.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { QueuedMessageTarget, SteerOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const cwd = process.cwd();
const queueLog = path.join(cwd, "subagent-queue.log");
const note = (line: string) => fs.appendFileSync(queueLog, `${line}\n`);

const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	sessionManager: SessionManager.inMemory(cwd),
	authStorage,
	modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
	settings: await Settings.init({ inMemory: true, cwd }),
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
	extensions: [
		pi => {
			pi.on("session_before_switch", async (_event, ctx) => {
				const confirmed = await ctx.ui.confirm("Switch?", "Held until the client goes away").catch(() => false);
				return confirmed ? undefined : { cancel: true };
			});
		},
	],
});

const id = "Worker";
const sessionFile = path.join(cwd, `${id}.jsonl`);
/** Queued next-run steers: each one's text and the name its sender gave it. */
const queued: Array<{ text: string; queueId?: string }> = [];
AgentRegistry.global().register({
	id,
	displayName: id,
	kind: "sub",
	sessionFile,
	status: "idle",
	session: {
		subscribe: () => () => {},
		steer: async (text: string, _images: unknown, options?: SteerOptions) => {
			queued.push({ text, queueId: options?.queueId });
			note(`queued ${text}`);
		},
		removeQueuedMessage: (target: QueuedMessageTarget) => {
			const index = queued.findIndex(steer =>
				typeof target === "string" ? steer.text === target : steer.queueId === target.queueId,
			);
			if (index < 0) return false;
			const [steer] = queued.splice(index, 1);
			note(`taken back ${steer.text}`);
			return true;
		},
		prompt: async () => {
			note("prompt");
			return true;
		},
		abort: async () => {},
		dispose: async () => {},
	} as never,
});

const subagentEventBus = new EventBus();
// runRpcMode builds its roster before its first await, so the started frame below reaches it.
const running = runRpcMode(session, { subagentEventBus });
subagentEventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
	id,
	index: 0,
	agent: "task",
	agentSource: "bundled",
	status: "started",
	sessionFile,
} satisfies SubagentLifecyclePayload);
await running;
