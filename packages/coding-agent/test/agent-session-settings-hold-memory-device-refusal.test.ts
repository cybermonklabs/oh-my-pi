import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
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

/** Overlay lines that keep Mnemopi in the process, up to an open `mnemopi:` block, with one-hour cache entries. */
const QUIET_MNEMOPI =
	"providers:\n  cacheRetention: long\nmnemopi:\n  noEmbeddings: true\n  llmMode: none\n  autoRecall: false\n  autoRetain: false\n";

/** Mnemopi on: its memory tools are mounted as `xd://` devices, as `tools.xdev` (on by default) mounts them. */
const MNEMOPI_ON = `${QUIET_MNEMOPI}memory:\n  backend: mnemopi\n`;

/** {@link MNEMOPI_ON} with memory switched off, which withdraws the memory tools. */
const MEMORY_OFF = `${QUIET_MNEMOPI}memory:\n  backend: off\n`;

/** The calls of the session a memory switch may start. */
const RELOAD_CALLS: readonly OverlayRebuild[] = [
	"refreshBaseSystemPrompt",
	"reconcileBuiltinTools",
	"holdToolDeclarationChange",
];

/** The tool result a request carries for the call `toolUseId`. */
function toolResultOf(request: MessagesRequest | undefined, toolUseId: string): Record<string, unknown> | undefined {
	return request?.messages
		.flatMap(message => (Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : []))
		.find(block => block.type === "tool_result" && block.tool_use_id === toolUseId);
}

describe("a memory device a held backend switch disables", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("refuses a call to it with the reason the settings notice gives", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-memory-device-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, MNEMOPI_ON);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		// The second request is answered with a call to the `recall` device.
		const { requests } = mockGatewayFetch(turn =>
			turn === 2
				? toolCallAnswer(
						turn,
						"write",
						{ path: "xd://recall", content: JSON.stringify({ query: "deploy host" }) },
						{ cacheWriteTokens: 100 },
					)
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
			contextFiles: [],
			skills: [],
		});
		try {
			await session.settleMemoryBackend();
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, RELOAD_CALLS);
			await session.settleMemoryBackend();
			await session.prompt("recall the deploy host");
		} finally {
			await session.dispose();
			authStorage.close();
		}

		const [first, withCall, withResult] = requests;
		if (!first || !withCall || !withResult) throw new Error("Expected the requests around the device call");
		// Preconditions: the switch is held (the prompt is kept and the system prompt lists `xd://recall`), and the
		// notice told the model that calls to `recall` are refused.
		expect(withoutCacheControl(withResult.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(first.system)).toContain("xd://recall");
		expect(textOf(withCall.messages.slice(first.messages.length))).toContain(
			"calls to them are refused from now on: `retain`, `recall`",
		);

		// The call is refused with "No such tool: xd://recall", next to a device list that still names `recall`,
		// instead of the held reason a top-level call to the tool gets.
		const result = textOf(toolResultOf(withResult, "toolu_2")?.content);
		expect(result).toContain("`recall` is disabled by a settings change");
	}, 60_000);
});
