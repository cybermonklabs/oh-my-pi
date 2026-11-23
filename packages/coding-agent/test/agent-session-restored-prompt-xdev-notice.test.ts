/**
 * A resumed process keeps its transcript's stored system prompt while the next request reads that transcript's cache
 * entry. `xd://` devices are not tool definitions, so a device mounted or unmounted between the processes leaves the
 * cache entry readable and the stored prompt is kept, with the device catalog the previous process rendered. The
 * model learns of a mount change on a kept prompt from the hidden `xd://` mount notice. These cases check that the
 * notice compares the mounted devices with what the kept prompt lists, not with what this process's own build would
 * list.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** An extension-style tool with the default load mode: the session mounts it as an `xd://` device. */
const WEATHER: CustomTool = {
	name: "weather_lookup",
	label: "Weather",
	description: "Look up the weather of a city",
	parameters: type({ city: "string" }),
	async execute() {
		return { content: [{ type: "text", text: "sunny" }] };
	},
};

describe("xd:// mount notice on a resumed process's kept transcript prompt", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) with `customTools` registered. */
	async function runProcess(
		tempDir: TempDir,
		sessionFile: string | undefined,
		customTools: CustomTool[],
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string; mounted: string[] }> {
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
			settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
			model,
			// `read` and `write` are the two halves of the xd:// transport.
			toolNames: ["read", "write"],
			customTools,
			contextFiles: [],
			skills: [],
		});
		try {
			const mounted = session.getMountedXdevToolNames();
			await steps(session);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests: gateway.requests, sessionFile: file, mounted };
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}

	it("announces a device a resumed process mounts that the kept prompt does not list", async () => {
		const tempDir = TempDir.createSync("@pi-restored-prompt-xdev-notice-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, [], async session => {
			await session.prompt("First.");
		});
		// The extension that brings the device is installed between the processes.
		const resumed = await runProcess(tempDir, live.sessionFile, [WEATHER], async session => {
			await session.prompt("After the restart.");
		});

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		expect(resumed.mounted).toEqual(["weather_lookup"]);
		// Precondition: the resumed request keeps the transcript's prompt, which lists no such device.
		expect(withoutCacheControl(first.system)).toBe(withoutCacheControl(last.system));
		expect(copiesIn(first.system, "weather_lookup")).toBe(0);
		// The device is mounted and callable, so the model must be told of it, as a mount on a kept prompt is.
		expect(copiesIn(first.messages, "- xd://weather_lookup —")).toBe(1);
	}, 30_000);

	it("withdraws a device the kept prompt lists that the resumed process no longer mounts", async () => {
		const tempDir = TempDir.createSync("@pi-restored-prompt-xdev-notice-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, [WEATHER], async session => {
			await session.prompt("First.");
		});
		// The extension that brought the device is removed between the processes.
		const resumed = await runProcess(tempDir, live.sessionFile, [], async session => {
			await session.prompt("After the restart.");
		});

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		expect(live.mounted).toEqual(["weather_lookup"]);
		expect(resumed.mounted).toEqual([]);
		// Precondition: the resumed request keeps the transcript's prompt, which still lists the device.
		expect(withoutCacheControl(first.system)).toBe(withoutCacheControl(last.system));
		expect(copiesIn(first.system, "weather_lookup")).toBeGreaterThan(0);
		// A write to it fails now, so the model must be told it is gone rather than read it in the prompt as mounted.
		expect(copiesIn(first.messages, "Unmounted; writes fail:")).toBe(1);
		expect(copiesIn(first.messages, "- xd://weather_lookup")).toBe(1);
	}, 30_000);
});
