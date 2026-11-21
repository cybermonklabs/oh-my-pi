/**
 * On a model that keeps its tool declaration across a conversation, a tool taken off the roster stays declared: every
 * later request sends its definition again. The non-message figure (the status line, the Overview of `/context`, the
 * cut rule's and the compaction projections' fixed prefix) counts the tool definitions; it must count that one too, or
 * compaction starts late.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { computeNonMessageTokens, estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	wireToolTokens,
} from "./helpers/anthropic-gateway";

/** The non-message figure counted from the active roster alone: system prompt and active tool definitions. */
function activeRosterFigure(session: AgentSession): number {
	const tokenizer = session.agent.tokenizer;
	return (
		tokenizer.countTokens(session.systemPrompt) +
		estimateToolSchemaTokens(session.agent.state.tools, tokenizer, {
			sourceRevision: session.settings.revision,
			pruneDescriptions: session.agent.prunesToolDescriptions(session.model),
		})
	);
}

/** Runs two prompts on the gateway's claude-opus-5-5, with `debug` taken off the roster between them if `withdraw`. */
async function runTwoPrompts(
	tempDir: TempDir,
	withdraw: boolean,
	check: (session: AgentSession, requests: MessagesRequest[]) => void,
): Promise<void> {
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
		if (withdraw) await session.setActiveToolsByName(["read"]);
		await session.prompt("second");
		check(session, requests);
	} finally {
		await session.dispose();
		authStorage.close();
		restore();
	}
}

describe("non-message figure on a session whose requests still declare a withdrawn tool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("counts the withdrawn tool's definition as the last request declared it", async () => {
		using tempDir = TempDir.createSync("@pi-non-message-withdrawn-tool-");
		await runTwoPrompts(tempDir, true, (session, requests) => {
			const second = requests[1];
			if (!second) throw new Error("Expected the second request");
			const withdrawn = second.tools?.find(tool => tool.name === "debug");
			// Precondition: the tool left the roster, and the request still declared it, its rendered examples in its
			// description.
			expect(session.agent.state.tools.map(tool => tool.name)).not.toContain("debug");
			if (!withdrawn?.description) throw new Error("Expected the second request to declare debug");
			expect(withdrawn.description).toContain("<examples>");

			// Its definition as the wire carries it, its rendered examples once, in its description.
			const tokenizer = session.agent.tokenizer;
			expect(computeNonMessageTokens(session, tokenizer, session.settings.revision)).toBe(
				activeRosterFigure(session) + wireToolTokens(tokenizer, withdrawn),
			);
		});
	}, 60_000);

	it("counts the active roster alone when no tool was withdrawn", async () => {
		using tempDir = TempDir.createSync("@pi-non-message-no-withdrawn-tool-");
		await runTwoPrompts(tempDir, false, (session, requests) => {
			const declared = (requests[1]?.tools ?? []).map(tool => tool.name).sort();
			// Precondition: the request declared the active roster, nothing else.
			expect(declared).toEqual(session.agent.state.tools.map(tool => tool.name).sort());

			expect(computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision)).toBe(
				activeRosterFigure(session),
			);
		});
	}, 60_000);
});
