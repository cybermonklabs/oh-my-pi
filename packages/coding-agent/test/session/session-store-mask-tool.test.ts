/**
 * Contract: with session store masking on, a secret a tool reads stays whole in
 * the live session — the tool runs with it, the model sees it and can pass it to
 * the next tool call — while the session store, and a session resumed from it,
 * hold the marker naming its source. Drives a real `AgentSession` with the real
 * bash tool and pi-ai's mock model.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { cfgSecretsMaskSessionStore } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { BashTool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const FILE_MARKER = "[REDACTED:file:EXAMPLE_TOKEN_FILE]";
const READ_CALL = "call-read-token";
const USE_CALL = "call-use-token";

let tmp: TempDir;
let cwd: string;
let tokenFile: string;
/** Made per test. A failing check shows only hashes, booleans, or text a boolean check already proved free of it. */
let secret: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tmp = TempDir.createSync("@omp-session-store-masking-tool-");
	cwd = tmp.join("project");
	tokenFile = tmp.join("token.txt");
	secret = Buffer.from(crypto.getRandomValues(new Uint8Array(20))).toString("hex");
	await Bun.write(tokenFile, secret);
	await fs.mkdir(cwd, { recursive: true });
	resetSettingsForTest();
	// The bash executor reads the global settings; keep them off the developer's config.
	await Settings.init({ inMemory: true, cwd });
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	// The tool's shell gets EXAMPLE_TOKEN_FILE through the session env every bash command starts from.
	const shellConfig = Settings.prototype.getShellConfig;
	spyOn(Settings.prototype, "getShellConfig").mockImplementation(function (this: Settings) {
		const config = shellConfig.call(this);
		return { ...config, env: { ...config.env, EXAMPLE_TOKEN_FILE: tokenFile } };
	});
	// The process masker holds the test's file, never this machine's environment.
	spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
		new storeMask.SessionStoreMasker({ env: () => ({ EXAMPLE_TOKEN_FILE: tokenFile }), agentDir: tmp.join("agent") }),
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	authStorage.close();
	resetSettingsForTest();
	await tmp.remove();
});

/** The text of the tool result answering `callId`. */
function toolResultText(messages: readonly (AgentMessage | Message)[], callId: string): string {
	const result = messages.find(message => message.role === "toolResult" && message.toolCallId === callId);
	if (result?.role !== "toolResult") throw new Error(`No tool result for ${callId}`);
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

interface Run {
	/** The live agent's messages. */
	live: AgentMessage[];
	sessionFile: string;
	sessionDir: string;
	/** The session body as the store holds it. */
	stored: string;
}

/**
 * One prompt: the model reads the secret with `cat "$EXAMPLE_TOKEN_FILE"`, then
 * passes the value it read to a second bash call that checks it against the file.
 * The session's manager is bound to the session's `secrets.maskSessionStore`, as
 * `createAgentSession` binds it.
 */
async function runSession(maskSessionStore: boolean): Promise<Run> {
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
		"secrets.maskSessionStore": maskSessionStore,
	});
	const storage = new FileSessionStorage();
	const sessionDir = tmp.join("sessions");
	const sessionManager = SessionManager.create(cwd, sessionDir, storage);
	sessionManager.setStoreMasking(() => cfgSecretsMaskSessionStore.get(settings), tmp.join("agent"));
	await sessionManager.ensureOnDisk();
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
		getSessionSpawns: () => "*",
	};
	const bashTool = new BashTool(toolSession) as unknown as AgentTool;
	const mock = createMockModel({
		responses: [
			{
				content: [
					{ type: "toolCall", id: READ_CALL, name: "bash", arguments: { command: 'cat "$EXAMPLE_TOKEN_FILE"' } },
				],
			},
			context => {
				const read = toolResultText(context.messages, READ_CALL).trim();
				const command = `test "$(cat "$EXAMPLE_TOKEN_FILE")" = '${read}' && echo match`;
				return { content: [{ type: "toolCall", id: USE_CALL, name: "bash", arguments: { command } }] };
			},
			{ content: ["done"] },
		],
	});
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 to be bundled");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage, tmp.join("models.yml")),
		toolRegistry: new Map([[bashTool.name, bashTool]]),
	});
	try {
		await session.prompt("read the token and check it");
		await sessionManager.flush();
		await storage.drain();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		return {
			// A copy: dispose empties the agent's message list.
			live: [...session.agent.state.messages],
			sessionFile,
			sessionDir,
			stored: await storage.readText(sessionFile),
		};
	} finally {
		await session.dispose();
	}
}

/** The stored messages of a session body, in file order. */
function storedMessages(text: string): Record<string, unknown>[] {
	return Bun.JSONL.parse(text)
		.filter(isRecord)
		.flatMap(record => (record.type === "message" && isRecord(record.message) ? [record.message] : []));
}

describe("session store masking of a tool-read secret", () => {
	it("runs the tools with the real value and stores, and resumes, its marker", async () => {
		const run = await runSession(true);

		// Live: the tool read the real value, and the call that received it from the model ran with it.
		const liveRead = toolResultText(run.live, READ_CALL).trim();
		expect(Bun.SHA256.hash(liveRead, "hex")).toBe(Bun.SHA256.hash(secret, "hex"));
		expect(toolResultText(run.live, USE_CALL).trim()).toBe("match");

		// Stored: the marker in the tool result and in the tool call that carried the value.
		expect(run.stored.includes(secret)).toBe(false);
		const stored = storedMessages(run.stored);
		const storedRead = stored.find(message => message.role === "toolResult" && message.toolCallId === READ_CALL);
		expect(storedRead?.content).toEqual([{ type: "text", text: FILE_MARKER }]);
		const storedCalls = stored
			.filter(message => message.role === "assistant")
			.flatMap(message => message.content as AssistantMessage["content"])
			.filter(block => block.type === "toolCall");
		expect(storedCalls.find(call => call.id === USE_CALL)?.arguments).toEqual({
			command: `test "$(cat "$EXAMPLE_TOKEN_FILE")" = '${FILE_MARKER}' && echo match`,
		});

		// Resumed: the history a reopened session hands the model holds the marker.
		const resumed = await SessionManager.open(run.sessionFile, run.sessionDir, new FileSessionStorage());
		const history = resumed.buildSessionContext().messages;
		await resumed.close();
		expect(JSON.stringify(history).includes(secret)).toBe(false);
		expect(toolResultText(history, READ_CALL)).toBe(FILE_MARKER);
	});

	it("stores the real value while the session's setting is off", async () => {
		const run = await runSession(false);

		const storedRead = storedMessages(run.stored).find(
			message => message.role === "toolResult" && message.toolCallId === READ_CALL,
		);
		expect(JSON.stringify(storedRead?.content).includes(secret)).toBe(true);
	});
});
