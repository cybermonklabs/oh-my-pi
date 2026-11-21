/**
 * On a model that keeps its tool declaration across a conversation, a tool taken off the roster stays declared beside
 * a tool still on it, so the next request reads the cache entry the last one left. A roster emptied of every tool
 * declares none: the next request's tools differ from the cached ones, and the prompt cache status must say the cache
 * is cold because the tools changed instead of reporting the entry warm.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, gatewaySessionOptions, mockGatewayFetch } from "./helpers/anthropic-gateway";

/**
 * Runs a prompt on the gateway's claude-opus-5-5 with `read` and `debug`, its reply writing the prompt cache, then
 * leaves `roster` on the roster. Returns the prompt cache status before and after, and the next request's tools.
 */
async function statusAfterWithdrawal(
	roster: string[],
): Promise<{ before: PromptCacheStatus | undefined; after: PromptCacheStatus | undefined; nextTools: string[] }> {
	using tempDir = TempDir.createSync("@pi-emptied-roster-cache-status-");
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
	const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const { session } = await createAgentSession({
		...gatewaySessionOptions(tempDir),
		sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({ "providers.cacheRetention": "long" }),
		model,
		toolNames: ["read", "debug"],
		contextFiles: [],
		skills: [],
	});
	try {
		await session.prompt("first");
		const before = session.getPromptCacheStatus();
		await session.setActiveToolsByName(roster);
		const after = session.getPromptCacheStatus();
		await session.prompt("second");
		return { before, after, nextTools: (requests.at(-1)?.tools ?? []).map(tool => tool.name).sort() };
	} finally {
		await session.dispose();
		authStorage.close();
		restore();
	}
}

describe("prompt cache status after a withdrawal on a model that keeps its tool declaration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("turns cold on the tools when the roster is emptied, as the next request declares none", async () => {
		const { before, after, nextTools } = await statusAfterWithdrawal([]);
		// Precondition: the first reply left a warm entry, and the next request declared no tool.
		expect(before?.state).toBe("warm");
		expect(nextTools).toEqual([]);

		expect(after).toMatchObject({ state: "cold", reason: { kind: "tools" } });
	}, 60_000);

	it("stays warm when the withdrawn tool stays declared beside a tool on the roster", async () => {
		const { before, after, nextTools } = await statusAfterWithdrawal(["read"]);
		// Precondition: the first reply left a warm entry, and the next request still declared both tools.
		expect(before?.state).toBe("warm");
		expect(nextTools).toEqual(["debug", "read"]);

		expect(after?.state).toBe("warm");
	}, 60_000);
});
