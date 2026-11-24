import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

const ROLE = "You review the parser changes of this repository.";

describe("a restored transcript prompt after the session moves to another transcript", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with `agentsMd` as its context file: sends each
	 * prompt, runs `then` (which may send more), then exits.
	 */
	async function runProcess(
		tempDir: TempDir,
		agentsMd: string,
		prompts: string[],
		sessionFile?: string,
		then?: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		try {
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			for (const text of prompts) await session.prompt(text);
			await then?.(session);
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	// The process resumed a transcript last sent with an older AGENTS.md and kept that prompt for the transcript's
	// cache entry. A fresh conversation reads no cache entry: `/new` rebuilds the prompt from the files on disk
	// (issue #9273), and must not inherit the old transcript's stored prompt.
	it("starts a /new conversation from this process's own prompt build", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-new-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, "Build with make.", ["first"]);
		// AGENTS.md was edited while no process ran.
		const resumed = await runProcess(tempDir, "Build with ninja.", [], live.sessionFile, async session => {
			await session.newSession();
			await session.prompt("a new task");
		});

		const system = withoutCacheControl(resumed.requests[0]?.system);
		expect(system).not.toContain("Build with make.");
		expect(system).toContain("Build with ninja.");
	}, 30_000);

	// A session switched to in-process (`/resume` of another transcript) was never sent the first transcript's
	// stored prompt; its requests must not carry it.
	it("does not send the resumed transcript's stored prompt to another session switched to", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-switch-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const first = await runProcess(tempDir, "Build with make.", ["first"]);
		// Another session file, with no reply yet: a session the user started and left.
		const other = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const otherFile = other.getSessionFile();
		if (!otherFile) throw new Error("Expected a persisted session");
		other.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		await other.flush();

		const resumed = await runProcess(tempDir, "Build with ninja.", [], first.sessionFile, async session => {
			await session.switchSession(otherFile);
			await session.prompt("continue the other task");
		});

		const system = withoutCacheControl(resumed.requests[0]?.system);
		expect(system).not.toContain("Build with make.");
		expect(system).toContain("Build with ninja.");
	}, 30_000);
});
