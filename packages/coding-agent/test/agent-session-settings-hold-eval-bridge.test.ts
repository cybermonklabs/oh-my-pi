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
	toolCallAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The rebuilds a reload of these sessions' overlay starts. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshBaseSystemPrompt", "reconcileBuiltinTools"];

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	dir: TempDir;
}

describe("a tool an eval cell calls while a settings change is held on a bound prompt", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A session on the gateway's claude-opus-5-5 whose settings load `overlay`; `replies` answers by request number. */
	async function startSession(
		overlay: string,
		tools: string[],
		replies: Record<number, (turn: number) => Response>,
	): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-hold-eval-bridge-");
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
			toolNames: tools,
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay: overlayPath, dir };
	}

	it("runs an edit an eval cell shapes by the edit definition the hold keeps as that definition says", async () => {
		// The model answers the second request with an eval cell that edits in the `replace` shape the requests
		// still declare for the edit tool.
		const harness = await startSession(`${LONG_ENTRIES}edit:\n  mode: replace\n`, ["read", "edit", "eval"], {
			2: turn =>
				toolCallAnswer(
					turn,
					"eval",
					{
						language: "js",
						code: 'await tool.edit({ path: "notes.txt", old_string: "alpha", new_string: "beta" });',
					},
					{ cacheWriteTokens: 100 },
				),
		});
		await Bun.write(harness.dir.join("notes.txt"), "alpha\n");
		await harness.session.prompt("first");
		await reloadOverlay(harness, `${LONG_ENTRIES}edit:\n  mode: hashline\n`, RELOAD_REBUILDS);
		await harness.session.prompt("replace alpha with beta in notes.txt from an eval cell");

		const [first, second, third] = harness.requests;
		if (!first || !second || !third) throw new Error("Expected the requests around the eval call");
		// Precondition: the edit tool went out with the definition it had before the change, the only edit shape
		// the model is offered until the rebuild.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		const result = third.messages
			.flatMap(message =>
				Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
			)
			.find(block => block.type === "tool_result" && block.tool_use_id === "toolu_2");
		// A bridged call checked and run in the live mode fails: the cell has no edit shape that works until the rebuild.
		expect(result?.is_error).not.toBe(true);
		expect(await Bun.file(harness.dir.join("notes.txt")).text()).toBe("beta\n");
	}, 60_000);
});
