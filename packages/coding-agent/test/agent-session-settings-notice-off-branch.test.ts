import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
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

/** The `--config` overlay a configuration sync rewrites under a running session. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

/** Every text a wire value carries: text blocks, string contents and nested tool results. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.content].map(textOf).join("\n");
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
}

/**
 * Whether `request` tells the model the personality change: its system prompt is no longer the one `before` was
 * sent with (the rebuild ran), or a message it carries names the setting (the settings notice).
 */
function tellsPersonalityChange(before: MessagesRequest, request: MessagesRequest): boolean {
	return (
		withoutCacheControl(request.system) !== withoutCacheControl(before.system) ||
		textOf(request.messages).includes("`personality`")
	);
}

describe("a held settings change reaches the conversation the model continues", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(tempDir: TempDir): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, OVERLAY);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
		return { session, settings, requests, overlay };
	}

	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuild the change starts. */
	async function reloadOverlay(harness: Harness, content: string): Promise<void> {
		const rebuild = vi.spyOn(harness.session, "refreshBaseSystemPrompt");
		await Bun.write(harness.overlay, content);
		await harness.settings.reloadFromDisk();
		// The settings listeners run in the microtask the reload queued for them.
		await Promise.resolve();
		await Promise.all(rebuild.mock.results.map(result => result.value));
		rebuild.mockRestore();
	}

	it("tells the model of a held change again after /tree moves to a reply the notice came after", async () => {
		const tempDir = TempDir.createSync("@pi-settings-notice-off-branch-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir);
		await harness.session.prompt("first");
		const firstReply = harness.session.sessionManager
			.getBranchView()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (!firstReply) throw new Error("Expected the first reply on the branch");

		await reloadOverlay(harness, `${OVERLAY}personality: pragmatic\n`);
		await harness.session.prompt("second");
		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		// Precondition: the second request kept the prompt and carried the notice.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`personality`");

		// The user continues from the first reply: the branch the model now sees holds no notice.
		await harness.session.navigateTree(firstReply.id);
		await harness.session.prompt("third, on the branch from the first reply");

		const third = harness.requests[2];
		if (!third) throw new Error("Expected the request on the new branch");
		// A consumer on this branch otherwise gets answers under the old personality with no word of the change.
		expect(tellsPersonalityChange(first, third)).toBe(true);
	}, 30_000);

	it("tells the model of a held change in a recent session the user switches to", async () => {
		const tempDir = TempDir.createSync("@pi-settings-notice-off-branch-");
		cleanups.push(() => tempDir.remove());
		const harness = await startSession(tempDir);
		await harness.session.prompt("first, in the other session");
		const otherSession = harness.session.sessionFile;
		if (!otherSession) throw new Error("Expected a persisted session file");

		await harness.session.newSession();
		await harness.session.prompt("first, in this session");
		await reloadOverlay(harness, `${OVERLAY}personality: pragmatic\n`);
		await harness.session.prompt("second, in this session");
		const [otherFirst, first, second] = harness.requests;
		if (!otherFirst || !first || !second) throw new Error("Expected three requests");
		// Precondition: this session's second request kept the prompt and carried the notice.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`personality`");

		// `/resume` of the other session, whose cached prompt is still live.
		await harness.session.switchSession(otherSession);
		await harness.session.prompt("second, in the other session");

		const resumed = harness.requests[3];
		if (!resumed) throw new Error("Expected the request in the switched-to session");
		expect(tellsPersonalityChange(otherFirst, resumed)).toBe(true);
	}, 30_000);
});
