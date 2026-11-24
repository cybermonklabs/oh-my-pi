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

/** The `--config` overlay a configuration sync rewrites under a running session; compaction keeps one message. */
const OVERLAY = "providers:\n  cacheRetention: long\ncompaction:\n  keepRecentTokens: 1\n";

const HOUR_MS = 60 * 60_000;

/** Every text a wire value carries: text blocks, string contents and nested tool results. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.content].map(textOf).join("\n");
}

interface ProcessStep {
	session: AgentSession;
	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuild it starts. */
	reload(content: string): Promise<void>;
}

describe("a settings change held on a bound prompt, across a restart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from the overlay: sends each
	 * prompt (after `beforePrompt` for its index), then exits. Returns the requests and the session file.
	 */
	async function runProcess(
		tempDir: TempDir,
		prompts: string[],
		sessionFile?: string,
		beforePrompt?: (index: number, step: ProcessStep) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = tempDir.join("overlay.yml");
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
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		const step: ProcessStep = {
			session,
			reload: async content => {
				const rebuild = vi.spyOn(session, "refreshBaseSystemPrompt");
				await Bun.write(overlay, content);
				await settings.reloadFromDisk();
				// The settings listeners run in the microtask the reload queued for them.
				await Promise.resolve();
				await Promise.all(rebuild.mock.results.map(result => result.value));
				rebuild.mockRestore();
			},
		};
		try {
			for (const [index, text] of prompts.entries()) {
				await beforePrompt?.(index, step);
				await session.prompt(text);
			}
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restoreFetch();
		}
	}

	/**
	 * A first process whose personality changes under the bound prompt: the rebuild is held, and the second request
	 * keeps the prompt and carries the notice. Returns its first request, the session file and what a session on the
	 * changed settings sends (the prompt the held rebuild would commit).
	 */
	async function heldChangeThenExit(
		tempDir: TempDir,
	): Promise<{ first: MessagesRequest; sessionFile: string; rebuiltSystem: string }> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		await Bun.write(tempDir.join("overlay.yml"), OVERLAY);
		const live = await runProcess(tempDir, ["first", "second"], undefined, async (index, { reload }) => {
			if (index === 1) await reload(`${OVERLAY}personality: pragmatic\n`);
		});
		const [first, second] = live.requests;
		if (!first || !second) throw new Error("Expected the first process's two requests");
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`personality`");
		const fresh = await runProcess(tempDir, ["a fresh session"]);
		const rebuilt = fresh.requests[0];
		if (!rebuilt) throw new Error("Expected the fresh session's request");
		expect(withoutCacheControl(rebuilt.system)).not.toBe(withoutCacheControl(first.system));
		return { first, sessionFile: live.sessionFile, rebuiltSystem: withoutCacheControl(rebuilt.system) };
	}

	it("sends the rebuilt prompt after a restart once the held prompt's cache entry lapsed", async () => {
		using tempDir = TempDir.createSync("@pi-settings-hold-resume-");
		const { first, sessionFile, rebuiltSystem } = await heldChangeThenExit(tempDir);

		// The session is resumed the next day: the one-hour entry is long gone.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * HOUR_MS);
		const resumed = await runProcess(tempDir, ["third"], sessionFile);
		const third = resumed.requests[0];
		if (!third) throw new Error("Expected the resumed process's request");

		// In the first process the held rebuild runs at the first request after the lapse. The resumed process sends
		// the old personality's prompt again, with nothing left that would ever release it.
		expect(withoutCacheControl(third.system)).not.toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(third.system)).toBe(rebuiltSystem);
	}, 60_000);

	it("tells the model of the change after a restart and a compaction that summarized its notice away", async () => {
		using tempDir = TempDir.createSync("@pi-settings-hold-resume-");
		const { sessionFile, rebuiltSystem } = await heldChangeThenExit(tempDir);

		// Resumed while the entry is warm; then a compaction rewrites every message, which in the first process
		// would have run the held rebuild.
		const resumed = await runProcess(tempDir, ["third", "after the compaction"], sessionFile, async (index, step) => {
			if (index === 1) await step.session.compact();
		});
		const afterCompaction = resumed.requests.at(-1);
		if (!afterCompaction) throw new Error("Expected the request after the compaction");
		// Precondition: the compaction summarized the turn that carried the notice.
		expect(textOf(afterCompaction.messages)).not.toContain("second");

		const sentSystem = withoutCacheControl(afterCompaction.system);
		const told = {
			rebuilt: sentSystem === rebuiltSystem,
			noticed: textOf(afterCompaction.messages).includes("`personality`"),
		};
		// Neither holds at the head: the model answers under the old personality and nothing in its context names
		// the change; in one process the compaction would have run the held rebuild.
		expect(told).not.toEqual({ rebuilt: false, noticed: false });
	}, 60_000);
});
