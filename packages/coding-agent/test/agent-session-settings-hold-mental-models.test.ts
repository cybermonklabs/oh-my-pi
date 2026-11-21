/**
 * A memory setting changed on a bound prompt is held: the system prompt and tool definitions stay as sent until a cut
 * the cut rule admits, a lapsed cache entry or five minutes on. A `memory.backend` switch to Hindsight, or a
 * `hindsight.*` edit that moves its bank, installs a Hindsight state at once, and with `hindsight.mentalModelsEnabled`
 * the state loads the bank's mental models in the background and rebuilds the system prompt when the load finishes.
 * That rebuild belongs to the held change: it must not send the held rebuild before it is due, or the next request
 * rewrites the whole cached prompt.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The Hindsight server the settings name; the `fetch` spy answers it, so no request leaves the process. */
const HINDSIGHT_URL = "http://127.0.0.1:1";

/** Hindsight on one shared bank `bankId`, with mental models loaded at start and no recall, retain or seeding. */
function hindsightSettings(bankId: string): string {
	return `hindsight:\n  apiUrl: ${HINDSIGHT_URL}\n  bankId: ${bankId}\n  scoping: global\n  autoRecall: false\n  autoRetain: false\n  mentalModelsEnabled: true\n  mentalModelAutoSeed: false\n`;
}

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, `backend`. */
function overlayWith(backend: "off" | "hindsight", bankId: string): string {
	return `providers:\n  cacheRetention: long\nmemory:\n  backend: ${backend}\n${hindsightSettings(bankId)}`;
}

/** The one mental model the bank `bankId` holds; a load renders it into the system prompt. */
function mentalModelOf(bankId: string): string {
	return `Deploys of bank ${bankId} go out from host alpha-7.`;
}

const MINUTE_MS = 60_000;

interface Harness {
	session: AgentSession;
	settings: Settings;
	overlay: string;
	/** Each `/v1/messages` request body, oldest first. */
	requests: MessagesRequest[];
	/** Lets the Hindsight server answer the mental-model listings it holds until now. */
	releaseMentalModels(): void;
	/** Makes the Hindsight server hold the mental-model listings asked for from now on, until released. */
	holdMentalModels(): void;
}

describe("a held memory setting whose Hindsight state loads mental models after the change", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A clock `Date.now` reads, moved by the test. */
	function startClock(): { advance(ms: number): void } {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		return {
			advance: ms => {
				now += ms;
			},
		};
	}

	/**
	 * A session on the gateway's claude-opus-5-5 whose settings load `overlay` as a `--config` file. The `fetch` spy is
	 * the gateway and a Hindsight server whose bank `id` holds {@link mentalModelOf}(`id`); it holds the listings until
	 * `releaseMentalModels` is called.
	 */
	async function startSession(overlay: string): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-hold-mental-models-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const requests: MessagesRequest[] = [];
		let listings = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
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
					await listings.promise;
					return Response.json({
						items: [{ id: "deploys", bank_id: bankId, name: "Deploys", content: mentalModelOf(bankId) }],
					});
				}
				throw new Error(`Unexpected Hindsight call ${method} ${url.pathname}`);
			}),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return {
			session,
			settings,
			overlay: overlayPath,
			requests,
			releaseMentalModels: () => listings.resolve(),
			holdMentalModels: () => {
				listings = Promise.withResolvers<void>();
			},
		};
	}

	/**
	 * Reloads `harness`'s overlay as `overlay` and lets the mental-model load of the Hindsight state the change
	 * installed finish; its snapshot is that of the bank `bankId`.
	 */
	async function changeAndLoad(harness: Harness, overlay: string, bankId: string): Promise<void> {
		const before = harness.session.getHindsightSessionState();
		harness.holdMentalModels();
		await reloadOverlay(harness, overlay, ["refreshBaseSystemPrompt", "holdToolDeclarationChange"]);
		await harness.session.settleMemoryBackend();
		const state = harness.session.getHindsightSessionState();
		if (!state?.mentalModelsLoadPromise || state === before) {
			throw new Error("Expected the change to install a Hindsight state that loads mental models");
		}
		harness.releaseMentalModels();
		await state.mentalModelsLoadPromise;
		// Precondition: the load finished in time and rendered the bank's mental model.
		expect(state.mentalModelsSnippet).toContain(mentalModelOf(bankId));
	}

	/**
	 * Sends a request a minute after the change `harness` made half a minute after its first one, and another six
	 * minutes after it; gives the three requests.
	 */
	async function requestsAroundTheHold(
		harness: Harness,
		clock: { advance(ms: number): void },
	): Promise<[MessagesRequest, MessagesRequest, MessagesRequest]> {
		clock.advance(MINUTE_MS);
		await harness.session.prompt("a minute after the change");
		clock.advance(5 * MINUTE_MS);
		await harness.session.prompt("six minutes after the change");
		const [first, early, due] = harness.requests;
		if (!first || !early || !due) throw new Error("Expected the three requests");
		return [first, early, due];
	}

	it("keeps the bound prompt and tools under five minutes after a switch to Hindsight, and sends its mental models with the held rebuild", async () => {
		const clock = startClock();
		const harness = await startSession(overlayWith("off", "alpha"));
		await harness.session.prompt("first");
		clock.advance(30_000);
		await changeAndLoad(harness, overlayWith("hindsight", "alpha"), "alpha");
		const [first, early, due] = await requestsAroundTheHold(harness, clock);

		expect(withoutCacheControl(early.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(early.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(due.system)).toContain(mentalModelOf("alpha"));
	}, 30_000);

	it("keeps the bound prompt under five minutes after a bank edit, and sends the new bank's mental models with the held rebuild", async () => {
		const clock = startClock();
		const harness = await startSession(overlayWith("hindsight", "alpha"));
		harness.releaseMentalModels();
		await harness.session.getHindsightSessionState()?.mentalModelsLoadPromise;
		await harness.session.prompt("first");
		clock.advance(30_000);
		await changeAndLoad(harness, overlayWith("hindsight", "beta"), "beta");
		const [first, early, due] = await requestsAroundTheHold(harness, clock);

		// Precondition: the prompt was bound with the first bank's mental models.
		expect(withoutCacheControl(first.system)).toContain(mentalModelOf("alpha"));
		expect(withoutCacheControl(early.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(early.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(due.system)).toContain(mentalModelOf("beta"));
	}, 30_000);

	it("rebuilds the prompt with the mental models at once when the switch comes before the prompt binds", async () => {
		const harness = await startSession(overlayWith("off", "alpha"));
		await changeAndLoad(harness, overlayWith("hindsight", "alpha"), "alpha");
		await harness.session.prompt("first");

		const [first] = harness.requests;
		if (!first) throw new Error("Expected the first request");
		expect(withoutCacheControl(first.system)).toContain(mentalModelOf("alpha"));
	}, 30_000);
});
