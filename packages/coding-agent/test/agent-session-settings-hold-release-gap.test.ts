/**
 * A prompt sends what the prompt withholds once it is due, then builds its hidden notices, so a held settings change
 * that is not due yet goes out with a notice saying it is held and when it goes out. If the change comes due between
 * that notice and the request (the clock passes the deadline while the request is prepared), the request must still
 * agree with its notice: it keeps the held prompt, and the next one sends the rebuild.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** {@link LONG_ENTRIES} with another `personality`, a change the system prompt renders. */
const PRAGMATIC = `${LONG_ENTRIES}personality: pragmatic\n`;

const MINUTE_MS = 60_000;

describe("a held settings change that comes due while its notice's request is prepared", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("goes out at the next request, not under a notice that says it is held", async () => {
		const dir = TempDir.createSync("@pi-settings-hold-release-gap-");
		cleanups.push(() => dir.remove());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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

		setClock(0);
		await session.prompt("first");
		await reloadOverlay({ session, settings, overlay }, PRAGMATIC, RELOAD_CALLS);
		// The prompt sends nothing it withholds and writes its notice just before the deadline; the clock passes the
		// deadline in the first step of the model call that follows.
		setClock(4.9 * MINUTE_MS);
		const render = SessionMaintenance.prototype.renderArchiveForModel;
		vi.spyOn(SessionMaintenance.prototype, "renderArchiveForModel").mockImplementationOnce(
			function (this: SessionMaintenance, messages) {
				setClock(5.1 * MINUTE_MS);
				return render.call(this, messages);
			},
		);
		await session.prompt("at the deadline");
		setClock(6 * MINUTE_MS);
		await session.prompt("after the deadline");

		const [first, atDeadline, after] = requests;
		if (!first || !atDeadline || !after) throw new Error("Expected three requests");
		// Preconditions: the request at the deadline carries the change's notice, and a later request sends the rebuild.
		expect(textOf(atDeadline.messages.slice(first.messages.length))).toContain("The change is held");
		expect(withoutCacheControl(after.system)).not.toBe(withoutCacheControl(first.system));

		// The prompt the notice says is held is the one the request carries.
		expect(withoutCacheControl(atDeadline.system)).toBe(withoutCacheControl(first.system));
	}, 30_000);
});
