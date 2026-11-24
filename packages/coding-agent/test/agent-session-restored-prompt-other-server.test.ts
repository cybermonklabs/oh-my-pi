/**
 * A resumed process keeps the prompt the transcript stores, in place of its own build, only while the next request
 * reads the cache entry the transcript's requests wrote. Each server keeps a prompt cache of its own: once `models.yml`
 * points the model at another server, the next request reads none of that entry and writes the whole prompt either
 * way, so a context file edited since must reach the model, as it does at the release and after a restart onto another
 * model. The prompt cache keys the model with the endpoint its requests go to; the entry a resumed process reads off
 * the transcript must too.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { TempDir } from "@oh-my-pi/pi-utils";
import { answer, gatewaySessionOptions, type MessagesRequest, withoutCacheControl } from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

const ROLE = "You review the parser changes of this repository.";
/** The server the transcript's requests went to. */
const FIRST_SERVER = "http://gateway.test.local:4000";
/** Another server, which keeps a prompt cache of its own. */
const OTHER_SERVER = "http://other-gateway.test.local:4000";

/** A `models.yml` that serves claude-opus-5-5 from `baseUrl`; the model binds signed thinking to its prompt prefix. */
function modelsYml(baseUrl: string): string {
	return `providers:
  anthropic:
    baseUrl: ${baseUrl}
    api: anthropic-messages
    auth: apiKey
    apiKey: not-a-secret
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000, cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}}
`;
}

interface SentRequest {
	url: string;
	body: MessagesRequest;
}

describe("a transcript prompt a process resumed onto another server restores", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with `models.yml` naming `server` and `agentsMd`
	 * as its context file: sends each prompt, then exits. Each request is answered with a reply that wrote its prompt
	 * to the cache, whichever server it went to.
	 */
	async function runProcess(
		tempDir: TempDir,
		server: string,
		agentsMd: string,
		prompts: string[],
		sessionFile?: string,
	): Promise<{ requests: SentRequest[]; sessionFile: string }> {
		await Bun.write(tempDir.join("models.yml"), modelsYml(server));
		const requests: SentRequest[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url !== `${FIRST_SERVER}/v1/messages` && url !== `${OTHER_SERVER}/v1/messages`) {
					throw new Error(`Unexpected request to ${url}`);
				}
				requests.push({ url, body: JSON.parse(requestBodyText(init) ?? "{}") });
				return answer(requests.length, { cacheWriteTokens: 100 });
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			for (const text of prompts) await session.prompt(text);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			spy.mockRestore();
		}
	}

	it("builds the prompt afresh when the session resumes on another server within the entry's lifetime", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-other-server-");
		const live = await runProcess(tempDir, FIRST_SERVER, "Build with make.", ["first"]);
		// Precondition: the transcript's request went to the first server.
		expect(live.requests.map(request => request.url)).toEqual([`${FIRST_SERVER}/v1/messages`]);

		const resumed = await runProcess(tempDir, OTHER_SERVER, "Build with ninja.", ["second"], live.sessionFile);

		// Precondition: the resumed process's request went to the other server.
		expect(resumed.requests.map(request => request.url)).toEqual([`${OTHER_SERVER}/v1/messages`]);
		const system = withoutCacheControl(resumed.requests[0]?.body.system);
		expect(system).not.toContain("Build with make.");
		expect(system).toContain("Build with ninja.");
	}, 60_000);

	// The control: resumed on the same server within the lifetime, the stored prompt stands in for this process's own
	// build, so the request reads the transcript's entry.
	it("keeps the stored prompt when the session resumes on the same server within the entry's lifetime", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-other-server-");
		const live = await runProcess(tempDir, FIRST_SERVER, "Build with make.", ["first"]);
		const resumed = await runProcess(tempDir, FIRST_SERVER, "Build with ninja.", ["second"], live.sessionFile);

		expect(resumed.requests.map(request => request.url)).toEqual([`${FIRST_SERVER}/v1/messages`]);
		expect(withoutCacheControl(resumed.requests[0]?.body.system)).toContain("Build with make.");
	}, 60_000);
});
