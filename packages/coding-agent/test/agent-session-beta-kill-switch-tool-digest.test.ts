/**
 * Claude Code's `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` kill switch withholds `strict` (and the other beta tool
 * fields) from the tool definitions an `anthropic` request declares. A process that resumes a transcript with the
 * switch turned on or off since sends other tool bytes than the transcript's last request did, so that request reads
 * none of the cache entry: the prompt cache status must say the tools changed, and the resumed process must send its
 * own system prompt from its first request instead of keeping the transcript's for a cache entry it cannot read.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
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

const KILL_SWITCH = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";

const MINUTE_MS = 60_000;

/** The real clock, read before any test moves it. */
const realNow = Date.now.bind(Date);

/** Moves the clock `offsetMs` ahead of real time from now on. */
function setClock(offsetMs: number): void {
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
}

/**
 * One process on the gateway's claude-opus-5-5 with `read` and `edit` (a tool the provider declares as strict), with
 * the kill switch set if `killSwitch`, on `sessionFile` or a new session, `agentsMd` as its context file.
 */
async function runProcess(
	tempDir: TempDir,
	inputs: { agentsMd: string; killSwitch: boolean },
	sessionFile: string | undefined,
	steps: (session: AgentSession) => Promise<void>,
): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
	const previous = process.env[KILL_SWITCH];
	if (inputs.killSwitch) process.env[KILL_SWITCH] = "1";
	else delete process.env[KILL_SWITCH];
	const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	const authStorage = createInMemoryAuthStorage();
	try {
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
			toolNames: ["read", "edit"],
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
		}
	} finally {
		authStorage.close();
		restore();
		if (previous === undefined) delete process.env[KILL_SWITCH];
		else process.env[KILL_SWITCH] = previous;
	}
}

describe("a resumed transcript whose process turned Claude Code's experimental-beta kill switch on", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{ killSwitch: true, state: "cold", sameTools: false },
		{ killSwitch: false, state: "warm", sameTools: true },
	])(
		"reports the cache $state on resume with the switch set: $killSwitch",
		async ({ killSwitch, state, sameTools }) => {
			using tempDir = TempDir.createSync("@pi-beta-kill-switch-tool-digest-");
			await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
			const inputs = { agentsMd: "Build with make.", killSwitch: false };
			const live = await runProcess(tempDir, inputs, undefined, async session => {
				await session.prompt("first");
			});
			let status: PromptCacheStatus | undefined;
			const resumed = await runProcess(tempDir, { ...inputs, killSwitch }, live.sessionFile, async session => {
				status = session.getPromptCacheStatus();
				await session.prompt("second");
			});
			const last = live.requests.at(-1);
			const [first] = resumed.requests;
			if (!last || !first) throw new Error("Expected both processes' requests");
			// Precondition: the switch, and nothing else, changes the tool bytes the resumed request sends.
			expect(withoutCacheControl(first.tools) === withoutCacheControl(last.tools)).toBe(sameTools);

			expect(status).toMatchObject(killSwitch ? { state, reason: { kind: "tools" } } : { state });
		},
		60_000,
	);

	it("writes the cached prompt once when the resumed process also changed the context file", async () => {
		using tempDir = TempDir.createSync("@pi-beta-kill-switch-tool-digest-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(
			tempDir,
			{ agentsMd: "Build with make.", killSwitch: false },
			undefined,
			async session => {
				await session.prompt("first");
			},
		);
		// The resumed process sends a prompt every minute, which keeps the one-hour entry warm.
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", killSwitch: true },
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
		// Precondition: under the switch the first resumed request sends other tool bytes, so it reads none of the entry.
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
