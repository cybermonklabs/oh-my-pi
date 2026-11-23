/**
 * Bash renders its schema from the live `async.enabled` setting, so a configuration reload changes the definition the
 * next request declares without a new tools array. On a model whose thinking does not bind the conversation's prefix
 * nothing holds the change, and it goes out at once. The tool definitions digest recorded for that request must be
 * the one it declared: a process that resumes the transcript under the same settings compares its own digest with the
 * recorded one, and an older one makes it judge the tools changed, drop the cache entry it would read and treat the
 * cache as lapsed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
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

/** The gateway's `models.yml` with Claude Sonnet 4.5, whose thinking does not bind the conversation's prefix. */
const MODELS_YML = gatewayModelsYml().replace(
	"id: claude-opus-5-5, name: Claude Opus 5.5",
	"id: claude-sonnet-4-5, name: Claude Sonnet 4.5",
);

/** A `--config` overlay with one-hour cache entries and `async.enabled` as given. */
function overlay(asyncEnabled: boolean): string {
	return `providers:\n  cacheRetention: long\nasync:\n  enabled: ${asyncEnabled}\n`;
}

interface ProcessRun {
	requests: MessagesRequest[];
	sessionFile: string;
}

describe("a reload that changes a definition a tool renders from live settings, on a model that binds no prefix", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** One process on the gateway's Claude Sonnet 4.5 with `read` and `bash`, under the overlay at `overlayPath`. */
	async function runProcess(
		tempDir: TempDir,
		overlayPath: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings) => Promise<void>,
	): Promise<ProcessRun> {
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		try {
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected the gateway's claude-sonnet-4-5");
			// Precondition: nothing holds a settings change on this model.
			expect(model.thinking?.prefixBinding).not.toBe(true);
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
				toolNames: ["read", "bash"],
				contextFiles: [{ path: tempDir.join("AGENTS.md"), content: "Build with make." }],
				skills: [],
			});
			try {
				await steps(session, settings);
				const file = sessionManager.getSessionFile();
				if (!file) throw new Error("Expected a persisted session");
				return { requests, sessionFile: file };
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
			restore();
		}
	}

	it("records the digest of the definitions it sent, so a resumed process reads the cache entry", async () => {
		using tempDir = TempDir.createSync("@pi-live-tool-schema-digest-");
		await Bun.write(tempDir.join("models.yml"), MODELS_YML);
		const overlayPath = tempDir.join("overlay.yml");
		await Bun.write(overlayPath, overlay(false));
		const live = await runProcess(tempDir, overlayPath, undefined, async (session, settings) => {
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay: overlayPath }, overlay(true));
			await session.prompt("second");
		});
		let status: PromptCacheStatus | undefined;
		const resumed = await runProcess(tempDir, overlayPath, live.sessionFile, async session => {
			status = session.getPromptCacheStatus();
			await session.prompt("third");
		});
		const [before, last] = live.requests;
		const [first] = resumed.requests;
		if (!before || !last || !first) throw new Error("Expected both processes' requests");
		// Preconditions: the reload changed bash's definition at the next request, and the resumed request declares the
		// definitions that request sent.
		const bashOf = (request: MessagesRequest) =>
			withoutCacheControl(request.tools?.find(tool => tool.name === "bash"));
		expect(bashOf(last)).not.toBe(bashOf(before));
		expect(withoutCacheControl(first.tools)).toBe(withoutCacheControl(last.tools));

		expect(status).toMatchObject({ state: "warm" });
	}, 60_000);
});
