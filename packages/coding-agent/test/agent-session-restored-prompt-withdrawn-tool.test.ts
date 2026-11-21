/**
 * The `tool-definitions-digest` entry is meant to name the tool definitions a request declared as the wire carries
 * them. On the Anthropic wire a tool taken off the roster stays declared (the request re-declares it byte for byte),
 * so withdrawing one changes nothing the cache reads. This case checks that a resumed process still reads the
 * transcript's cache entry, and so keeps the held prompt, after the previous process withdrew a tool.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** One-hour cache entries, so a restart a minute later still reads the entry the transcript left. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

const MINUTE_MS = 60_000;

describe("a resumed transcript whose previous process withdrew a tool the wire still declares", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** One process on `sessionFile` (a new session without one) with `tools`, its settings loaded from the overlay. */
	async function runProcess(
		dir: TempDir,
		sessionFile: string | undefined,
		tools: string[],
		steps: (step: { session: AgentSession; settings: Settings; overlay: string }) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
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
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: tools,
			contextFiles: [],
			skills: [],
		});
		try {
			await steps({ session, settings, overlay });
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	it("keeps the held prompt at the first request after a restart", async () => {
		const dir = TempDir.createSync("@pi-restored-prompt-withdrawn-tool-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(dir.join("overlay.yml"), `${LONG_ENTRIES}personality: default\n`);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const live = await runProcess(dir, undefined, ["read", "bash"], async ({ session, settings, overlay }) => {
			await session.prompt("first");
			// The tool leaves the roster; the bound prompt keeps its bytes and the request still declares it.
			await session.setActiveToolsByName(["read"]);
			now += MINUTE_MS;
			await session.prompt("second");
			// A personality change is held on the bound prompt for up to five minutes.
			now += MINUTE_MS;
			await reloadOverlay({ session, settings, overlay }, `${LONG_ENTRIES}personality: pragmatic\n`, [
				"refreshBaseSystemPrompt",
				"reconcileBuiltinTools",
			]);
			now += MINUTE_MS;
			await session.prompt("third");
		});
		const [first] = live.requests;
		const last = live.requests.at(-1);
		if (!first || !last) throw new Error("Expected the first process's requests");
		// Preconditions: withdrawing the tool left every declaration and the prompt as sent.
		expect(withoutCacheControl(last.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(last.system)).toBe(withoutCacheControl(first.system));

		// A minute later, well inside the hold's five minutes and the one-hour entry.
		now += MINUTE_MS;
		const resumed = await runProcess(dir, live.sessionFile, ["read", "bash"], async ({ session }) => {
			await session.prompt("after the restart");
		});
		const [afterRestart] = resumed.requests;
		if (!afterRestart) throw new Error("Expected the resumed process's request");
		// The resumed process declares the same tools, byte for byte: the transcript's cache entry is readable.
		expect(withoutCacheControl(afterRestart.tools)).toBe(withoutCacheControl(last.tools));
		// It is read only while the held prompt goes out again; the head releases it as if the tools had changed.
		expect(withoutCacheControl(afterRestart.system)).toBe(withoutCacheControl(last.system));
		expect(continuesCachedPrompt(last, afterRestart)).toBe(true);
	}, 60_000);

	it("writes the cached prompt once when the resumed process no longer has the withdrawn tool", async () => {
		const dir = TempDir.createSync("@pi-restored-prompt-withdrawn-tool-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(dir.join("overlay.yml"), LONG_ENTRIES);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		const live = await runProcess(dir, undefined, ["read", "bash"], async ({ session }) => {
			await session.prompt("first");
			await session.setActiveToolsByName(["read"]);
			now += MINUTE_MS;
			await session.prompt("second");
		});
		// The next process starts without the tool; it sends a prompt every minute, which keeps the one-hour entry warm.
		const resumed = await runProcess(dir, live.sessionFile, ["read"], async ({ session }) => {
			for (let minute = 1; minute <= 6; minute++) {
				now += MINUTE_MS;
				await session.prompt(`a call at minute ${minute}`);
			}
		});

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		// Precondition: the resumed process declares other tools, so its first request reads none of the entry.
		expect(withoutCacheControl(first.tools)).not.toBe(withoutCacheControl(last.tools));
		// Requests whose tool definitions or system prompt differ from the request before them: each one writes the
		// whole cached conversation.
		let previous = last;
		let rewrites = 0;
		for (const request of resumed.requests) {
			if (
				withoutCacheControl([request.tools, request.system]) !==
				withoutCacheControl([previous.tools, previous.system])
			) {
				rewrites++;
			}
			previous = request;
		}
		expect(rewrites).toBe(1);
	}, 60_000);
});
