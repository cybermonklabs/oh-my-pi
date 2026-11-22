/**
 * While the base prompt withholds a change from the model (a settings change held on a bound prompt, or a resumed
 * transcript's stored prompt kept in place of the process's own build), a tool taken off the roster is frozen out of
 * the prompt: the prompt keeps its bytes, the provider keeps declaring the tool, and the roster notice tells the model.
 * A later rebuild that brings nothing of its own (a memory backend's refresh, a `skill://` miss that finds no new
 * skill) renders the frozen roster too; it must leave the prompt as sent, not send the withheld change early.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay with one-hour cache entries and `personality`. */
function overlayWith(personality: "default" | "pragmatic"): string {
	return `providers:\n  cacheRetention: long\npersonality: ${personality}\n`;
}

/** Takes `bash` off the roster as plan mode does: a tool-set apply that is no forced rebuild. */
function dropBash(session: AgentSession): Promise<void> {
	return session.setActiveToolPresentation(
		session.getEnabledToolNames().filter(name => name !== "bash"),
		session.getMountedXdevToolNames(),
	);
}

describe("a roster change frozen while the base prompt withholds a change", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from an overlay with
	 * `overlay` and `agentsMd` as its context file: runs `steps`, then exits.
	 */
	async function runProcess(
		dir: TempDir,
		overlay: string,
		agentsMd: string,
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
			toolNames: ["read", "bash"],
			contextFiles: [{ path: dir.join("AGENTS.md"), content: agentsMd }],
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

	it("keeps a held settings change held through a rebuild that brings nothing of its own", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-frozen-roster-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const { requests } = await runProcess(
			dir,
			overlayWith("default"),
			"Build with make.",
			undefined,
			async (session, settings, overlay) => {
				await session.prompt("first");
				await reloadOverlay({ session, settings, overlay }, overlayWith("pragmatic"));
				await dropBash(session);
				await session.refreshBaseSystemPrompt();
				await session.prompt("second");
			},
		);

		const [first, second] = requests;
		if (!first || !second) throw new Error("Expected two requests");
		// Precondition: the provider keeps declaring the tool taken off the roster.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);

	it("keeps a resumed transcript's stored prompt through a rebuild that brings nothing of its own", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-frozen-roster-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, overlayWith("default"), "Build with make.", undefined, async session => {
			await session.prompt("first");
		});
		// The context file changed while no process ran: the resumed process keeps the stored prompt.
		const resumed = await runProcess(
			dir,
			overlayWith("default"),
			"Build with ninja.",
			live.sessionFile,
			async session => {
				await session.prompt("second");
				await dropBash(session);
				await session.refreshBaseSystemPrompt();
				await session.prompt("third");
			},
		);

		const [first] = live.requests;
		const [second, third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Preconditions: the stored prompt went out after the restart, and the tool taken off stays declared.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(third.tools)).toBe(withoutCacheControl(second.tools));
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);
});
