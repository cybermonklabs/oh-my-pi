import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	heldOpen,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** An MCP tool whose server connects late, presented as `loadMode` says. */
function lookupTool(loadMode: ToolLoadMode): CustomTool {
	return {
		name: "mcp__docs_lookup",
		label: "docs/lookup",
		description: "Look up a page of the project docs",
		parameters: type({ q: "string" }),
		loadMode,
		mcpServerName: "docs",
		mcpToolName: "lookup",
		async execute() {
			return { content: [{ type: "text", text: "page" }] };
		},
	};
}

/** A late MCP tool, and the line of the notice that tells the model of it. */
interface LateToolCase {
	label: string;
	tool: CustomTool;
	marker: string;
}

const CASES: LateToolCase[] = [
	{ label: "top-level tool", tool: lookupTool("essential"), marker: "Now available: mcp__docs_lookup." },
	{ label: "xd:// device", tool: lookupTool("discoverable"), marker: "- xd://mcp__docs_lookup —" },
];

// An MCP server that answers after the session's first request went out (the first turn waits for discovery only so
// long) adds its tools while that request is in flight. The request has sent the prompt, and its reply binds it: a
// prompt rebuilt to list the new tool would rewrite the whole cached prompt at the second request, a moment after its
// first cache write. The prompt keeps its bytes and a hidden notice tells the model of the tool, as after a reply.
describe("an MCP tool that arrives while the session's first request is in flight", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(CASES)(
		"keeps the prompt that request sent and tells the model of the new $label",
		async ({ tool, marker }) => {
			using tempDir = TempDir.createSync("@pi-first-request-late-tool-");
			await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
			const sent = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			const gateway = mockGatewayFetch(turn => {
				const reply = answer(turn, { cacheWriteTokens: 100 });
				if (turn !== 1) return reply;
				sent.resolve();
				return heldOpen(reply, released.promise);
			});
			const authStorage = createInMemoryAuthStorage();
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const model = modelRegistry.find("anthropic", "claude-opus-5-5");
			if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
			const { session } = await createAgentSession({
				...gatewaySessionOptions(tempDir),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "providers.cacheRetention": "long", "compaction.enabled": false }),
				model,
				toolNames: ["read", "bash"],
				contextFiles: [],
				skills: [],
			});
			try {
				const first = session.prompt("First.");
				await sent.promise;
				await session.refreshMCPTools([tool]);
				released.resolve();
				await first;
				await session.prompt("Second.");
			} finally {
				released.resolve();
				await session.dispose();
				authStorage.close();
				gateway.restore();
			}

			const [first, second] = gateway.requests;
			if (!first || !second) throw new Error("Expected two requests");
			// Precondition: the first request went out before the tool arrived.
			expect(copiesIn(first, "mcp__docs_lookup")).toBe(0);
			expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
			expect(copiesIn(second.messages, marker)).toBe(1);
		},
		30_000,
	);
});
