/**
 * An endpoint that rejects strict tools with a 400 makes the provider retry the request without them, and the
 * session counts the tool definitions the retry sends for the reply's record. A model switch that lands while that
 * request is in flight does not change what the request sent: the record names the retry's definitions on the model
 * the request went to, so a process that resumes the session reads the cache entry the retry wrote.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	heldOpen,
	type MessagesRequest,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";

/** The 400 an endpoint answers a strict request with when it cannot compile the tools' grammar. */
const GRAMMAR_REJECTION = JSON.stringify({
	type: "error",
	error: {
		type: "invalid_request_error",
		message:
			"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.",
	},
	request_id: "req_400",
});

/** The gateway's models: claude-opus-5-5, and claude-sonnet-4-6 beside it. */
const MODELS_YML = `${gatewayModelsYml()}      - {id: claude-sonnet-4-6, name: Claude Sonnet 4.6, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}}\n`;

function sendsStrictTool(request: MessagesRequest): boolean {
	return (request.tools ?? []).some(tool => isRecord(tool) && tool.strict === true);
}

function gatewayModel(registry: ModelRegistry, id: string): Model {
	const model = registry.find("anthropic", id);
	if (!model) throw new Error(`Expected the gateway's ${id}`);
	return model;
}

/**
 * One process on `sessionFile` (a new session without one) on claude-opus-5-5 with `read` and `edit` (`edit` goes out
 * strict by default): runs `steps`, then exits. The gateway rejects every request that sends a strict tool; it answers
 * the first one once `rejectStrict` lets it. Returns the session file.
 */
async function runProcess(
	dir: string,
	sessionFile: string | undefined,
	steps: (session: AgentSession, models: { opus: Model; sonnet: Model }) => Promise<void>,
	rejectStrict: (session: AgentSession, models: { opus: Model; sonnet: Model }) => Promise<void> = async () => {},
): Promise<string> {
	let session: AgentSession | undefined;
	let models: { opus: Model; sonnet: Model } | undefined;
	const gateway = mockGatewayFetch(turn => {
		const request = gateway.requests[turn - 1];
		if (!request || !sendsStrictTool(request) || !session || !models) return answer(turn, { cacheWriteTokens: 100 });
		const rejected = new Response(GRAMMAR_REJECTION, {
			status: 400,
			headers: { "content-type": "application/json" },
		});
		return heldOpen(rejected, rejectStrict(session, models));
	});
	const authStorage = createInMemoryAuthStorage();
	try {
		await Bun.write(path.join(dir, "models.yml"), MODELS_YML);
		const modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"));
		models = {
			opus: gatewayModel(modelRegistry, "claude-opus-5-5"),
			sonnet: gatewayModel(modelRegistry, "claude-sonnet-4-6"),
		};
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir, path.join(dir, "sessions"));
		({ session } = await createAgentSession({
			...gatewaySessionOptions({ path: () => dir }),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model: models.opus,
			toolNames: ["read", "edit"],
			contextFiles: [],
			skills: [],
		}));
		try {
			await steps(session, models);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return file;
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		gateway.restore();
	}
}

describe("a strict-tools retry under a model switch that lands while the request is in flight", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("records the tools the retry sent on the request's model, so a resumed process reads the cache it wrote", async () => {
		using tempDir = TempDir.createSync("@pi-fallback-recount-model-switch-");
		let switched: Promise<unknown> | undefined;
		const sessionFile = await runProcess(
			tempDir.path(),
			undefined,
			async (session, { opus }) => {
				await session.prompt("first");
				await switched;
				// Back on the model the reply came from.
				await session.setModel(opus);
			},
			// The switch to claude-sonnet-4-6 lands before the provider reads the 400 and retries without strict tools.
			async (session, { sonnet }) => {
				switched ??= session.setModel(sonnet);
				await switched;
			},
		);

		let status: PromptCacheStatus | undefined;
		await runProcess(tempDir.path(), sessionFile, async session => {
			status = session.getPromptCacheStatus();
		});
		// Precondition: the switch did land, and the session is back on claude-opus-5-5.
		expect(switched).toBeDefined();
		// The resumed process sends the tools without strict, as the retry did: it reads the entry the retry wrote.
		expect(status).toMatchObject({ state: "warm" });
	}, 60_000);
});
