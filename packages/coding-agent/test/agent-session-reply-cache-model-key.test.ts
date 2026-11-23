/**
 * A main reply carries the model its request went out as, as the prompt cache keys it (`promptCacheModelKey`: provider,
 * id, wire API and endpoint), into the transcript: a resumed process compares it with the key its own requests go out
 * under, so an entry another server holds is not read as its own. The record stays out of every request: the next
 * request's bytes are the same with it and without it. A reply an earlier release wrote has no record and compares as
 * that release did, by provider, id and the API it went out on. A copy of the session (`omp --fork`, `/fork`) keeps it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ObservedPromptCacheEntry } from "@oh-my-pi/pi-coding-agent/session/prompt-cache-status";
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

/** A `models.yml` that serves claude-opus-5-5 and claude-sonnet-4-5 from `baseUrl`. */
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
      - {id: claude-sonnet-4-5, name: Claude Sonnet 4.5, reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 64000, cost: {input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75}}
`;
}

interface ProcessRun {
	/** Each request body as it was sent, oldest first. */
	bodies: string[];
	sessionFile: string;
	/** The prompt-cache entry the transcript left, as the process judged it before its first request. */
	cacheEntryAtStart: ObservedPromptCacheEntry | undefined;
}

/** Assistant messages of the session file at `file`, as stored. */
async function storedReplies(file: string): Promise<Record<string, unknown>[]> {
	const lines = (await Bun.file(file).text()).split("\n").filter(line => line.trim().length > 0);
	return lines
		.map(line => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
		.flatMap(entry => (entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : []));
}

describe("the prompt cache key a main reply records", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with `models.yml` naming `server`, `agentsMd` as
	 * its context file and `modelId` as its model: sends each prompt, then exits. Each request is answered with a reply
	 * that wrote its prompt to the cache.
	 */
	async function runProcess(
		tempDir: TempDir,
		server: string,
		agentsMd: string,
		prompts: string[],
		options: { sessionManager?: SessionManager; modelId?: string } = {},
	): Promise<ProcessRun> {
		await Bun.write(tempDir.join("models.yml"), modelsYml(server));
		const bodies: string[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url !== `${server}/v1/messages`) throw new Error(`Unexpected request to ${url}`);
				bodies.push(requestBodyText(init) ?? "");
				return answer(bodies.length, { cacheWriteTokens: 100 });
			}),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", options.modelId ?? "claude-opus-5-5");
		if (!model) throw new Error("Expected the configured model");
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir.path(), tempDir.join("sessions"));
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
			const cacheEntryAtStart = session.observedPromptCacheEntry();
			for (const text of prompts) await session.prompt(text);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { bodies, sessionFile: file, cacheEntryAtStart };
		} finally {
			await session.dispose();
			authStorage.close();
			spy.mockRestore();
		}
	}

	it("sends the next request byte for byte the same with the record and without it", async () => {
		using tempDir = TempDir.createSync("@pi-reply-cache-model-key-");
		const live = await runProcess(tempDir, FIRST_SERVER, "Build with make.", ["first"]);
		const [reply] = await storedReplies(live.sessionFile);
		// Precondition: the transcript's reply records the key its request went out under.
		expect(typeof reply?.promptCacheModelKey).toBe("string");

		// Two copies of the transcript: as written, and with the record taken off every reply.
		const text = await Bun.file(live.sessionFile).text();
		const name = live.sessionFile.slice(live.sessionFile.lastIndexOf("/") + 1);
		const withRecord = tempDir.join("with-record", name);
		const withoutRecord = tempDir.join("without-record", name);
		await Bun.write(withRecord, text);
		await Bun.write(
			withoutRecord,
			text
				.split("\n")
				.map(line => {
					if (line.trim().length === 0) return line;
					const entry = JSON.parse(line) as { message?: Record<string, unknown> };
					if (entry.message) delete entry.message.promptCacheModelKey;
					return JSON.stringify(entry);
				})
				.join("\n"),
		);
		expect((await storedReplies(withoutRecord))[0]).not.toHaveProperty("promptCacheModelKey");

		const resumedWith = await runProcess(tempDir, FIRST_SERVER, "Build with make.", ["second"], {
			sessionManager: await SessionManager.open(withRecord),
		});
		const resumedWithout = await runProcess(tempDir, FIRST_SERVER, "Build with make.", ["second"], {
			sessionManager: await SessionManager.open(withoutRecord),
		});

		expect(resumedWith.bodies).toHaveLength(1);
		expect(resumedWith.bodies[0]).toBe(resumedWithout.bodies[0]!);
		expect(resumedWith.bodies[0]).not.toContain("promptCacheModelKey");
	}, 60_000);

	/** A transcript as the release before the record writes it: one cached reply on claude-opus-5-5, a minute old. */
	async function writeEarlierReleaseTranscript(tempDir: TempDir): Promise<string> {
		const now = Date.now();
		const sentAt = now - 60_000;
		const at = new Date(sentAt).toISOString();
		const entries = [
			{ type: "session", version: 3, id: "earlier-release", timestamp: at, cwd: tempDir.path() },
			{ type: "model_change", id: "model", parentId: null, timestamp: at, model: "anthropic/claude-opus-5-5" },
			{
				type: "message",
				id: "user-1",
				parentId: "model",
				timestamp: at,
				message: { role: "user", content: "first", timestamp: sentAt },
			},
			{
				type: "message",
				id: "reply-1",
				parentId: "user-1",
				timestamp: at,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "seen 1" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-5-5",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 100,
						totalTokens: 115,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: sentAt,
					completedAt: sentAt + 1_000,
				},
			},
		];
		const file = tempDir.join("earlier", "earlier-release.jsonl");
		await Bun.write(file, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		return file;
	}

	it("compares a reply without the record by provider, id and API, as the release before it did", async () => {
		using tempDir = TempDir.createSync("@pi-reply-cache-model-key-");
		// On another server, the same model and API: without the record nothing names the endpoint the reply's request
		// went to, so the entry reads as the next request's.
		const otherServer = await runProcess(tempDir, OTHER_SERVER, "Build with make.", [], {
			sessionManager: await SessionManager.open(await writeEarlierReleaseTranscript(tempDir)),
		});
		expect(otherServer.cacheEntryAtStart).toMatchObject({ inferred: true });
		expect(otherServer.cacheEntryAtStart?.change).toBeUndefined();

		// Another model: the id decides, as before.
		const otherModel = await runProcess(tempDir, FIRST_SERVER, "Build with make.", [], {
			sessionManager: await SessionManager.open(await writeEarlierReleaseTranscript(tempDir)),
			modelId: "claude-sonnet-4-5",
		});
		expect(otherModel.cacheEntryAtStart?.change).toEqual({
			kind: "model",
			from: "Claude Opus 5.5",
			to: "Claude Sonnet 4.5",
		});
	}, 60_000);

	const copies: Array<{ name: string; copy: (file: string, tempDir: TempDir) => Promise<SessionManager> }> = [
		{
			name: "omp --fork",
			copy: (file, tempDir) => SessionManager.forkFrom(file, tempDir.path(), tempDir.join("forks")),
		},
		{
			name: "/fork",
			copy: async file => {
				const manager = await SessionManager.open(file);
				await manager.fork();
				return manager;
			},
		},
	];
	for (const { name, copy } of copies) {
		it(`keeps the record in a copy of the session (${name}), which builds its prompt afresh on another server`, async () => {
			using tempDir = TempDir.createSync("@pi-reply-cache-model-key-");
			const live = await runProcess(tempDir, FIRST_SERVER, "Build with make.", ["first"]);
			const resumed = await runProcess(tempDir, OTHER_SERVER, "Build with ninja.", ["second"], {
				sessionManager: await copy(live.sessionFile, tempDir),
			});

			expect(resumed.sessionFile).not.toBe(live.sessionFile);
			const system = withoutCacheControl((JSON.parse(resumed.bodies[0]!) as MessagesRequest).system);
			expect(system).not.toContain("Build with make.");
			expect(system).toContain("Build with ninja.");
		}, 60_000);
	}
});
