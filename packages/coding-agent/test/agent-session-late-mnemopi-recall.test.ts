/**
 * Mnemopi cuts a recall to its token budget (`mnemopi.injectionTokenLimit`) next to its memory instructions when it
 * delivers it, and cuts its recall again, to the budget of the moment, on every later render of those instructions.
 * A recall that first succeeds after the model answered goes out as a hidden message after the turn's newest
 * content. That message must stay the conversation's one copy of it: a system prompt rebuild after the budget
 * changed must not put a differently cut copy into the system prompt beside it.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findDeliveredRecall } from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { cfgMnemopiInjectionTokenLimit } from "@oh-my-pi/pi-coding-agent/mnemopi/settings";
import { getMnemopiSessionState, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	GATEWAY,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** The recall block opens with this sentence, so every cut of the block a prompt carries holds it. */
const RECALL_OPENING = "Treat recalled memories as background knowledge";

/** The gateway with two Claude models, so the session can switch between them. */
function twoModelsYml(): string {
	const card = "reasoning: true, input: [text, image], contextWindow: 1000000, maxTokens: 128000";
	const cost = "cost: {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5}";
	return `providers:
  anthropic:
    baseUrl: ${GATEWAY}
    api: anthropic-messages
    auth: apiKey
    apiKey: gateway-test-key
    compat:
      replayUnsignedThinking: false
      supportsLongCacheRetention: true
    models:
      - {id: claude-opus-5-5, name: Claude Opus 5.5, ${card}, ${cost}}
      - {id: claude-opus-5, name: Claude Opus 5, ${card}, ${cost}}
`;
}

/** How many times `request` carries `text`, system prompt and messages together. */
function copies(request: MessagesRequest, text: string): number {
	return withoutCacheControl({ system: request.system, messages: request.messages }).split(text).length - 1;
}

afterEach(() => {
	vi.restoreAllMocks();
});

it("keeps a late Mnemopi recall out of a system prompt rebuilt after its token budget shrank", async () => {
	using tempDir = TempDir.createSync("@pi-late-mnemopi-recall-");
	await Bun.write(tempDir.join("models.yml"), twoModelsYml());
	const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	// Mnemopi starts in the background: wait for it before writing memories.
	const started = Promise.withResolvers<void>();
	const start = mnemopiBackend.start;
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await start.call(mnemopiBackend, options);
		started.resolve();
	});
	// The memory store fails every lookup of the first turn, so the first recall succeeds on the second.
	let storeDown = true;
	const lookup = MnemopiSessionState.prototype.collectScopedRecallResults;
	vi.spyOn(MnemopiSessionState.prototype, "collectScopedRecallResults").mockImplementation(function (
		this: MnemopiSessionState,
		query: string,
	) {
		return storeDown ? Promise.reject(new Error("memory store unavailable")) : lookup.call(this, query);
	});
	const settings = Settings.isolated({
		"providers.cacheRetention": "long",
		"compaction.enabled": false,
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": tempDir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.autoRetain": false,
		"mnemopi.injectionTokenLimit": 300,
	});
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	const other = modelRegistry.find("anthropic", "claude-opus-5");
	if (!model || !other) throw new Error("Expected the gateway's two models");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
	const { session } = await createAgentSession({
		...gatewaySessionOptions(tempDir),
		sessionManager,
		authStorage,
		modelRegistry,
		settings,
		model,
		toolNames: ["read"],
		contextFiles: [],
		skills: [],
	});
	try {
		await started.promise;
		const state = getMnemopiSessionState(session);
		if (!state) throw new Error("Expected Mnemopi to start");
		state.rememberScoped("The deploy host is alpha-7.");
		state.rememberScoped(`The deploy host runbook: ${"drain the queue, then rotate the keys. ".repeat(5)}`);
		state.rememberScoped(`The deploy host checklist: ${"restart the workers, then watch the logs. ".repeat(5)}`);

		await session.prompt("Where is the deploy host?");
		storeDown = false;
		await session.prompt("And where is the deploy host now?");
		// The recall went out as a hidden message, cut by the budget.
		expect(findDeliveredRecall(sessionManager.getBranchView())?.endsWith("…")).toBe(true);

		cfgMnemopiInjectionTokenLimit.override(settings, 270);
		await session.prompt("third");
		await session.setModel(other, "default", { persist: false });
		await session.prompt("fourth");

		const rebuilt = requests.at(-1);
		if (requests.length !== 4 || !rebuilt) throw new Error("Expected four requests");
		expect(withoutCacheControl(rebuilt.system)).not.toContain(RECALL_OPENING);
		expect(copies(rebuilt, RECALL_OPENING)).toBe(1);
	} finally {
		await session.dispose();
		authStorage.close();
		restore();
	}
}, 30_000);
