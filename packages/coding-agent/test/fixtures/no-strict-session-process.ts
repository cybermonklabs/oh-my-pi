/**
 * One omp process of `agent-session-no-strict-tool-digest.test.ts`, run as `bun <this file> <input JSON>`: the
 * providers read `PI_NO_STRICT` once, when they load, so each process the test runs with or without it is its own.
 * On the gateway's claude-opus-5-5 with `read` and `edit` (a tool the Anthropic provider declares as strict unless
 * `PI_NO_STRICT` is set; an OpenAI one asks strict decoding for every tool not marked `strict: false` unless it is),
 * on Anthropic's messages API or the input's OpenAI API, on the input's session file or a new session, it reads the
 * prompt cache status, sends each prompt at its minute, and writes what it saw to the input's `out` file.
 */
import { vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { answer, gatewaySessionOptions, mockGatewayFetch } from "../helpers/anthropic-gateway";
import {
	type GatewayRequest,
	gatewayModel,
	mockOpenAIGatewayFetch,
	type OpenAIGatewayApi,
} from "../helpers/openai-gateway";

/** What the test gives the process. */
export interface ProcessInput {
	/** The test's directory: the working and agent directory, with the gateway's `models.yml` and the sessions. */
	dir: string;
	/** The session file to resume; a new session without one. */
	sessionFile?: string;
	/** The context file's content. */
	agentsMd: string;
	/** Each prompt, with the minute after the process started that it is sent at. */
	prompts: { text: string; minute: number }[];
	/** The file the process writes its {@link ProcessRun} to. */
	out: string;
	/** The OpenAI API the gateway serves the model on; Anthropic's messages API without one. */
	api?: OpenAIGatewayApi;
}

/** What the process saw. */
export interface ProcessRun {
	/** Each request the gateway received, oldest first. */
	requests: GatewayRequest[];
	/** The session file the process wrote. */
	sessionFile: string;
	/** The prompt cache status before the first prompt. */
	status: PromptCacheStatus | undefined;
}

const MINUTE_MS = 60_000;

const input = JSON.parse(Bun.argv[2] ?? "{}") as ProcessInput;
const realNow = Date.now.bind(Date);
const { requests, restore } = input.api
	? mockOpenAIGatewayFetch(input.api)
	: mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
const authStorage = createInMemoryAuthStorage();
let run: ProcessRun;
try {
	const modelRegistry = new ModelRegistry(authStorage, path.join(input.dir, "models.yml"));
	const model = gatewayModel(modelRegistry, input.api);
	const sessionManager = input.sessionFile
		? await SessionManager.open(input.sessionFile)
		: SessionManager.create(input.dir, path.join(input.dir, "sessions"));
	const { session } = await createAgentSession({
		...gatewaySessionOptions({ path: () => input.dir }),
		sessionManager,
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "providers.cacheRetention": "long" }),
		model,
		toolNames: ["read", "edit"],
		contextFiles: [{ path: path.join(input.dir, "AGENTS.md"), content: input.agentsMd }],
		skills: [],
	});
	try {
		const status = session.getPromptCacheStatus();
		for (const { text, minute } of input.prompts) {
			vi.spyOn(Date, "now").mockImplementation(() => realNow() + minute * MINUTE_MS);
			await session.prompt(text);
		}
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		run = { requests, sessionFile, status };
	} finally {
		await session.dispose();
	}
} finally {
	authStorage.close();
	restore();
	vi.restoreAllMocks();
}
await Bun.write(input.out, JSON.stringify(run));
process.exit(0);
