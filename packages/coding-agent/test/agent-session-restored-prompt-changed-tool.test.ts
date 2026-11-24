import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries, so requests a minute apart keep them warm; `edit.mode` is appended per process. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

const ROLE = "You review the parser changes of this repository.";

const MINUTE_MS = 60_000;

/** The real clock, read before any test moves it. */
const realNow = Date.now.bind(Date);

/** Moves the clock `offsetMs` ahead of real time from now on. */
function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

// A resumed process sends its transcript's stored system prompt in place of its own build only while the next request
// reads the transcript's cache entry. The tool definitions come before the system prompt in cache order: a request
// whose definitions changed reads none of the entry, and the stored prompt then only delays this process's own build,
// whose release five minutes later writes the whole cached conversation a second time.
describe("a resumed transcript whose tool definitions changed while no process ran", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) with `edit.mode` set to `editMode`. */
	async function runProcess(
		tempDir: TempDir,
		inputs: { agentsMd: string; editMode: string },
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, `${OVERLAY}edit:\n  mode: ${inputs.editMode}\n`);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
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
			settings,
			model,
			toolNames: ["read", "edit"],
			appendSystemPrompt: ROLE,
			contextFiles: [{ path: tempDir.join("AGENTS.md"), content: inputs.agentsMd }],
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
			restoreFetch();
		}
	}

	it("writes the cached prompt once when a restart changes a tool definition and the context file", async () => {
		using tempDir = TempDir.createSync("@pi-restored-prompt-changed-tool-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(
			tempDir,
			{ agentsMd: "Build with make.", editMode: "hashline" },
			undefined,
			async session => {
				await session.prompt("first");
			},
		);
		// Between the processes the context file and the edit mode change; the resumed process sends a prompt every
		// minute, which keeps the one-hour entry warm.
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", editMode: "replace" },
			live.sessionFile,
			async session => {
				for (let minute = 0; minute <= 5; minute++) {
					setClock(minute * MINUTE_MS);
					await session.prompt(`a call at minute ${minute}`);
				}
			},
		);

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		// Precondition: the edit tool's definition changed, so the first resumed request reads none of the entry.
		expect(withoutCacheControl(first.tools)).not.toBe(withoutCacheControl(last.tools));
		// Requests whose tool definitions or system prompt, sent in that order before the messages, differ from the
		// request before them: each one writes the whole cached conversation.
		let previous = last;
		let rewrites = 0;
		for (const request of resumed.requests) {
			const sentBefore = withoutCacheControl([previous.tools, previous.system]);
			if (withoutCacheControl([request.tools, request.system]) !== sentBefore) rewrites++;
			previous = request;
		}
		expect(withoutCacheControl(resumed.requests.at(-1)?.system)).toContain("Build with ninja.");
		expect(rewrites).toBe(1);
	}, 60_000);
});
