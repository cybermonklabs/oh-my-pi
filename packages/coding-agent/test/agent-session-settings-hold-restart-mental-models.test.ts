/**
 * A resumed transcript starts from the prompt its newest reply was sent with while its cache entry is warm, and a
 * settings change the earlier process held waits on that prompt's notices. Under Hindsight with mental models on, the
 * resumed process installs its Hindsight state after its own startup build and loads the bank's mental models in the
 * background; the load rebuilds the system prompt when it finishes. That rebuild renders the startup build with the
 * mental models the stored prompt carries already: it must not send the held change in place of the stored prompt.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The Hindsight server the settings name; the `fetch` spy answers it, so no request leaves the process. */
const HINDSIGHT_URL = "http://127.0.0.1:1";

/** The one mental model the bank holds; a load renders it into the system prompt. */
const MENTAL_MODEL = "Deploys of bank alpha go out from host alpha-7.";

/**
 * A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, Hindsight on one
 * shared bank with mental models loaded at start and no recall, retain or seeding, and `personality`.
 */
function overlayWith(personality: "default" | "pragmatic"): string {
	return `providers:\n  cacheRetention: long\nmemory:\n  backend: hindsight\nhindsight:\n  apiUrl: ${HINDSIGHT_URL}\n  bankId: alpha\n  scoping: global\n  autoRecall: false\n  autoRetain: false\n  mentalModelsEnabled: true\n  mentalModelAutoSeed: false\npersonality: ${personality}\n`;
}

describe("a held settings change across a restart, under Hindsight with mental models", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from `overlay`: lets the
	 * Hindsight state load its mental models, runs `steps` on the session, then exits. Returns the requests and the
	 * session file.
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
		const requests: MessagesRequest[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = new URL(String(input));
				if (url.href === `${GATEWAY}/v1/messages`) {
					requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
					return answer(requests.length, { cacheWriteTokens: 100 });
				}
				if (url.origin !== HINDSIGHT_URL) throw new Error(`Unexpected request to ${url.href}`);
				const method = init?.method ?? "GET";
				const bank = /^\/v1\/default\/banks\/([^/]+)(\/mental-models)?$/.exec(url.pathname);
				if (!bank) throw new Error(`Unexpected Hindsight call ${method} ${url.pathname}`);
				const bankId = decodeURIComponent(bank[1]);
				if (method === "PUT" && !bank[2]) return Response.json({ bank_id: bankId });
				if (method === "GET" && bank[2]) {
					return Response.json({
						items: [{ id: "deploys", bank_id: bankId, name: "Deploys", content: MENTAL_MODEL }],
					});
				}
				throw new Error(`Unexpected Hindsight call ${method} ${url.pathname}`);
			}),
		);
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
			await session.settleMemoryBackend();
			await session.getHindsightSessionState()?.mentalModelsLoadPromise;
			await steps(session, settings, overlayPath);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			fetchSpy.mockRestore();
		}
	}

	it("sends the stored prompt again after the restart, with the mental models it carries", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-restart-mental-models-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());

		// The first process answers once, holds a personality change and tells the model of it at its second request,
		// then exits with the change still held.
		const live = await runProcess(dir, overlayWith("default"), undefined, async (session, settings, overlay) => {
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, overlayWith("pragmatic"), RELOAD_CALLS);
			await session.prompt("second");
		});
		// The session is resumed at once, its cache entry warm, on the settings the first process ended with.
		const resumed = await runProcess(dir, overlayWith("pragmatic"), live.sessionFile, async session => {
			await session.prompt("third");
		});

		const [first, second] = live.requests;
		const [third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Preconditions: the prompt was bound with the bank's mental model; the personality change was held and its
		// notice went out with the second request; the resumed process renders the mental model too.
		expect(withoutCacheControl(first.system)).toContain(MENTAL_MODEL);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`personality`");
		expect(withoutCacheControl(third.system)).toContain(MENTAL_MODEL);

		// The resumed request continues the transcript's cached prompt, as it does with mental models off.
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);
});
