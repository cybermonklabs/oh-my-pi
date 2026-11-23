import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import * as openaiTransport from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import type { OpenAILiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/openai-transport";
import * as codexTransport from "@oh-my-pi/pi-coding-agent/live/transport";
import type { LiveTransportOptions } from "@oh-my-pi/pi-coding-agent/live/transport";
import { extractVisibleAssistantText } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import { CyberPolicyClosure } from "@oh-my-pi/pi-coding-agent/session/cyber-policy-closure";

/** Transport double: connects at once and records the options it was made with. */
class FakeTransport {
	readonly sdpAnswer = "v=0 answer";
	constructor(readonly options: OpenAILiveTransportOptions | LiveTransportOptions) {}
	async connect(): Promise<void> {}
	async setMuted(): Promise<void> {}
	pushAudio(): void {}
	async send(): Promise<void> {}
	async close(): Promise<void> {}
}

afterEach(() => {
	vi.restoreAllMocks();
});

/** Replaces a transport class export with one that makes {@link FakeTransport}s. */
function fakeTransports(module: object, name: string): FakeTransport[] {
	const made: FakeTransport[] = [];
	const spy = vi.spyOn(module as Record<string, unknown>, name as never) as unknown as {
		mockImplementation(implementation: (options: never) => object): void;
	};
	spy.mockImplementation(function (options: never) {
		const transport = new FakeTransport(options);
		made.push(transport);
		return transport;
	});
	return made;
}

function call(settings: Record<string, unknown>) {
	const openai = fakeTransports(openaiTransport, "OpenAILiveTransport");
	const codex = fakeTransports(codexTransport, "CodexLiveTransport");
	const session = {
		modelRegistry: {
			authStorage: {} as AuthStorage,
			getProviderBaseUrl: () => "https://gateway.example/v1",
			getApiKeyForProvider: async () => "sk-test",
		},
		settings: Settings.isolated(settings),
		sessionId: "s1",
		// The session tree's cyber-policy hold, which the call reads before each send to OpenAI; none stands here.
		cyberPolicyClosure: new CyberPolicyClosure(),
		subscribe: () => () => {},
		sendCustomMessage: async () => false,
	} as unknown as LiveSessionControllerOptions["session"];
	const controller = new LiveSessionController({
		session,
		extractAssistantText: extractVisibleAssistantText,
		sdpOffer: "v=0 offer",
		callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
	});
	return { controller, openai, codex, session };
}

describe("live.provider", () => {
	test("openai calls GPT-Live with the session's model registry, which holds the openai provider's key", async () => {
		const live = call({ "live.provider": "openai" });
		await live.controller.start();
		expect(live.codex).toEqual([]);
		expect(live.openai).toHaveLength(1);
		const options = live.openai[0]!.options as OpenAILiveTransportOptions;
		// The transport resolves the key and base URL itself when it connects (see openai-route.test.ts).
		expect(options.registry).toBe(live.session.modelRegistry);
		expect(options.sessionId).toBe("s1");
		expect(options.sdpOffer).toBe("v=0 offer");
		await live.controller.stop();
	});

	test("control: unset, the call goes to Codex as before", async () => {
		const live = call({});
		await live.controller.start();
		expect(live.openai).toEqual([]);
		expect(live.codex).toHaveLength(1);
		await live.controller.stop();
	});

	test("OMP_LIVE_PROVIDER picks the route when no setting does", async () => {
		const saved = Bun.env.OMP_LIVE_PROVIDER;
		Bun.env.OMP_LIVE_PROVIDER = "openai";
		try {
			const live = call({});
			await live.controller.start();
			expect(live.codex).toEqual([]);
			expect(live.openai).toHaveLength(1);
			await live.controller.stop();
		} finally {
			if (saved === undefined) delete Bun.env.OMP_LIVE_PROVIDER;
			else Bun.env.OMP_LIVE_PROVIDER = saved;
		}
	});
});
