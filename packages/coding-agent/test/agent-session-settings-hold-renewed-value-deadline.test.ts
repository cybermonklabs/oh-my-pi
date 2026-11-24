/**
 * A `personality` change on a bound prompt is held, and its hidden settings notice tells the model when it goes out.
 * The setting is set back, and the process exits before any request carries a notice of that. A process that resumes
 * the session once the change is five minutes old sends its own build, which is the transcript's prompt, so the prompt
 * stays bound; the configuration then sets `personality` to the value the earlier notice told, and that change is
 * held. Its first request keeps the prompt without it, so the model must be told when it goes out: the newest time a
 * settings notice in the request gives must not have passed already.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	personalityOverlay,
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

const MINUTE_MS = 60_000;

/** The times the settings notices in `text` say their change goes out at, in order. */
function toldDeadlines(text: string): number[] {
	return [...text.matchAll(/at the first request made at (\S+) or later/g)].map(match => Date.parse(match[1] ?? ""));
}

describe("a held change to the value an ended hold's notice told", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from an overlay with
	 * `overlay`: runs `steps` on the session, then exits. Returns the requests and the session file.
	 */
	async function runProcess(
		dir: TempDir,
		overlay: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings, overlayPath: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(restore);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await steps(session, settings, overlayPath);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("tells the model when the new hold goes out", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-renewed-value-deadline-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const before = await runProcess(
			dir,
			personalityOverlay("default"),
			undefined,
			async (session, settings, overlay) => {
				setClock(0);
				await session.prompt("first");
				await reloadOverlay({ session, settings, overlay }, personalityOverlay("pragmatic"), RELOAD_CALLS);
				setClock(MINUTE_MS);
				await session.prompt("after the change");
				setClock(2 * MINUTE_MS);
				await reloadOverlay({ session, settings, overlay }, personalityOverlay("default"), RELOAD_CALLS);
			},
		);
		setClock(7 * MINUTE_MS);
		let sentAt = 0;
		const resumed = await runProcess(
			dir,
			personalityOverlay("default"),
			before.sessionFile,
			async (session, settings, overlay) => {
				await reloadOverlay({ session, settings, overlay }, personalityOverlay("pragmatic"), RELOAD_CALLS);
				setClock(8 * MINUTE_MS);
				sentAt = Date.now();
				await session.prompt("after the restart");
			},
		);

		const [first, changeTold] = before.requests;
		const [afterRestart] = resumed.requests;
		if (!first || !changeTold || !afterRestart) throw new Error("Expected the two processes' requests");
		// Preconditions: the first process told the model the change and when it goes out; the resumed process holds
		// the new change, so its first request sends the transcript's prompt, built without it.
		const firstTold = textOf(changeTold.messages.slice(first.messages.length));
		expect(firstTold).toContain('`personality`: `"default"` → `"pragmatic"`');
		expect(toldDeadlines(firstTold)).toHaveLength(1);
		expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(changeTold.system));
		expect(textOf(afterRestart.system)).not.toContain("Pragmatic, effective senior engineer.");

		// The newest time the model was told the change goes out at is still ahead of the request that holds it.
		const newest = toldDeadlines(textOf(afterRestart.messages)).at(-1) ?? 0;
		expect(newest).toBeGreaterThanOrEqual(sentAt);
	}, 60_000);
});
