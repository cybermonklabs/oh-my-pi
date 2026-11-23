/**
 * A process suspended an extension under a bound prompt, and the held rebuild took its tool, an `xd://` device, off
 * the prompt; it then resumed the extension, held again, and the settings notice told the model that the tool comes
 * with the rebuild. The process exits before that rebuild. A process that resumes the session with the extension
 * enabled keeps the stored prompt, and suspends the extension again: that change is held on the kept prompt, its
 * notice tells the model `disabledExtensions` changed from `[]` and that calls to the tool are refused. The reason a
 * refused call gets must name a change of `disabledExtensions`, not the same value on both sides.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, editExtensionSources, setClock } from "./helpers/agent-session-setup";
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

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** {@link LONG_ENTRIES} with the extension below disabled. */
const GUARD_DISABLED = `${LONG_ENTRIES}disabledExtensions:\n  - extension-module:guard\n`;

/** A project extension with one tool of its own, mounted as an `xd://` device. */
const GUARD_EXTENSION = `export default function (pi) {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "guard_audit",
		label: "Guard audit",
		description: "Lists what the guard refused.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "nothing refused" }] }),
	});
}
`;

const MINUTE_MS = 60_000;

describe("a call refused by a held rebuild started on a kept restored prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with the project's extensions discovered and its
	 * settings loaded from an overlay starting as `initial`: runs `steps` with an `edit` that rewrites the overlay and
	 * waits for the extension reconcile, then exits. Its `callAt`th request is answered with a call of the tool, every
	 * other one with text.
	 */
	async function runProcess(
		dir: TempDir,
		initial: string,
		sessionFile: string | undefined,
		callAt: number | undefined,
		steps: (
			session: AgentSession,
			edit: (content: string) => Promise<void>,
			overlay: string,
			settings: Settings,
		) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, initial);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn =>
			turn === callAt
				? toolCallAnswer(turn, "write", { path: "xd://guard_audit", content: "{}" }, { cacheWriteTokens: 100 })
				: answer(turn, { cacheWriteTokens: 100 }),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			disableExtensionDiscovery: false,
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			// `write` selected: without the extension's device it would otherwise leave the tool definitions.
			toolNames: ["read", "write"],
			contextFiles: [],
			skills: [],
		});
		const edit = (content: string): Promise<void> => editExtensionSources({ session, settings, overlay }, content);
		try {
			await steps(session, edit, overlay, settings);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	it("names a change of the setting in the refusal", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-held-refusal-change-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(path.join(getProjectAgentDir(dir.path()), "extensions", "guard.ts"), GUARD_EXTENSION);
		setClock(0);
		const live = await runProcess(dir, LONG_ENTRIES, undefined, undefined, async (session, edit) => {
			await session.prompt("first");
			await edit(GUARD_DISABLED);
			setClock(MINUTE_MS);
			await session.prompt("after the suspend");
			setClock(6 * MINUTE_MS);
			await session.prompt("after the rebuild");
			await edit(LONG_ENTRIES);
			setClock(7 * MINUTE_MS);
			await session.prompt("after the resume");
		});
		// The pod restarts with the extension enabled; a configuration sync then disables it again.
		setClock(8 * MINUTE_MS);
		const resumed = await runProcess(dir, LONG_ENTRIES, live.sessionFile, 1, async (session, edit) => {
			await edit(GUARD_DISABLED);
			setClock(9 * MINUTE_MS);
			await session.prompt("call the audit");
		});

		const [, , rebuilt, resumeTold] = live.requests;
		const [suspendTold, withResult] = resumed.requests;
		if (!rebuilt || !resumeTold || !suspendTold || !withResult)
			throw new Error("Expected the two processes' requests");
		// Preconditions: the earlier process told the model that the tool comes with the rebuild; the resumed process
		// keeps the stored prompt, holds the suspend on it and tells the model that calls to the tool are refused.
		expect(textOf(resumeTold.messages.slice(rebuilt.messages.length))).toContain(
			"available after the rebuild: `guard_audit`",
		);
		expect(withoutCacheControl(suspendTold.system)).toBe(withoutCacheControl(resumeTold.system));
		const told = textOf(suspendTold.messages.slice(resumeTold.messages.length));
		expect(told).toContain('`disabledExtensions`: `[]` → `["extension-module:guard"]`');
		expect(told).toContain("calls to them are refused from now on: `guard_audit`");
		const refusal = textOf(toolResultOf(withResult, "toolu_1")?.content);
		expect(refusal).toContain("`guard_audit` is disabled by a settings change");

		// The reason names a change of the setting, not the value it has now on both sides.
		expect(refusal).not.toContain('`["extension-module:guard"]` → `["extension-module:guard"]`');
	}, 60_000);
});
