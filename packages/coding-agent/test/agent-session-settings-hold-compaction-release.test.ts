/**
 * A compaction rewrites every message after the system prompt and tools, so the cached prefix a held settings change
 * keeps is written again whatever the hold does. The change therefore goes out with the first request after the
 * compaction, instead of waiting for the five-minute bound or a lapse, and the prompt that request sends is the one a
 * session on the changed settings sends.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlayRebuild, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries and a model summary: no lapse ends the hold within the test, and `/compact` asks the model. */
const BASE_OVERLAY = `providers:
  cacheRetention: long
compaction:
  methodOrder: [soft]
  keepRecentTokens: 1
`;

/** The rebuilds a reload of this session's overlay starts. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshBaseSystemPrompt", "reconcileBuiltinTools"];

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	restoreFetch(): void;
}

describe("a settings change held on a bound prompt, at a compaction", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A session on the gateway's claude-opus-5-5 whose settings load `overlay` as a `--config` file. */
	async function startSession(overlay: string): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-hold-compaction-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
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
		return { session, settings, requests, overlay: overlayPath, restoreFetch };
	}

	it("sends the held change with the first request after a compaction", async () => {
		const changed = `${BASE_OVERLAY}personality: pragmatic\n`;
		// What a session on the changed settings sends, for the comparison.
		const reference = await startSession(changed);
		await reference.session.prompt("a session on the changed settings");
		reference.restoreFetch();
		const [rebuilt] = reference.requests;
		if (!rebuilt) throw new Error("Expected the reference session's request");

		const harness = await startSession(`${BASE_OVERLAY}personality: default\n`);
		await harness.session.prompt("first");
		await reloadOverlay(harness, changed, RELOAD_REBUILDS);
		// The hold stands while nothing rewrites the prompt: this request keeps the prompt the first one sent.
		await harness.session.prompt("while the change is held");
		const heldRequests = harness.requests.length;
		await harness.session.compact();
		await harness.session.prompt("after the compaction");

		const [first, held] = harness.requests;
		const afterCompaction = harness.requests.at(-1);
		if (!first || !held || !afterCompaction) throw new Error("Expected the requests around the compaction");
		expect(harness.requests.length).toBeGreaterThan(heldRequests);
		expect(withoutCacheControl(first.system)).not.toBe(withoutCacheControl(rebuilt.system));
		expect(withoutCacheControl(held.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(afterCompaction.system)).toBe(withoutCacheControl(rebuilt.system));
	}, 60_000);
});
