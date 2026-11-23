import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getTestModel } from "./helpers/model-fixtures";
import { assistantMsg, userMsg } from "./utilities";

/**
 * An `openai` model with the default compaction method order compacts remotely first (OpenAI's
 * `/responses/compact` or V2 streaming compaction), sending the whole history. While the session's
 * `cyber_policy` hold stands, a compaction that keeps the hold (one with no origin: idle, overflow, `/loop`,
 * an extension's own `ctx.compact()`) sends nothing to OpenAI. Synthetic responses only.
 */
describe("remote compaction during a cyber_policy hold", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-remote-compaction-cyber-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	async function createSession() {
		const model = getTestModel(
			"openai",
			candidate =>
				candidate.api === "openai-responses" &&
				candidate.input.includes("text") &&
				(candidate.contextWindow ?? 0) > 0 &&
				compactionModule.shouldUseProviderNativeCompaction(candidate, {
					remoteEnabled: true,
					remoteStreamingV2Enabled: true,
				}),
		);
		// The default method order, with nothing configured.
		const settings = Settings.isolated({
			"compaction.autoContinue": false,
			"compaction.keepRecentTokens": 1,
			"contextPromotion.enabled": false,
		});
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime(model.provider, "openai-token");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
		const live = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		live.subscribe(() => {});
		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			live.agent.appendMessage(user);
			live.sessionManager.appendMessage(user);
			live.agent.appendMessage(assistant);
			live.sessionManager.appendMessage(assistant);
		}
		session = live;
		return { live, model };
	}

	it.each([
		["sends nothing to OpenAI for a compaction with no origin while the hold stands", true],
		["sends the remote compaction when no hold stands (control)", false],
	])("%s", async (_label, refused) => {
		const { live, model } = await createSession();
		const requested: string[] = [];
		const fetchMock: FetchImpl = async input => {
			requested.push(input instanceof Request ? input.url : input.toString());
			// An ordinary rejection that no path retries, so the control ends without a backoff.
			return Response.json(
				{ error: { message: "Invalid request.", type: "invalid_request_error", code: "invalid_value" } },
				{ status: 400, statusText: "Bad Request" },
			);
		};
		// The real compaction, with the test's fetch for every request it makes.
		const originalCompact = compactionModule.compact;
		vi.spyOn(compactionModule, "compact").mockImplementation(
			(preparation, compactionModel, apiKey, customInstructions, signal, options) =>
				originalCompact(preparation, compactionModel, apiKey, customInstructions, signal, {
					...options,
					fetch: fetchMock,
				}),
		);
		if (refused) live.cyberPolicyClosure.record();

		await live.compact().catch(() => {});

		if (refused) {
			expect(live.cyberPolicyClosure.isClosed(model)).toBe(true);
			expect(requested).toEqual([]);
		} else {
			expect(requested.length).toBeGreaterThan(0);
			expect(requested.every(url => url.startsWith(new URL(model.baseUrl).origin))).toBe(true);
		}
	});
});
