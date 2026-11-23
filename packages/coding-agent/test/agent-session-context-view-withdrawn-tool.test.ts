/**
 * On a model that keeps its tool declaration across a conversation, a tool taken off the roster stays declared: every
 * later request re-sends its definition, and it counts in each request's prompt. `/context` lists the tool definitions
 * the context holds; this case checks that it lists such a tool too.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { buildSessionContextView } from "@oh-my-pi/pi-coding-agent/session/context-view";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, gatewaySessionOptions, mockGatewayFetch } from "./helpers/anthropic-gateway";

describe("/context on a session whose requests still declare a withdrawn tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists every tool definition the session's last request declared", async () => {
		using tempDir = TempDir.createSync("@pi-context-view-withdrawn-tool-");
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
			toolNames: ["read", "bash"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			// `bash` leaves the roster; the next request still declares it, byte for byte.
			await session.setActiveToolsByName(["read"]);
			await session.prompt("second");
			const [first, second] = requests;
			if (!first || !second) throw new Error("Expected both requests");
			const declared = (second.tools ?? []).map(tool => tool.name).sort();
			// Precondition: the withdrawn tool is still declared, as the first request declared it.
			expect(declared).toEqual((first.tools ?? []).map(tool => tool.name).sort());
			expect(declared).toContain("bash");

			// `/context` lists the definitions that request declared, which the next one declares again: the withdrawn
			// one among them.
			const data = buildSessionContextView(session);
			const listed = data.categories
				.filter(category => category.id === "built-in-tools" || category.id === "custom-tools")
				.flatMap(category => category.entries.map(entry => entry.label))
				.sort();
			expect(listed).toEqual(declared);
		} finally {
			await session.dispose();
			authStorage.close();
			restore();
		}
	}, 60_000);
});
