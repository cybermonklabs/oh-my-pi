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

describe("a held settings change on a tool whose definition renders from live settings", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0)) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(tempDir: TempDir, overlayExtra: string): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, `${OVERLAY}${overlayExtra}`);
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
			toolNames: ["read", "edit", "bash", "task"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay };
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

	// `edit.mode` swaps the edit tool's parameter schema and description; `async.enabled` rewrites the bash and
	// task descriptions. Both are getters over live settings, outside the prompt surface a rebuild freezes.
	for (const { setting, before, after } of [
		{ setting: "edit.mode", before: "edit:\n  mode: hashline\n", after: "edit:\n  mode: replace\n" },
		{ setting: "async.enabled", before: "async:\n  enabled: true\n", after: "async:\n  enabled: false\n" },
	]) {
		it(`sends the tool definitions as written while the notice of a held ${setting} change says they stay`, async () => {
			using tempDir = TempDir.createSync("@pi-settings-hold-live-tool-");
			const harness = await startSession(tempDir, before);
			await harness.session.prompt("first");
			await reloadOverlay(harness, `${OVERLAY}${after}`);
			await harness.session.prompt("second");

			const [first, second] = harness.requests;
			if (!first || !second) throw new Error("Expected two requests");
			// The change is held: the second request keeps the system prompt and tells the model the system prompt
			// and tool definitions above stay as written until the next rebuild.
			expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
			expect(textOf(second.messages.slice(first.messages.length))).toContain(`\`${setting}\``);
			// So the tools must go out as written: a changed tool list rewrites the whole cached prompt (tools come
			// first in cache order) under a system prompt the hold kept for nothing, and contradicts the notice.
			const changedTools = (first.tools ?? [])
				.filter((tool, index) => withoutCacheControl(tool) !== withoutCacheControl(second.tools?.[index]))
				.map(tool => tool.name);
			expect(changedTools).toEqual([]);
		}, 30_000);
	}
});
