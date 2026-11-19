/**
 * Sessions for the cases where a failed turn is kept in context and continued
 * from (a stream cut or a rate limit after visible text, a malformed call),
 * then read back as a reload, a resume or a compaction reads the session. The
 * primary model's requests run the real `anthropic-messages` provider; only its
 * HTTP client is replaced, so no request leaves the process.
 *
 * Call {@link useKeptTurnSessions} inside a `describe`: it registers the hooks
 * that own the temporary directory, the auth store and the mocks.
 */
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sessionMessagePersistenceKey } from "@oh-my-pi/pi-coding-agent/session/turn-persistence";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { mockSchedulerWaitWithClock } from "./mock-scheduler-clock";

export const PROVIDER = "anthropic";
export const PRIMARY = "claude-opus-5-5";
export const TOOL_CALL_ID = "toolu_kept_turn";
export const FIRST_TEXT = "Here is the first part of the answer";
export const CONTINUED_TEXT = ", and here is the rest of it.";
export const FRESH_TEXT = "A fresh answer.";
const MAX_RETRIES = 2;
const MAX_DELAY_MS = 120_000;
const RATE_LIMIT_MESSAGE = "This request would exceed your organization's rate limit.";
const RENDER_WIDTH = 120;

function sseFrame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const MESSAGE_START_FRAME = sseFrame("message_start", {
	type: "message_start",
	message: {
		id: "msg_kept_turn",
		type: "message",
		role: "assistant",
		model: PRIMARY,
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 1 },
	},
});

/** Opens a text block and streams `text` into it, leaving the block and the message open. */
export function textFrames(text: string): string {
	return (
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}) +
		sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		})
	);
}

export const TEXT_FRAMES = textFrames(FIRST_TEXT);

/** Closes the text block and streams a whole `read` tool call after it. */
export const COMPLETE_TOOL_CALL_FRAMES =
	sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sseFrame("content_block_start", {
		type: "content_block_start",
		index: 1,
		content_block: { type: "tool_use", id: TOOL_CALL_ID, name: "read", input: {} },
	}) +
	sseFrame("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"path": "/tmp/notes.txt"}' },
	}) +
	sseFrame("content_block_stop", { type: "content_block_stop", index: 1 });

export const RATE_LIMIT_FRAME = sseFrame("error", {
	type: "error",
	error: {
		type: "rate_limit_error",
		message: `This request would exceed your organization's rate limit of 10,000,000 input tokens per minute (org: test-org, model: ${PRIMARY}).`,
	},
});

/** An overload inside the open message: the provider reports it as a cut stream. */
export const OVERLOADED_FRAME = sseFrame("error", {
	type: "error",
	error: { type: "overloaded_error", message: "Overloaded" },
});

/** A whole answer whose only text is `text`. */
export function answer(text: string): string {
	return (
		MESSAGE_START_FRAME +
		sseFrame("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}) +
		sseFrame("content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		}) +
		sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }) +
		sseFrame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 8 },
		}) +
		sseFrame("message_stop", { type: "message_stop" })
	);
}

/** A whole answer, as the continuation gets it. */
export const CONTINUED_ANSWER = answer(CONTINUED_TEXT);

/**
 * What a request to the primary answers: a 200 event stream, or an HTTP
 * refusal. A `held` stream stays open after its frames until the request is
 * aborted.
 */
export type PrimaryAnswer = { stream: string; held?: true } | { status: number; retryAfterSeconds?: number };

/** An HTTP 429 rate limit at request time. */
export const HTTP_RATE_LIMIT: PrimaryAnswer = { status: 429 };

async function primaryResponse(
	primary: PrimaryAnswer,
	signal: AbortSignal | undefined,
	onHeld: () => void,
): Promise<Response> {
	const headers = new Headers({ "request-id": "req_kept_turn" });
	if ("stream" in primary) {
		headers.set("content-type", "text/event-stream");
		const frames = new TextEncoder().encode(primary.stream);
		if (!primary.held) return new Response(frames, { status: 200, headers });
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(frames);
				signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
				onHeld();
			},
		});
		return new Response(body, { status: 200, headers });
	}
	headers.set("content-type", "application/json");
	if (primary.retryAfterSeconds !== undefined) headers.set("retry-after", String(primary.retryAfterSeconds));
	const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: RATE_LIMIT_MESSAGE } });
	// What the HTTP client throws for a refused request.
	throw await AIError.AnthropicApiError.fromResponse(new Response(body, { status: primary.status, headers }));
}

