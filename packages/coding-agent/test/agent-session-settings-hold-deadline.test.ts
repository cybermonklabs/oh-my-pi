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
	textOf,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The same overlay with five-minute cache entries. */
const SHORT_ENTRIES = "providers:\n  cacheRetention: short\n";

const MINUTE_MS = 60_000;

/** The longest a held settings change may wait while requests keep the cache warm. */
const HOLD_BOUND_MS = 5 * MINUTE_MS;

/** The rebuilds a reload of these sessions' overlay starts. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshBaseSystemPrompt", "reconcileBuiltinTools"];

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	/** The session's working directory. */
	dir: TempDir;
	/** Puts the real `fetch` back. */
	restoreFetch(): void;
}

describe("a settings change held on a bound prompt, before it goes out", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A clock `Date.now` reads, moved by the test. */
	function startClock(): { advance(ms: number): void; now(): number } {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		return {
			advance: ms => {
				now += ms;
			},
			now: () => now,
		};
	}

	/**
	 * A session on the gateway's claude-opus-5-5 whose settings load `overlay` as a `--config` file. `replies` answers
	 * requests by their 1-based number; the rest get text.
	 */
	async function startSession(
		overlay: string,
		tools: string[],
		replies: Record<number, (turn: number) => Response> = {},
	): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-hold-deadline-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore: restoreFetch } = mockGatewayFetch(
			turn => replies[turn]?.(turn) ?? answer(turn, { cacheWriteTokens: 100 }),
		);
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
			toolNames: tools,
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay: overlayPath, dir, restoreFetch };
	}

	/** The first request of a session started on `overlay`: what a change to it looks like once it goes out. */
	async function requestOnSettings(overlay: string, tools: string[]): Promise<MessagesRequest> {
		const reference = await startSession(overlay, tools);
		await reference.session.prompt("a session on the changed settings");
		reference.restoreFetch();
		const [request] = reference.requests;
		if (!request) throw new Error("Expected the reference session's request");
		return request;
	}

	it("keeps the edit tool's definition as sent in every request made under five minutes after an edit-mode change", async () => {
		const tools = ["read", "edit"];
		const rebuilt = await requestOnSettings(`${LONG_ENTRIES}edit:\n  mode: replace\n`, tools);
		const clock = startClock();
		const harness = await startSession(`${LONG_ENTRIES}edit:\n  mode: hashline\n`, tools);
		await harness.session.prompt("first");
		clock.advance(30_000);
		const changedAt = clock.now();
		await reloadOverlay(harness, `${LONG_ENTRIES}edit:\n  mode: replace\n`, RELOAD_REBUILDS);
		// A request a minute keeps the one-hour entry warm, up to the last one before the bound.
		while (clock.now() - changedAt + MINUTE_MS < HOLD_BOUND_MS) {
			clock.advance(MINUTE_MS);
			await harness.session.prompt(`${(clock.now() - changedAt) / MINUTE_MS} minutes after the change`);
		}

		const [first, ...early] = harness.requests;
		if (!first) throw new Error("Expected the request before the change");
		expect(early).toHaveLength(4);
		expect(withoutCacheControl(rebuilt.tools)).not.toBe(withoutCacheControl(first.tools));
		// The tools come first in cache order: a definition rendered from the live setting rewrites the whole prompt.
		for (const request of early) expect(withoutCacheControl(request.tools)).toBe(withoutCacheControl(first.tools));
	}, 60_000);

	it("sends a held change at the first request after a five-minute cache entry lapses, before five minutes have passed", async () => {
		const tools = ["read", "todo"];
		const changed = `${SHORT_ENTRIES}todo:\n  enabled: true\npersonality: pragmatic\n`;
		const rebuilt = await requestOnSettings(changed, tools);
		const clock = startClock();
		const harness = await startSession(`${SHORT_ENTRIES}todo:\n  enabled: false\n`, tools);
		await harness.session.prompt("first");
		const entry = harness.session.observedPromptCacheEntry();
		if (!entry || entry.change !== undefined || entry.tier === "long") {
			throw new Error("Expected the first reply's live five-minute cache entry");
		}

		// The change comes two minutes after the request; the next one comes a minute after the five-minute entry
		// lapsed, four minutes after the change.
		clock.advance(2 * MINUTE_MS);
		await reloadOverlay(harness, changed, RELOAD_REBUILDS);
		clock.advance(4 * MINUTE_MS);
		await harness.session.prompt("after the lapse");

		const [first, afterLapse] = harness.requests;
		if (!first || !afterLapse) throw new Error("Expected the requests around the lapse");
		expect(withoutCacheControl(first.system)).not.toBe(withoutCacheControl(rebuilt.system));
		expect(withoutCacheControl(afterLapse.system)).toBe(withoutCacheControl(rebuilt.system));
		expect((afterLapse.tools ?? []).map(tool => tool.name)).toContain("todo");
	}, 60_000);

	it("tells the model the change is held and when it goes out, and never that it applies", async () => {
		const clock = startClock();
		const harness = await startSession(`${LONG_ENTRIES}personality: default\n`, ["read"]);
		await harness.session.prompt("first");
		clock.advance(30_000);
		const changedAt = clock.now();
		await reloadOverlay(harness, `${LONG_ENTRIES}personality: pragmatic\n`, RELOAD_REBUILDS);
		clock.advance(MINUTE_MS);
		await harness.session.prompt("a minute after the change");

		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		const notice = textOf(second.messages.slice(first.messages.length));
		expect(notice).toContain("`personality`");
		expect(notice).toContain("is held");
		// The rebuild comes at the first request five minutes after the change, which the model cannot know otherwise.
		expect(notice).toContain(new Date(changedAt + HOLD_BOUND_MS).toISOString());
		expect(notice).not.toMatch(/appl(y|ies) now|in force/i);
	}, 60_000);

	it("runs an edit call shaped by the edit definition the hold keeps as that definition says", async () => {
		// The model answers the second request with an edit in the `replace` shape the requests still declare.
		const harness = await startSession(`${LONG_ENTRIES}edit:\n  mode: replace\n`, ["read", "edit"], {
			2: turn =>
				toolCallAnswer(
					turn,
					"edit",
					{ path: "notes.txt", old_string: "alpha", new_string: "beta" },
					{ cacheWriteTokens: 100 },
				),
		});
		await Bun.write(harness.dir.join("notes.txt"), "alpha\n");
		await harness.session.prompt("first");
		await reloadOverlay(harness, `${LONG_ENTRIES}edit:\n  mode: hashline\n`, RELOAD_REBUILDS);
		await harness.session.prompt("replace alpha with beta in notes.txt");

		const [first, second, third] = harness.requests;
		if (!first || !second || !third) throw new Error("Expected the requests around the edit call");
		// Precondition: the edit tool went out with the definition it had before the change.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		const result = third.messages
			.flatMap(message =>
				Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
			)
			.find(block => block.type === "tool_result" && block.tool_use_id === "toolu_2");
		// A call parsed in the live mode fails: the model is offered no way to edit until the rebuild.
		expect(result?.is_error).not.toBe(true);
		expect(await Bun.file(harness.dir.join("notes.txt")).text()).toBe("beta\n");
	}, 60_000);
});
