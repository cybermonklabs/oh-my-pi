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
	textOf,
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
}

/** The tool result a request carries for the call `toolUseId`. */
function toolResultOf(request: MessagesRequest | undefined, toolUseId: string): Record<string, unknown> | undefined {
	return request?.messages
		.flatMap(message => (Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []))
		.find(block => block.type === "tool_result" && block.tool_use_id === toolUseId);
}

// One configuration sync changes two settings the bash definition renders: `async.enabled` (a held rebuild) and
// `tools.maxTimeout`, which the definition renders only inside the async paragraph. With async off, putting the
// timeout back alone changes nothing the live definition renders, so the hold does not keep it, although the kept
// definition still states the deadline it gave.
describe("a held change whose setting renders only beside another held setting", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	async function startSession(overlay: string, replies: Record<number, (turn: number) => Response>): Promise<Harness> {
		const dir = TempDir.createSync("@pi-declhold-masked-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests } = mockGatewayFetch(turn => replies[turn]?.(turn) ?? answer(turn, { cacheWriteTokens: 100 }));
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
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay: overlayPath };
	}

	/** Rewrites the overlay and reloads it as the config watcher does, then waits for each hold the change starts. */
	async function reload(harness: Harness, content: string): Promise<void> {
		const spies = [
			vi.spyOn(harness.session, "refreshBaseSystemPrompt"),
			vi.spyOn(harness.session, "reconcileBuiltinTools"),
			vi.spyOn(harness.session, "holdToolDeclarationChange"),
		];
		await Bun.write(harness.overlay, content);
		await harness.settings.reloadFromDisk();
		await Promise.resolve();
		await Promise.all(spies.flatMap(spy => spy.mock.results.map(result => result.value)));
		for (const spy of spies) spy.mockRestore();
	}

	it("runs a bash call under the deadline the kept bash definition states", async () => {
		// The second request is answered with a two-second command and no `timeout`: the kept definition says an
		// omitted timeout is 300 seconds.
		const harness = await startSession(LONG_ENTRIES, {
			2: turn => toolCallAnswer(turn, "bash", { command: "sleep 2; echo finished" }, { cacheWriteTokens: 100 }),
		});
		await harness.session.prompt("first");
		await reload(harness, `${LONG_ENTRIES}async:\n  enabled: false\ntools:\n  maxTimeout: 1\n`);
		await harness.session.prompt("run the slow command");

		const [first, second, third] = harness.requests;
		if (!first || !second || !third) throw new Error("Expected the requests around the bash call");
		// Precondition: the change is held, so bash went out as it was sent before it, deadline included.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(second.tools)).toContain("(default 300s)");
		const result = toolResultOf(third, "toolu_2");
		// Run under the live one-second ceiling the hold left out, the call is cut off and clamped.
		expect(textOf(result?.content)).not.toContain("Timeout clamped");
		expect(result?.is_error).not.toBe(true);
		expect(textOf(result?.content)).toContain("finished");
	}, 60_000);
});
