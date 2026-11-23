/**
 * A tool a held settings change disables is refused until the rebuild, and the refusal names the change. One reload
 * can change several settings at once (a configuration sync): the refusal names each of them that moved the refused
 * tool's gate and no other, so the model is not sent after a change that has nothing to do with the tool. Where two
 * of them each moved a gate the tool needs, it names both and says the tool is disabled by one of them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	toolResultOf,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

const MINUTE_MS = 60_000;

/** One session whose overlay a sync rewrites after the first reply, and the call the next reply makes. */
interface RefusedCall {
	/** The overlay the session starts with, then the one the sync writes. */
	initial: string;
	synced: string;
	/** The tools the session lists; the refused one among them. */
	toolNames: string[];
	/** The call the reply after the sync makes. */
	tool: string;
	input: Record<string, unknown>;
	options?: Partial<CreateAgentSessionOptions>;
}

/** Runs the session and gives the refusal the call got, once the request that made it still declared the tool. */
async function refusalOf({ initial, synced, toolNames, tool, input, options }: RefusedCall): Promise<string> {
	using dir = TempDir.createSync("@pi-settings-hold-refusal-batch-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, initial);
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
	const gateway = mockGatewayFetch(turn =>
		turn === 2
			? toolCallAnswer(turn, tool, input, { cacheWriteTokens: 100 })
			: answer(turn, { cacheWriteTokens: 100 }),
	);
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const { session } = await createAgentSession({
		...gatewaySessionOptions(dir),
		...options,
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
		setClock(0);
		await session.prompt("first");
		await reloadOverlay({ session, settings, overlay }, synced, RELOAD_CALLS);
		setClock(MINUTE_MS);
		await session.prompt("call the tool");
	} finally {
		await session.dispose();
		authStorage.close();
		gateway.restore();
	}

	const [first, called, withResult] = gateway.requests;
	if (!first || !called || !withResult) throw new Error("Expected three requests");
	// Precondition: the held change keeps the tool declared.
	expect(called.tools?.map(declared => declared.name)).toContain(tool);
	const refusal = textOf(toolResultOf(withResult, "toolu_2")?.content);
	expect(refusal).toContain(`\`${tool}\` is disabled by a settings change`);
	return refusal;
}

describe("a held tool refusal of a sync that changed several settings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the gate that took the tool away, not a gate changed beside it", async () => {
		// `github` was never listed: its gate moved no tool, the refused one least of all.
		const refusal = await refusalOf({
			initial: `${LONG_ENTRIES}github:\n  enabled: true\n`,
			synced: `${LONG_ENTRIES}github:\n  enabled: false\nlsp:\n  enabled: false\n`,
			toolNames: ["read", "lsp"],
			tool: "lsp",
			input: { action: "status" },
			options: { enableLsp: true },
		});
		expect(refusal).toContain("`lsp.enabled`: `true` → `false`");
		expect(refusal).not.toContain("github.enabled");
		expect(refusal).not.toContain("one of these changes");
	}, 30_000);

	it("says the tool is disabled by one of two changes that each moved a gate it needs", async () => {
		// `wait` stays while background jobs or `launch` are on: the sync turns both off.
		const refusal = await refusalOf({
			initial: LONG_ENTRIES,
			synced: `${LONG_ENTRIES}async:\n  enabled: false\nlaunch:\n  enabled: false\n`,
			toolNames: ["read", "wait"],
			tool: "wait",
			input: {},
			options: { enableIrc: false },
		});
		expect(refusal).toContain("one of these changes");
		expect(refusal).toContain("`async.enabled`: `true` → `false`");
		expect(refusal).toContain("`launch.enabled`: `true` → `false`");
	}, 30_000);

	it("names the tool's gate, not a setting whose listener found the tool gone", async () => {
		// The model-role listener reconciles the tools too, with the whole sync applied and its own change alone.
		const roles = "modelRoles:\n  default: anthropic/claude-opus-5-5\n";
		const refusal = await refusalOf({
			initial: `${LONG_ENTRIES}${roles}todo:\n  enabled: true\n`,
			synced: `${LONG_ENTRIES}${roles}  smol: anthropic/claude-opus-5-5\ntodo:\n  enabled: false\n`,
			toolNames: ["read", "todo"],
			tool: "todo",
			input: { op: "append", items: ["check"] },
		});
		expect(refusal).not.toContain("modelRoles");
		expect(refusal).toContain("`todo.enabled`: `true` → `false`");
		expect(refusal).not.toContain("one of these changes");
	}, 30_000);
});
