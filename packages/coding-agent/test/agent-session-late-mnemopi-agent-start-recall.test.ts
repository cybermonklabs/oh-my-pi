/**
 * Mnemopi recalls for the first turn when a turn's prompt is prepared, and once more in the background when the run
 * starts if that recall has not landed yet. On a model that binds thinking to its prompt the run's request is on its
 * way by then: a recall that succeeds this late must not rebuild the system prompt (the provider would write the
 * whole cached conversation again), but go out as a hidden message after the newest content, as every recall that
 * lands after the model answered does.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

afterEach(() => {
	vi.restoreAllMocks();
});

it("sends a recall that lands only when a later run starts after the newest content, keeping the prompt", async () => {
	using tempDir = TempDir.createSync("@pi-late-mnemopi-agent-start-recall-");
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
	const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	// Mnemopi starts in the background: wait for it before writing memories.
	const started = Promise.withResolvers<void>();
	const start = mnemopiBackend.start;
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await start.call(mnemopiBackend, options);
		started.resolve();
	});
	// The memory store fails the first two lookups: the recalls of the first two turns' prompt preparations (the first
	// run's background recall finds no earlier user message to recall for, so it looks nothing up).
	let failures = 2;
	const lookup = MnemopiSessionState.prototype.collectScopedRecallResults;
	vi.spyOn(MnemopiSessionState.prototype, "collectScopedRecallResults").mockImplementation(function (
		this: MnemopiSessionState,
		query: string,
	) {
		return failures-- > 0 ? Promise.reject(new Error("memory store unavailable")) : lookup.call(this, query);
	});
	const agentStartRecalls = vi.spyOn(MnemopiSessionState.prototype, "maybeRecallOnAgentStart");
	const settings = Settings.isolated({
		"providers.cacheRetention": "long",
		"compaction.enabled": false,
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": tempDir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
		"mnemopi.autoRetain": false,
	});
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const { session } = await createAgentSession({
		...gatewaySessionOptions(tempDir),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
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

		await session.prompt("Where is the deploy host?");
		await session.prompt("Is it still there?");
		// The background recall the second run started with has finished.
		await Promise.all(agentStartRecalls.mock.results.map(result => result.value));
		await session.prompt("And where is the deploy host now?");

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Preconditions: the first two requests went out without the recall, and the store answered after its failures.
		expect(withoutCacheControl(first.system)).not.toContain("alpha-7");
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(failures).toBeLessThan(0);
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(third.messages.slice(second.messages.length))).toContain("alpha-7");
	} finally {
		await session.dispose();
		authStorage.close();
		restore();
	}
}, 30_000);
