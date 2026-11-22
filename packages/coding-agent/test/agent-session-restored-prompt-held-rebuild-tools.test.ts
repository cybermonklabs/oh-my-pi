/**
 * A process held an extension suspend (its tool, an `xd://` device, refused) and exited before the held rebuild. A
 * process that resumes the session while the cache entry is warm keeps the stored prompt, and its settings notices go
 * on from what the earlier process's notices told. A settings change in that process starts a held rebuild on the kept
 * prompt: its notice names what changed since, and must not reverse what the earlier notices told while it still
 * holds (the suspended extension's tool does not run here).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	editExtensionSources,
	RELOAD_CALLS,
	reloadOverlay,
	setClock,
} from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
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

describe("a held rebuild started on a kept restored prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with the project's extensions discovered and its
	 * settings loaded from an overlay starting as `initial`: runs `steps` with an `edit` that rewrites the overlay and
	 * waits for the extension reconcile, then exits.
	 */
	async function runProcess(
		dir: TempDir,
		initial: string,
		sessionFile: string | undefined,
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
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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

	it("keeps the earlier process's refused tool refused in its notice", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-held-rebuild-tools-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(path.join(getProjectAgentDir(dir.path()), "extensions", "guard.ts"), GUARD_EXTENSION);
		setClock(0);
		const live = await runProcess(dir, LONG_ENTRIES, undefined, async (session, edit) => {
			await session.prompt("first");
			await edit(GUARD_DISABLED);
			setClock(MINUTE_MS);
			await session.prompt("after the suspend");
		});
		// The pod restarts with the extension disabled; a configuration sync then changes `personality`.
		setClock(2 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			GUARD_DISABLED,
			live.sessionFile,
			async (session, _edit, overlay, settings) => {
				await reloadOverlay(
					{ session, settings, overlay },
					`${GUARD_DISABLED}personality: pragmatic\n`,
					RELOAD_CALLS,
				);
				await session.prompt("after the resume");
			},
		);

		const [first, suspendTold] = live.requests;
		const [resumedRequest] = resumed.requests;
		if (!first || !suspendTold || !resumedRequest) throw new Error("Expected the two processes' requests");
		// Preconditions: the earlier process told the model the tool's calls are refused, and the resumed process
		// keeps the stored prompt and holds the personality change on it.
		expect(textOf(suspendTold.messages.slice(first.messages.length))).toContain(
			"calls to them are refused from now on: `guard_audit`",
		);
		expect(withoutCacheControl(resumedRequest.system)).toBe(withoutCacheControl(first.system));
		const told = textOf(resumedRequest.messages.slice(suspendTold.messages.length));
		expect(told).toContain("`personality`");
		// The tool does not run here: nothing says its calls run again.
		expect(told).not.toContain("run again");
	}, 60_000);
});
