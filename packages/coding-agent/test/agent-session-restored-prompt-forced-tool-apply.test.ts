/**
 * A resumed process sends the prompt the transcript was last sent with while its cache entry is warm, in place of the
 * process's own build. An extension that registers a tool again with the same definition (a late `session_start`
 * registration, the extension-sources reconcile) applies the same tool set with a forced prompt rebuild; that rebuild
 * renders the process's own build again and changes nothing of its own, so it must keep the stored prompt.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

describe("a forced tool-set apply that changes nothing, under a restored transcript prompt", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	/** One process on the session file (a new session without one) with `agentsMd` as its context file. */
	async function runProcess(
		dir: TempDir,
		agentsMd: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
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
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			toolNames: ["read", "bash"],
			contextFiles: [{ path: dir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			await steps(session);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("keeps the stored prompt through an extension's same-definition re-registration", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-forced-apply-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, "Build with make.", undefined, async session => {
			await session.prompt("first");
		});
		// The context file changed while no process ran; the resumed process's extension re-registers a tool with the
		// definition it had, which applies the unchanged tool set with a forced prompt rebuild.
		const resumed = await runProcess(dir, "Build with ninja.", live.sessionFile, async session => {
			await session.setActiveToolPresentation(
				session.getEnabledToolNames(),
				session.getMountedXdevToolNames(),
				true,
			);
			await session.prompt("second");
		});

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		expect(withoutCacheControl(second.system)).toContain("Build with make.");
		expect(continuesCachedPrompt(first, second)).toBe(true);
	}, 60_000);
});
