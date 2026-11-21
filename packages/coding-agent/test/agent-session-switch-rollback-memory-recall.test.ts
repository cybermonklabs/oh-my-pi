/**
 * A session switch starts the memory backend's tracking afresh for the target transcript: the first turn there recalls
 * again. A switch that fails puts the session back on its own transcript, whose first turn already recalled; its next
 * request must carry that recall once, as it would have without the switch, not a second recall beside it.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** The recall block opens with this sentence, so every copy of the recall a request carries holds it. */
const RECALL_OPENING = "Treat recalled memories as background knowledge";

afterEach(() => {
	vi.restoreAllMocks();
});

it("keeps the first turn's Mnemopi recall after a session switch that fails", async () => {
	using tempDir = TempDir.createSync("@pi-switch-rollback-recall-");
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
	const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	// Mnemopi starts in the background: wait for it before writing memories.
	const started = Promise.withResolvers<void>();
	const start = mnemopiBackend.start;
	vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
		await start.call(mnemopiBackend, options);
		started.resolve();
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
	});
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const sessionDir = tempDir.join("sessions");
	const { session } = await createAgentSession({
		...gatewaySessionOptions(tempDir),
		sessionManager: SessionManager.create(tempDir.path(), sessionDir),
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
		const recalled = state.rememberScoped("The deploy host is alpha-7.");

		await session.prompt("Where is the deploy host?");
		// The recalled memory is forgotten since: a recall made again would report it gone.
		state.editScopedMemory("forget", recalled);
		const target = SessionManager.create(tempDir.path(), sessionDir);
		target.appendMessage({ role: "user", content: "Another task.", timestamp: Date.now() });
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected the target session's file");
		vi.spyOn(SessionAdvisors.prototype, "restoreCost").mockImplementationOnce(() => {
			throw new Error("forced switch failure");
		});
		await expect(session.switchSession(targetFile)).rejects.toThrow("forced switch failure");
		await session.prompt("And the deploy host again?");

		const [first, second] = gateway.requests;
		if (!first || !second) throw new Error("Expected two requests");
		// Precondition: the first turn recalled the memory.
		expect(copiesIn({ system: first.system, messages: first.messages }, RECALL_OPENING)).toBe(1);
		// The session is back on its transcript, whose first turn recalled already: the next request continues it with
		// the one recall and no second recall's report, as it would have without the switch.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(copiesIn({ system: second.system, messages: second.messages }, RECALL_OPENING)).toBe(1);
		expect(copiesIn(second.messages, "The deploy host is alpha-7.")).toBe(0);
	} finally {
		await session.dispose();
		authStorage.close();
		gateway.restore();
	}
}, 30_000);
