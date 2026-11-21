/**
 * A Mnemopi recall that first succeeds after the model answered goes out as a hidden message after the turn's newest
 * content, on the branch that turn extends. The session adopts it as its first-turn recall and never recalls again.
 * These cases check that the memories keep reaching the model where that hidden message is not on the branch, and
 * that a recall a later memory store returns is sent rather than recorded as delivered.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findDeliveredRecall } from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { cfgMnemopiDbPath } from "@oh-my-pi/pi-coding-agent/mnemopi/settings";
import { getMnemopiSessionState, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const DEPLOY_MEMORY = "The deploy host is alpha-7.";
const BUILD_MEMORY = "The build host is beta-9.";

/** How many times `request` carries `text`, system prompt and messages together. */
function copies(request: MessagesRequest, text: string): number {
	return withoutCacheControl({ system: request.system, messages: request.messages }).split(text).length - 1;
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	/** Lets the memory store answer lookups; it fails every lookup until then. */
	storeUp(): void;
}

describe("a late Mnemopi recall outside the branch that delivered it", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(tempDir: TempDir, overrides: Readonly<Record<string, unknown>> = {}): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(async () => restore());
		// Mnemopi starts in the background: wait for it before writing memories.
		const started = Promise.withResolvers<void>();
		const start = mnemopiBackend.start;
		vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
			await start.call(mnemopiBackend, options);
			started.resolve();
		});
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
			...overrides,
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
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		await started.promise;
		return {
			session,
			settings,
			requests,
			storeUp: () => {
				storeDown = false;
			},
		};
	}

	/** The first turn's recall fails; the second turn's succeeds and goes out as a hidden message. */
	async function deliverLateRecall(harness: Harness): Promise<void> {
		const state = getMnemopiSessionState(harness.session);
		if (!state) throw new Error("Expected Mnemopi to start");
		state.rememberScoped(DEPLOY_MEMORY);
		await harness.session.prompt("Where is the deploy host?");
		harness.storeUp();
		await harness.session.prompt("And where is the deploy host now?");
		const delivered = findDeliveredRecall(harness.session.sessionManager.getBranchView());
		if (!delivered?.includes(DEPLOY_MEMORY)) throw new Error("Expected the second turn to deliver the recall late");
		const second = harness.requests[1];
		if (harness.requests.length !== 2 || !second) throw new Error("Expected two requests");
		expect(copies(second, DEPLOY_MEMORY)).toBe(1);
	}

	it("keeps sending the recalled memories after /tree rewinds the turn that delivered them", async () => {
		const tempDir = TempDir.createSync("@pi-late-recall-branches-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir);
		await deliverLateRecall(harness);

		// The user rewinds to edit the second prompt: the leaf moves to the first turn's reply.
		const secondPrompt = harness.session.sessionManager
			.getBranch()
			.find(
				entry =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("And where is the deploy host now?"),
			);
		if (!secondPrompt) throw new Error("Expected the second prompt on the branch");
		const navigated = await harness.session.navigateTree(secondPrompt.id);
		expect(navigated.cancelled).toBe(false);
		await harness.session.prompt("Which host do we deploy to?");

		const rewound = harness.requests[2];
		if (harness.requests.length !== 3 || !rewound) throw new Error("Expected three requests");
		// The session still holds the recall as adopted, so it will not recall again on this branch.
		const state = getMnemopiSessionState(harness.session);
		expect(state?.hasRecalledForFirstTurn).toBe(true);
		expect(state?.lastRecallSnippet).toContain(DEPLOY_MEMORY);
		// A recall in the system prompt stays on every branch, so the late one must reach this branch too instead
		// of leaving the rest of the conversation without the memories.
		expect(copies(rewound, DEPLOY_MEMORY)).toBe(1);
	}, 30_000);

	it("sends the recall of a memory store the session moves to after a late recall", async () => {
		const tempDir = TempDir.createSync("@pi-late-recall-branches-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir);
		await deliverLateRecall(harness);

		// The operator points Mnemopi at another database: the backend restarts and recalls afresh from it.
		cfgMnemopiDbPath.override(harness.settings, tempDir.join("other-mnemopi.db"));
		await harness.session.settleMemoryBackend();
		const moved = getMnemopiSessionState(harness.session);
		if (!moved) throw new Error("Expected Mnemopi to restart on the other database");
		moved.rememberScoped(BUILD_MEMORY);
		await harness.session.prompt("Where is the build host?");
		await harness.session.prompt("And the build host again?");

		const [, , third, fourth] = harness.requests;
		if (harness.requests.length !== 4 || !third || !fourth) throw new Error("Expected four requests");
		// Mnemopi adopted the new store's recall as delivered: it is the session's recall from here on.
		expect(getMnemopiSessionState(harness.session)?.lastRecallSnippet).toContain(BUILD_MEMORY);
		// So it must reach the model rather than be kept back while only the old store's memories go out.
		expect(copies(third, BUILD_MEMORY) + copies(fourth, BUILD_MEMORY)).toBeGreaterThan(0);
	}, 30_000);

	it("sends the recall again in the turn whose pre-prompt compaction summarized it", async () => {
		const tempDir = TempDir.createSync("@pi-late-recall-branches-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir, {
			"compaction.enabled": true,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdTokens": 60_000,
			// A blocking compaction: no background speculation takes the threshold pass over.
			"compaction.asyncEnabled": false,
		});
		await deliverLateRecall(harness);
		await harness.session.prompt("Check the queue.");
		await harness.session.prompt("Check the workers.");

		// The user comes back two hours later, after the cache entry lapsed, and pastes a long log: the pending prompt
		// crosses the compaction threshold, so the turn compacts the history, the recall's turn included, first.
		const realNow = Date.now;
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60 * 60_000);
		const log = Array.from({ length: 8_000 }, (_, line) => `worker ${line}: drained the queue\n`).join("");
		await harness.session.prompt(`Here is the deploy log:\n${log}`);

		const compacted = harness.session.sessionManager.getBranch().some(entry => entry.type === "compaction");
		if (!compacted) throw new Error("Expected the log's turn to compact before its request");
		// The turn's own request: a conversation, unlike the one-message summary requests around it.
		const turn = harness.requests.find(
			request =>
				request.messages.length > 1 && withoutCacheControl(request.messages).includes("worker 7999: drained"),
		);
		if (!turn) throw new Error("Expected the log turn's request");
		if (withoutCacheControl(turn.messages).includes("Check the queue.")) {
			throw new Error("Expected the compaction to rewrite the history before the turn's request");
		}
		// The session still holds the recall as adopted, so it recalls nothing new for this turn.
		expect(getMnemopiSessionState(harness.session)?.lastRecallSnippet).toContain(DEPLOY_MEMORY);
		// The compaction summarized the hidden message that carried the recall, so this turn must carry it again, as a
		// recall in the system prompt is, instead of going out without the memories.
		expect(copies(turn, DEPLOY_MEMORY)).toBe(1);
	}, 60_000);
});
