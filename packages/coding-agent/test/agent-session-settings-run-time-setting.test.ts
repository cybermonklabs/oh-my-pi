import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { __resetShellConfigCacheForTests } from "@oh-my-pi/pi-utils/procmgr";
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
import { restoreEnvValue } from "./helpers/settings-test-state";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** The variables the shell config reads its command prefix from (`procmgr.getShellPrefix`). */
const SHELL_PREFIX_KEYS = ["PI_SHELL_PREFIX", "CLAUDE_CODE_SHELL_PREFIX"] as const;

/** Every call of the session a settings reload may start, so the reload waits for whichever one it starts. */
const ANY_REBUILD: readonly OverlayRebuild[] = [
	"refreshBaseSystemPrompt",
	"reconcileBuiltinTools",
	"refreshSkillsAndCommands",
	"holdToolDeclarationChange",
];

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

// `bash.gitGuard` is read only when a bash call runs (the executor exports `PI_GIT_GUARD` to the shell): neither the
// bash definition nor the system prompt states it. Its change on a bound prompt applies to the next call and leaves
// every byte of the cached prefix as it was sent.
describe("a setting only a running tool call reads, changed on a bound prompt", () => {
	// The case runs without a shell prefix exported by the shell that started the suite: the prefix is prepended to
	// every command line a shell runs. Shell configs are cached with the prefix they were built from, so the cache is
	// dropped on both sides of the case.
	const savedPrefix = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const key of SHELL_PREFIX_KEYS) {
			savedPrefix.set(key, process.env[key]);
			restoreEnvValue(key, undefined);
		}
		__resetShellConfigCacheForTests();
	});
	afterEach(() => {
		for (const key of SHELL_PREFIX_KEYS) restoreEnvValue(key, savedPrefix.get(key));
		__resetShellConfigCacheForTests();
	});
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * A session on the gateway's claude-opus-5-5 whose settings load `overlay` as a `--config` file. `replies` answers
	 * requests by their 1-based number; the rest get text.
	 */
	async function startSession(overlay: string, replies: Record<number, (turn: number) => Response>): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-run-time-");
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

	it("sends the next requests with the system prompt, tool definitions and earlier messages as sent, and runs the next call under the new value", async () => {
		// The first and third requests are answered with a bash call that prints whether the guard is on in its shell.
		const printGuard = (turn: number): Response =>
			toolCallAnswer(turn, "bash", { command: 'echo "guard=$PI_GIT_GUARD"' }, { cacheWriteTokens: 100 });
		const harness = await startSession(`${LONG_ENTRIES}bash:\n  gitGuard: false\n`, { 1: printGuard, 3: printGuard });
		await harness.session.prompt("print whether the git guard is on");
		await reloadOverlay(harness, `${LONG_ENTRIES}bash:\n  gitGuard: true\n`, ANY_REBUILD);
		await harness.session.prompt("print it again");

		const [, beforeChange, afterChange, withResult] = harness.requests;
		if (!beforeChange || !afterChange || !withResult) throw new Error("Expected the requests around the bash calls");
		// Each request after the change sends the one before it in cache order with the same bytes, then only new
		// content.
		for (const [earlier, later] of [
			[beforeChange, afterChange],
			[afterChange, withResult],
		] as const) {
			expect(withoutCacheControl(later.tools)).toBe(withoutCacheControl(earlier.tools));
			expect(withoutCacheControl(later.system)).toBe(withoutCacheControl(earlier.system));
			expect(withoutCacheControl(later.messages.slice(0, earlier.messages.length))).toBe(
				withoutCacheControl(earlier.messages),
			);
		}
		// Each call read the setting as it ran: the guard was off in the first call's shell and on in the second's.
		const beforeOutput = textOf(toolResultOf(beforeChange, "toolu_1")?.content);
		expect(beforeOutput).toContain("guard=");
		expect(beforeOutput).not.toContain("guard=1");
		expect(textOf(toolResultOf(withResult, "toolu_3")?.content)).toContain("guard=1");
	}, 60_000);
});
