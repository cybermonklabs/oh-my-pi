import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	toolResultOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries, so the requests keep the prompt warm. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Auto-learn under the local memory backend, which offers the `learn` tool. */
const LEARNING = `${LONG_ENTRIES}autolearn:\n  enabled: true\nmemory:\n  backend: local\n`;

/** {@link LEARNING} with memory switched off, which withdraws `learn`. */
const LEARNING_OFF = `${LONG_ENTRIES}autolearn:\n  enabled: true\nmemory:\n  backend: off\n`;

/** Mnemopi kept quiet (no embeddings, no model calls), its memory tools mounted as `xd://` devices. */
const MNEMOPI_ON = `${LONG_ENTRIES}mnemopi:\n  noEmbeddings: true\n  llmMode: none\n  autoRecall: false\n  autoRetain: false\nmemory:\n  backend: mnemopi\n`;

/** {@link MNEMOPI_ON} with memory switched off, which withdraws the memory devices. */
const MNEMOPI_OFF = MNEMOPI_ON.replace("backend: mnemopi", "backend: off");

describe("a tool a held memory switch disables, reached other than by a direct call", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * A session whose overlay holds `before`, switched to `after` once the first request was answered; the second
	 * request is answered with `call` (a tool name and its arguments). Returns the requests.
	 */
	async function switchThenCall(
		before: string,
		after: string,
		toolNames: string[] | undefined,
		call: [name: string, args: Record<string, unknown>],
	): Promise<MessagesRequest[]> {
		using dir = TempDir.createSync("@pi-settings-hold-disabled-tool-routes-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, before);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests } = mockGatewayFetch(turn =>
			turn === 2
				? toolCallAnswer(turn, ...call, { cacheWriteTokens: 100 })
				: answer(turn, { cacheWriteTokens: 100 }),
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
			toolNames,
			contextFiles: [],
			skills: [],
		});
		try {
			await session.settleMemoryBackend();
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, after, RELOAD_CALLS);
			await session.settleMemoryBackend();
			await session.prompt("go on");
		} finally {
			await session.dispose();
			authStorage.close();
		}
		const [first, withCall, withResult] = requests;
		if (!first || !withCall || !withResult) throw new Error("Expected the requests around the call");
		// Precondition: the switch is held, the prompt and tool definitions kept as sent.
		expect(withoutCacheControl(withResult.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(withResult.tools)).toBe(withoutCacheControl(first.tools));
		return requests;
	}

	it("refuses an eval cell's call to it with the reason a direct call gets", async () => {
		const requests = await switchThenCall(
			LEARNING,
			LEARNING_OFF,
			["read", "eval"],
			["eval", { language: "js", code: 'await tool.learn({ memory: "The deploy host is alpha-7." });' }],
		);
		const [first, , withResult] = requests;
		// Precondition: the eval description and the tool list offered `learn`.
		expect(first?.tools?.map(tool => tool.name)).toContain("learn");

		const result = textOf(toolResultOf(withResult, "toolu_2")?.content);
		expect(result).toContain("`learn` is disabled by a settings change");
	}, 60_000);

	it("answers a read of its `xd://` docs with the reason a call to it is refused", async () => {
		const requests = await switchThenCall(MNEMOPI_ON, MNEMOPI_OFF, undefined, ["read", { path: "xd://recall" }]);
		const [first, , withResult] = requests;
		// Precondition: the system prompt the held switch keeps lists the device.
		expect(withoutCacheControl(first?.system)).toContain("xd://recall");

		const result = textOf(toolResultOf(withResult, "toolu_2")?.content);
		expect(result).toContain("`recall` is disabled by a settings change");
	}, 60_000);
});
