/**
 * Memory switched on under a bound prompt is held, and its hidden settings notice tells the model that `learn` comes
 * with the rebuild; five minutes on the rebuild brings it. Memory is switched off again later: that hold's notice tells
 * the model that calls to `learn` are refused, and five minutes on its rebuild takes `learn` away. Every notice told
 * the model what is so once the second rebuild went out, so the requests after it carry no further settings notice.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, gatewaySessionOptions, mockGatewayFetch, textOf } from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries, auto-learn on. */
const LEARNING = "providers:\n  cacheRetention: long\nautolearn:\n  enabled: true\n";

/** {@link LEARNING} under the local memory backend, which offers the `learn` tool. */
const LOCAL_MEMORY = `${LEARNING}memory:\n  backend: local\n`;

/** {@link LEARNING} with memory switched off, which withdraws `learn`. */
const MEMORY_OFF = `${LEARNING}memory:\n  backend: off\n`;

const SETTINGS_NOTICE = '<system-notice id="settings">';

const MINUTE_MS = 60_000;

describe("a memory switch on, released, then a switch off, released", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends no settings notice once both rebuilds went out", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-released-notice-told-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, MEMORY_OFF);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
		let enabledAfterOff: string[] = [];
		try {
			await session.settleMemoryBackend();
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, LOCAL_MEMORY, RELOAD_CALLS);
			await session.settleMemoryBackend();
			setClock(MINUTE_MS);
			await session.prompt("after the switch on");
			setClock(6 * MINUTE_MS);
			await session.prompt("after the switch on went out");
			setClock(7 * MINUTE_MS);
			await reloadOverlay({ session, settings, overlay }, MEMORY_OFF, RELOAD_CALLS);
			await session.settleMemoryBackend();
			setClock(8 * MINUTE_MS);
			await session.prompt("after the switch off");
			setClock(13 * MINUTE_MS);
			await session.prompt("after the switch off went out");
			enabledAfterOff = session.getEnabledToolNames();
			await session.prompt("again");
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}

		const [first, onTold, onOut, offTold, offOut, again] = requests;
		if (!first || !onTold || !onOut || !offTold || !offOut || !again) throw new Error("Expected six requests");
		// Preconditions: the switch on was held and told, its rebuild brought `learn`; the switch off was held and told,
		// its rebuild took `learn` off the enabled tools (the provider keeps declaring a withdrawn tool).
		expect(first.tools?.map(tool => tool.name)).not.toContain("learn");
		expect(textOf(onTold.messages.slice(first.messages.length))).toContain("available after the rebuild: `learn`");
		expect(onOut.tools?.map(tool => tool.name)).toContain("learn");
		expect(textOf(offTold.messages.slice(onOut.messages.length))).toContain(
			"calls to them are refused from now on: `learn`",
		);
		expect(enabledAfterOff).not.toContain("learn");

		// Nothing the notices told is contradicted: no request after the second rebuild adds a settings notice.
		expect(textOf(offOut.messages.slice(offTold.messages.length))).not.toContain(SETTINGS_NOTICE);
		expect(textOf(again.messages.slice(offOut.messages.length))).not.toContain(SETTINGS_NOTICE);
	}, 60_000);
});
