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

/** The `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The longest a held settings change may wait while the cache stays warm. */
const HOLD_BOUND_MS = 5 * MINUTE_MS;

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	/** Puts the real `fetch` back. */
	restoreFetch(): void;
}

function toolNames(request: MessagesRequest): string[] {
	return (request.tools ?? []).map(tool => tool.name);
}

describe("a settings change held on a bound prompt goes out within five minutes or at the cache entry's lapse", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	function createTempDir(): TempDir {
		const dir = TempDir.createSync("@pi-settings-hold-bound-");
		cleanups.push(() => dir.remove());
		return dir;
	}

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

	/** A session on the gateway's claude-opus-5-5 whose settings load `OVERLAY` and `overlayExtra` as a `--config` file. */
	async function startSession(overlayExtra: string, tools: string[]): Promise<Harness> {
		const dir = createTempDir();
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `${OVERLAY}${overlayExtra}`);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
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
			toolNames: tools,
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay, restoreFetch };
	}

	/** The first request of a session started on the changed settings: what the change looks like once it goes out. */
	async function requestOnChangedSettings(overlayExtra: string, tools: string[]): Promise<MessagesRequest> {
		const reference = await startSession(overlayExtra, tools);
		await reference.session.prompt("a session on the changed settings");
		reference.restoreFetch();
		const [request] = reference.requests;
		if (!request) throw new Error("Expected the reference session's request");
		return request;
	}

	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuilds the change starts. */
	async function reloadOverlay(harness: Harness, content: string): Promise<void> {
		const rebuilds = [
			vi.spyOn(harness.session, "refreshBaseSystemPrompt"),
			vi.spyOn(harness.session, "reconcileBuiltinTools"),
		];
		await Bun.write(harness.overlay, content);
		await harness.settings.reloadFromDisk();
		// The settings listeners run in the microtask the reload queued for them.
		await Promise.resolve();
		await Promise.all(rebuilds.flatMap(spy => spy.mock.results.map(result => result.value)));
		for (const spy of rebuilds) spy.mockRestore();
	}

	/**
	 * Sends the first request, changes the overlay 30 s later, then sends a request every 60 s, which keeps the
	 * one-hour cache entry warm, up to the first request made five minutes after the change. Returns the request
	 * before the change, the requests made under five minutes after it, and the one made at five minutes.
	 */
	async function changeUnderWarmCache(
		before: string,
		after: string,
		tools: string[],
	): Promise<{ first: MessagesRequest; early: MessagesRequest[]; atBound: MessagesRequest }> {
		const clock = startClock();
		const harness = await startSession(before, tools);
		await harness.session.prompt("first");
		clock.advance(30_000);
		const changedAt = clock.now();
		await reloadOverlay(harness, `${OVERLAY}${after}`);
		while (clock.now() - changedAt < HOLD_BOUND_MS) {
			clock.advance(MINUTE_MS);
			await harness.session.prompt(`${(clock.now() - changedAt) / MINUTE_MS} minutes after the change`);
		}
		const [first, ...rest] = harness.requests;
		const atBound = rest.pop();
		if (!first || !atBound) throw new Error("Expected the requests around the change");
		// One request a minute from one to four minutes after the change.
		expect(rest).toHaveLength(4);
		return { first, early: rest, atBound };
	}

	it("sends a tool turned on in the first request made five minutes after the change, and not before", async () => {
		const { first, early, atBound } = await changeUnderWarmCache(
			"todo:\n  enabled: false\n",
			"todo:\n  enabled: true\n",
			["read", "todo"],
		);

		expect(toolNames(first)).not.toContain("todo");
		for (const request of early) expect(toolNames(request)).not.toContain("todo");
		// At a4bb4e5d the tool is in no request while the calls keep the cache warm.
		expect(toolNames(atBound)).toContain("todo");
	}, 60_000);

	it("sends a personality change in the system prompt of the first request made five minutes after the change, and not before", async () => {
		const rebuilt = await requestOnChangedSettings("personality: pragmatic\n", ["read"]);
		const { first, early, atBound } = await changeUnderWarmCache(
			"personality: default\n",
			"personality: pragmatic\n",
			["read"],
		);
		expect(withoutCacheControl(rebuilt.system)).not.toBe(withoutCacheControl(first.system));

		for (const request of early) expect(withoutCacheControl(request.system)).toBe(withoutCacheControl(first.system));
		// At a4bb4e5d the old personality goes out for as long as the calls keep the cache warm.
		expect(withoutCacheControl(atBound.system)).toBe(withoutCacheControl(rebuilt.system));
	}, 60_000);

	it("sends an edit-mode change in the first request made five minutes after the change", async () => {
		const rebuilt = await requestOnChangedSettings("edit:\n  mode: replace\n", ["read", "edit"]);
		const { first, atBound } = await changeUnderWarmCache("edit:\n  mode: hashline\n", "edit:\n  mode: replace\n", [
			"read",
			"edit",
		]);
		expect(withoutCacheControl(rebuilt.tools)).not.toBe(withoutCacheControl(first.tools));

		// Only the bound is asserted. The edit mode renders into the tool definitions alone (the system prompt does
		// not name it), and at a4bb4e5d the edit and read tools render them from the live setting, so they change at
		// the first request after the change whatever is held (agent-session-settings-hold-live-tool-schema.test.ts).
		expect(withoutCacheControl(atBound.tools)).toBe(withoutCacheControl(rebuilt.tools));
	}, 60_000);

	it("sends a held change at the first request after the cache entry lapses, when that comes before five minutes", async () => {
		const changed = "todo:\n  enabled: true\npersonality: pragmatic\n";
		const rebuilt = await requestOnChangedSettings(changed, ["read", "todo"]);
		const clock = startClock();
		const harness = await startSession("todo:\n  enabled: false\n", ["read", "todo"]);
		await harness.session.prompt("first");
		const entry = harness.session.observedPromptCacheEntry();
		if (!entry || entry.change !== undefined) throw new Error("Expected the first reply's live cache entry");
		const lapsesAt = entry.touchedAt + (entry.ttlMs ?? (entry.tier === "long" ? HOUR_MS : 5 * MINUTE_MS));

		// The change comes two minutes before the entry lapses; the next request, a minute after the lapse, is made
		// three minutes after the change.
		clock.advance(lapsesAt - 2 * MINUTE_MS - clock.now());
		await reloadOverlay(harness, `${OVERLAY}${changed}`);
		clock.advance(3 * MINUTE_MS);
		await harness.session.prompt("after the lapse");

		const [first, afterLapse] = harness.requests;
		if (!first || !afterLapse) throw new Error("Expected the requests around the lapse");
		expect(toolNames(first)).not.toContain("todo");
		expect(toolNames(afterLapse)).toContain("todo");
		expect(withoutCacheControl(afterLapse.system)).toBe(withoutCacheControl(rebuilt.system));
	}, 60_000);
});