/** The conversation a model request is built from: what each user, assistant and tool-result message holds. */
export function conversation(messages: readonly AgentMessage[]): string[] {
	const shapes: string[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			shapes.push("user");
		} else if (message.role === "toolResult") {
			shapes.push(`result:${message.toolCallId}`);
		} else if (message.role === "assistant") {
			const blocks = message.content.map(block =>
				block.type === "text" ? `text:${block.text}` : block.type === "toolCall" ? `call:${block.id}` : block.type,
			);
			shapes.push(`assistant[${blocks.join(" ")}]`);
		}
	}
	return shapes;
}

/** The lines the transcript draws for an assistant turn, without colours. */
export function renderTurn(message: AssistantMessage): string[] {
	const component = new AssistantMessageComponent(message, false);
	return Bun.stripANSI(component.render(RENDER_WIDTH).join("\n"))
		.split("\n")
		.map(line => line.trimEnd());
}

/** The first failed assistant turn of `messages`. */
export function failedTurn(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	return messages.find(
		(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error",
	);
}

interface KeptTurnSessionOptions {
	/** The context the session starts from, as a resume builds it from the session file. */
	messages?: AgentMessage[];
	/** Settings over the harness's own retry and compaction settings. */
	settings?: Record<string, unknown>;
	/** A model other than the Anthropic primary, with the stream function that answers it. */
	model?: Model;
	streamFn?: StreamFn;
	/** The summary a `/compact` takes from an extension hook instead of a model call. */
	compactionSummary?: string;
}

interface KeptTurnRun {
	/** Requests the primary received. */
	requests: number;
	session: AgentSession;
	/** The session file, opened again as a resume opens it. */
	reopened: SessionManager;
	/** The conversation the session holds live. */
	live: string[];
	/** The conversation the reopened file rebuilds for the model. */
	rebuilt: string[];
	/** The reopened file's first failed assistant entry. */
	failedEntry: SessionEntry | undefined;
}

interface KeptTurnSessions {
	/** What the primary's next requests answer, in order; the last answers every later one. */
	answers: PrimaryAnswer[];
	/** Requests the primary received in this case. */
	readonly requests: number;
	/** The messages of each request the primary received in this case, as the provider got them. */
	readonly requestMessages: readonly AgentMessage[][];
	/** Settles once a `held` answer of this case has sent its frames and waits for the abort. */
	readonly answerHeld: Promise<void>;
	readonly tempDir: TempDir;
	readonly authStorage: AuthStorage;
	/** A new persisted session in the case's temporary directory. */
	createSessionManager(): SessionManager;
	/** A session on `sessionManager`; disposed after the case. */
	startSession(sessionManager: SessionManager, options?: KeptTurnSessionOptions): Promise<AgentSession>;
	/** Writes what `sessionManager` holds to its file and opens that file again, as a resume does. */
	reopen(sessionManager: SessionManager): Promise<SessionManager>;
	/**
	 * Each assistant turn of `session` as the transcript drew it live: the
	 * message at its end, with the `retryRecovery` a later `auto_retry_end`
	 * applied to it.
	 */
	drawnTurns(session: AgentSession): AssistantMessage[];
	/**
	 * Sends `prompts` in turn on a new session whose primary requests take
	 * `answers` in order (the last repeating), then opens its file again.
	 */
	runAndReopen(
		answers: PrimaryAnswer[],
		options?: KeptTurnSessionOptions & { prompts?: string[] },
	): Promise<KeptTurnRun>;
}

export function useKeptTurnSessions(): KeptTurnSessions {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let modelRegistry: ModelRegistry | undefined;
	let sessions: AgentSession[] = [];
	let managers: SessionManager[] = [];
	let requests = 0;
	let requestMessages: AgentMessage[][] = [];
	let answerHeld = Promise.withResolvers<void>();
	const drawn = new WeakMap<AgentSession, AssistantMessage[]>();

	const setUp = <T>(value: T | undefined, name: string): T => {
		if (value === undefined) throw new Error(`${name} is set up in beforeAll`);
		return value;
	};

	const harness: KeptTurnSessions = {
		answers: [],
		get requests() {
			return requests;
		},
		get requestMessages() {
			return requestMessages;
		},
		get answerHeld() {
			return answerHeld.promise;
		},
		get tempDir() {
			return setUp(tempDir, "tempDir");
		},
		get authStorage() {
			return setUp(authStorage, "authStorage");
		},

		createSessionManager() {
			const dir = harness.tempDir.path();
			const sessionManager = SessionManager.create(dir, path.join(dir, "sessions"));
			managers.push(sessionManager);
			return sessionManager;
		},

		async startSession(sessionManager, options = {}) {
			const model = options.model ?? getBundledModel(PROVIDER, PRIMARY);
			if (!model) throw new Error(`Expected bundled ${PROVIDER}/${PRIMARY}`);
			const streamFn: StreamFn =
				options.streamFn ??
				((requested, context, streamOptions) =>
					streamAnthropic(requested as Model<"anthropic-messages">, context, {
						...streamOptions,
						apiKey: `${requested.provider}-test-key`,
						providerRetryWait: async () => {},
					}));
			const agent = new Agent({
				getApiKey: requested => `${requested.provider}-test-key`,
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: options.messages ?? [] },
				streamFn: (requested, context, streamOptions) => {
					requestMessages.push([...context.messages]);
					return streamFn(requested, context, streamOptions);
				},
			});
			const registry = setUp(modelRegistry, "modelRegistry");
			const session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.baseDelayMs": 1,
					"retry.maxRetries": MAX_RETRIES,
					"retry.maxDelayMs": MAX_DELAY_MS,
					...options.settings,
				}),
				modelRegistry: registry,
				extensionRunner:
					options.compactionSummary === undefined
						? undefined
						: await compactionSummaryRunner(options.compactionSummary, sessionManager, registry),
			});
			sessions.push(session);

			const turns: AssistantMessage[] = [];
			drawn.set(session, turns);
			session.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					turns.push(structuredClone(event.message));
				} else if (event.type === "auto_retry_end") {
					for (const update of event.retryErrors ?? []) {
						const turn = turns.find(message => sessionMessagePersistenceKey(message) === update.persistenceKey);
						if (turn) turn.retryRecovery = update.retryRecovery;
					}
				}
			});
			return session;
		},

		async reopen(sessionManager) {
			await sessionManager.flush();
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("Expected the session to persist a file");
			const reopened = await SessionManager.open(sessionFile, path.dirname(sessionFile), undefined, {
				suppressBreadcrumb: true,
			});
			managers.push(reopened);
			return reopened;
		},

		drawnTurns(session) {
			return drawn.get(session) ?? [];
		},

		async runAndReopen(answers, options = {}) {
			harness.answers = answers;
			const sessionManager = harness.createSessionManager();
			const session = await harness.startSession(sessionManager, options);

			for (const text of options.prompts ?? ["Answer in two parts"]) {
				await session.prompt(text);
				await session.waitForIdle();
			}

			const reopened = await harness.reopen(sessionManager);
			const failedEntry = reopened
				.getEntries()
				.find(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === "error",
				);
			return {
				requests,
				session,
				reopened,
				live: conversation(session.agent.state.messages),
				rebuilt: conversation(reopened.buildSessionContext().messages),
				failedEntry,
			};
		},
	};

	/** An extension runner whose `session_before_compact` hook gives `summary` and keeps the cut compaction chose. */
	async function compactionSummaryRunner(
		summary: string,
		sessionManager: SessionManager,
		registry: ModelRegistry,
	): Promise<ExtensionRunner> {
		const cwd = harness.tempDir.path();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => ({
					compaction: {
						summary,
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
			cwd,
			new EventBus(),
			runtime,
			"kept-turn-compaction",
		);
		return new ExtensionRunner([extension], runtime, cwd, sessionManager, registry);
	}

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-kept-turn-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(PROVIDER, `${PROVIDER}-test-key`);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage?.close();
		tempDir?.removeSync();
	});

	beforeEach(() => {
		sessions = [];
		managers = [];
		harness.answers = [];
		requests = 0;
		requestMessages = [];
		answerHeld = Promise.withResolvers<void>();
		modelRegistry?.clearSuppressedSelectors();
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((_params, options) => {
			requests++;
			const answers = harness.answers;
			const next = answers.length > 1 ? answers.shift()! : answers[0]!;
			const held = answerHeld;
			return { asResponse: () => primaryResponse(next, options?.signal, () => held.resolve()) } as never;
		});
		mockSchedulerWaitWithClock();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		for (const manager of managers.splice(0).reverse()) await manager.close();
		vi.restoreAllMocks();
	});

	return harness;
}
