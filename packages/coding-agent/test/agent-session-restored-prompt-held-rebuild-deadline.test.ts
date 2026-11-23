/**
 * A process held an extension suspend and exited before the held rebuild; its settings notice told the model when the
 * rebuild comes at the latest. A process that resumes the session while the cache entry is warm keeps the stored
 * prompt, and sends its own build once that change is five minutes old. A settings change in that process starts a
 * held rebuild on the kept prompt. Its notice tells the model when the rebuild comes: it must not name a later time
 * than the one at which the kept prompt goes out.
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

/** The time a settings notice in `text` gives as the latest the held rebuild comes. */
function rebuildBy(text: string): string | undefined {
	return /at the first request made at (\S+) or later/.exec(text)?.[1];
}

describe("the deadline of a held rebuild started on a kept restored prompt", () => {
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

	it("names no later time than the one the kept prompt goes out at", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-held-rebuild-deadline-");
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
		setClock(3 * MINUTE_MS);
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
				setClock(3.5 * MINUTE_MS);
				await session.prompt("after the change");
				// Past five minutes from the suspend, before five minutes from the `personality` change.
				setClock(5.5 * MINUTE_MS);
				await session.prompt("later");
			},
		);

		const [first, suspendTold] = live.requests;
		const [changeTold, later] = resumed.requests;
		if (!first || !suspendTold || !changeTold || !later) throw new Error("Expected the two processes' requests");
		const toldFirst = rebuildBy(textOf(suspendTold.messages.slice(first.messages.length)));
		const told = textOf(changeTold.messages.slice(suspendTold.messages.length));
		// Preconditions: the earlier process told the model when its rebuild comes; the resumed process keeps the
		// stored prompt and holds the `personality` change on it; the kept prompt goes out five minutes after the
		// suspend, at the request made at five and a half minutes.
		expect(toldFirst).toBeDefined();
		expect(withoutCacheControl(changeTold.system)).toBe(withoutCacheControl(first.system));
		expect(told).toContain("`personality`");
		expect(withoutCacheControl(later.system)).not.toBe(withoutCacheControl(changeTold.system));

		// The rebuild comes when the earlier process's notice said: the notice of the change held on the kept prompt
		// gives that time, not five minutes after its own change.
		expect(rebuildBy(told)).toBe(toldFirst);
	}, 60_000);
});
