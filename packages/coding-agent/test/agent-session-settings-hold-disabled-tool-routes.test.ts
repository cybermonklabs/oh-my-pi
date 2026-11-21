import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CursorExecHandlers } from "@oh-my-pi/pi-coding-agent/cursor";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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

/** Every call that is not read-only asks the user first. */
const ALWAYS_ASK = "tools:\n  approvalMode: always-ask\n";

/** Both eval backends switched off, which withdraws `eval`. */
const EVAL_OFF = `${LONG_ENTRIES}eval:\n  py: false\n  js: false\n`;

/** What a call to the held `recall` device is refused with. */
const RECALL_REFUSED = "`recall` is disabled by a settings change";

/** What the test does once the switch is held, and how the gateway answers. */
interface HeldSwitchRun {
	/** The tools the session is created with; the default set when undefined. */
	toolNames?: string[];
	/** The UI that answers approval prompts; without it the session has none. */
	ui?: ExtensionUIContext;
	/** The gateway's reply to its `turn`th request. */
	reply(turn: number): Response;
	/** Runs once the switch is held. */
	run(session: AgentSession): Promise<void>;
}

describe("a tool a held settings change disables, reached other than by a direct call", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * A session whose overlay holds `before`, switched to `after` once the first request was answered, then `run`.
	 * Returns the requests.
	 */
	async function withHeldSwitch(
		before: string,
		after: string,
		{ toolNames, ui, reply, run }: HeldSwitchRun,
	): Promise<MessagesRequest[]> {
		using dir = TempDir.createSync("@pi-settings-hold-disabled-tool-routes-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, before);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests } = mockGatewayFetch(reply);
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
			if (ui) {
				await initializeExtensions(session, {
					reportSendError: () => {},
					reportRuntimeError: () => {},
					uiContext: ui,
				});
			}
			await session.settleMemoryBackend();
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, after, RELOAD_CALLS);
			await session.settleMemoryBackend();
			await run(session);
		} finally {
			await session.dispose();
			authStorage.close();
		}
		const first = requests[0];
		const last = requests.at(-1);
		if (!first || !last || last === first) throw new Error("Expected requests after the switch");
		// Precondition: the switch is held, the prompt and tool definitions kept as sent.
		expect(withoutCacheControl(last.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(last.tools)).toBe(withoutCacheControl(first.tools));
		return requests;
	}

	/**
	 * {@link withHeldSwitch} whose second request is answered with `call` (a tool name and its arguments). Returns the
	 * requests.
	 */
	async function switchThenCall(
		before: string,
		after: string,
		toolNames: string[] | undefined,
		call: [name: string, args: Record<string, unknown>],
		ui?: ExtensionUIContext,
	): Promise<MessagesRequest[]> {
		const requests = await withHeldSwitch(before, after, {
			toolNames,
			ui,
			reply: turn =>
				turn === 2
					? toolCallAnswer(turn, ...call, { cacheWriteTokens: 100 })
					: answer(turn, { cacheWriteTokens: 100 }),
			run: async session => {
				await session.prompt("go on");
			},
		});
		if (requests.length < 3) throw new Error("Expected the requests around the call");
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
		expect(result).toContain(RECALL_REFUSED);
	}, 60_000);

	it("answers a read of one of its `xd://` doc topics with the reason a call to it is refused", async () => {
		const requests = await switchThenCall(
			LONG_ENTRIES,
			EVAL_OFF,
			["read", "eval"],
			["read", { path: "xd://eval/helpers" }],
		);
		const [first, , withResult] = requests;
		// Precondition: the tool list the held switch keeps offers `eval`.
		expect(first?.tools?.map(tool => tool.name)).toContain("eval");

		const result = textOf(toolResultOf(withResult, "toolu_2")?.content);
		expect(result).toContain("`eval` is disabled by a settings change");
	}, 60_000);

	// The model may call a device by its bare name or its URL; the loop resolves either to the device.
	it.each(["recall", "xd://recall"])(
		"refuses a call named `%s` with the reason a direct call gets",
		async name => {
			const requests = await switchThenCall(MNEMOPI_ON, MNEMOPI_OFF, undefined, [name, { query: "deploy host" }]);

			const result = textOf(toolResultOf(requests[2], "toolu_2")?.content);
			expect(result).toContain(RECALL_REFUSED);
		},
		60_000,
	);

	it("leaves it out of the `xd://` listing and out of the count the listing gives", async () => {
		const requests = await switchThenCall(MNEMOPI_ON, MNEMOPI_OFF, undefined, ["read", { path: "xd://" }]);

		const result = textOf(toolResultOf(requests[2], "toolu_2")?.content);
		const count = result.match(/xd:\/\/ (\d+) mounted tool devices\./)?.[1];
		const listed = result.split("\n").filter(line => /^xd:\/\/\w+ /.test(line));
		expect(listed.map(line => line.split(" ")[0])).not.toContain("xd://recall");
		expect(count).toBe(String(listed.length));
	}, 60_000);

	it("leaves it out of the devices a read of an unknown device names", async () => {
		const requests = await switchThenCall(MNEMOPI_ON, MNEMOPI_OFF, undefined, ["read", { path: "xd://remember" }]);

		const result = textOf(toolResultOf(requests[2], "toolu_2")?.content);
		const mounted = result.match(/No such tool: xd:\/\/remember\. Mounted devices: ([^.]*)\./)?.[1];
		if (mounted === undefined) throw new Error(`Expected the unknown-device answer, got: ${result}`);
		expect(mounted.split(", ")).not.toContain("recall");
		expect(mounted.split(", ")).not.toContain("retain");
	}, 60_000);

	it("does not suggest it for a mistyped call", async () => {
		const requests = await switchThenCall(MNEMOPI_ON, MNEMOPI_OFF, undefined, [
			"memory_recall",
			{ query: "deploy host" },
		]);

		const result = textOf(toolResultOf(requests[2], "toolu_2")?.content);
		expect(result).toContain("Tool memory_recall not found");
		// A held device refuses every call, so naming it only leads the model to a refusal.
		expect(result.replaceAll("memory_recall", "")).not.toContain("recall");
	}, 60_000);

	it("refuses a Cursor bridge call to it with the reason a direct call gets", async () => {
		let result: ToolResultMessage | undefined;
		await withHeldSwitch(MNEMOPI_ON, MNEMOPI_OFF, {
			reply: turn => answer(turn, { cacheWriteTokens: 100 }),
			run: async session => {
				// Each provider call gets the session's Cursor exec bridge, through which Cursor's MCP frames call tools.
				const stream = vi.spyOn(session.agent, "streamFn");
				await session.prompt("go on");
				const handlers = stream.mock.calls[0]?.[2]?.cursorExecHandlers as CursorExecHandlers | undefined;
				if (!handlers) throw new Error("Expected the session's Cursor exec bridge");
				result = await handlers.mcp({
					name: "recall",
					providerIdentifier: "pi-agent",
					toolName: "recall",
					toolCallId: "call-recall",
					args: { query: "deploy host" },
					rawArgs: {},
				});
			},
		});

		expect(result?.isError).toBe(true);
		expect(textOf(result?.content)).toContain(RECALL_REFUSED);
	}, 60_000);

	it("refuses a write to it without asking the user to approve the call first", async () => {
		const asked: string[] = [];
		const ui = {
			select: async (title: string) => {
				asked.push(title);
				return "Approve";
			},
			notify: () => {},
		} as unknown as ExtensionUIContext;
		const requests = await switchThenCall(
			`${MNEMOPI_ON}${ALWAYS_ASK}`,
			`${MNEMOPI_OFF}${ALWAYS_ASK}`,
			undefined,
			["write", { path: "xd://recall", content: JSON.stringify({ query: "deploy host" }) }],
			ui,
		);

		const result = textOf(toolResultOf(requests[2], "toolu_2")?.content);
		expect(result).toContain(RECALL_REFUSED);
		// A call that can only be refused is no question for the user.
		expect(asked).toEqual([]);
	}, 60_000);
});
