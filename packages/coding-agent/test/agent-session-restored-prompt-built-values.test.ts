/**
 * The session file stores each prompt a prefix-bound model was sent with together with the settings its build read,
 * so a resumed process that sends it again names, for a change it holds, the value that prompt was built with, in the
 * hidden settings notice and in the session's records of the hold, not the value this process started with. A stored
 * prompt recorded without them behaves as before, and a credential is stored by its id alone.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	personalityOverlay,
	RELOAD_CALLS,
	reloadOverlay,
} from "./helpers/agent-session-setup";
import {
	answer,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The custom entries of `customType` a session file holds, by their data. */
function customEntries(sessionFile: string, customType: string): Record<string, unknown>[] {
	const entries = Bun.JSONL.parse(fs.readFileSync(sessionFile, "utf8")) as Record<string, unknown>[];
	return entries.flatMap(entry =>
		entry.type === "custom" && entry.customType === customType ? [entry.data as Record<string, unknown>] : [],
	);
}

describe("a resumed process that keeps the stored prompt and holds a change", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), its settings loaded from an overlay with
	 * `personality`: runs `steps`, then exits.
	 */
	async function runProcess(
		dir: TempDir,
		personality: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings, overlay: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, personalityOverlay(personality));
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
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await steps(session, settings, overlay);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	/**
	 * The prompt is built under `default`; the configuration moves to `pragmatic` while no process runs; the resumed
	 * process keeps the stored prompt, and a configuration sync moves `personality` to `friendly`. `prepare` may edit
	 * the session file between the processes. Returns what the resumed request told and the hold's settings records.
	 */
	async function setForward(prepare: (sessionFile: string) => void): Promise<{ told: string; held: unknown[] }> {
		using dir = TempDir.createSync("@pi-restored-prompt-built-values-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, "default", undefined, async session => {
			await session.prompt("first");
		});
		prepare(live.sessionFile);
		const resumed = await runProcess(dir, "pragmatic", live.sessionFile, async (session, settings, overlay) => {
			await reloadOverlay({ session, settings, overlay }, personalityOverlay("friendly"), RELOAD_CALLS);
			await session.prompt("second");
		});
		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		// Precondition: the resumed request sends the stored prompt, built under `default`.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		return {
			told: textOf(second.messages.slice(first.messages.length)),
			held: customEntries(resumed.sessionFile, "system-prompt-held-settings").flatMap(data =>
				Array.isArray(data.settings) ? data.settings : [],
			),
		};
	}

	it("names the value the stored prompt was built with, in the notice and the records", async () => {
		const { told, held } = await setForward(() => {});
		expect(told).toContain('`personality`: `"default"` → `"friendly"`');
		expect(told).not.toContain('`"pragmatic"`');
		expect(held).toContainEqual({ id: "personality", value: "default" });
		expect(JSON.stringify(held)).not.toContain("pragmatic");
	}, 60_000);

	it("names the value this process started with when the stored prompt has no record of its reads", async () => {
		const { told, held } = await setForward(sessionFile => {
			const lines = Bun.JSONL.parse(fs.readFileSync(sessionFile, "utf8")) as Record<string, unknown>[];
			for (const entry of lines) {
				if (entry.type === "custom" && entry.customType === "system-prompt") {
					delete (entry.data as Record<string, unknown>).settingsRead;
				}
			}
			fs.writeFileSync(sessionFile, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		});
		expect(told).toContain('`personality`: `"pragmatic"` → `"friendly"`');
		expect(held).toContainEqual({ id: "personality", value: "pragmatic" });
	}, 60_000);
});

describe("the stored prompt's record of its build's reads", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names a credential the build read by its id alone", async () => {
		using dir = TempDir.createSync("@pi-stored-prompt-credential-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const token = "hs-token-7f3e9c1d2b";
		const overlay = dir.join("memory.yml");
		await Bun.write(
			overlay,
			`providers:\n  cacheRetention: long\nmemory:\n  backend: hindsight\nhindsight:\n  apiUrl: http://127.0.0.1:1\n  apiToken: ${token}\n  bankId: fleet-bank\n  mentalModelsEnabled: false\n`,
		);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const requests: MessagesRequest[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = new URL(String(input));
				if (url.href === `${GATEWAY}/v1/messages`) {
					requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
					return answer(requests.length, { cacheWriteTokens: 100 });
				}
				if (url.pathname.endsWith("/memories/recall")) return Response.json({ results: [] });
				const bank = /^\/v1\/default\/banks\/([^/]+)$/.exec(url.pathname);
				if (bank) return Response.json({ bank_id: decodeURIComponent(bank[1]) });
				return Response.json({});
			}),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = SessionManager.create(dir.path(), dir.join("sessions"));
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
			await session.prompt("first");
		} finally {
			await session.dispose();
			authStorage.close();
		}
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");

		const [stored] = customEntries(sessionFile, "system-prompt");
		if (!stored) throw new Error("Expected a stored prompt");
		// The build read the credential, and its record names it by id alone.
		expect(stored.settingsRead).toContainEqual({ id: "hindsight.apiToken" });
		expect(fs.readFileSync(sessionFile, "utf8")).not.toContain(token);
	}, 60_000);
});
