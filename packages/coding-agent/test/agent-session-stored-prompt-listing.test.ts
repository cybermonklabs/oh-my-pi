/**
 * The session file stores each prompt a prefix-bound model was sent with, with the top-level tools its blocks list, so
 * a resumed process that sends it again tells the model how the active tools differ from that list. A tool that
 * arrives or leaves while the first request under that prompt is in flight changes the active tools but not the
 * prompt, which keeps its bytes: the stored list must be the prompt's, or the resumed process announces a change of a
 * tool the prompt never listed, or one it still lists.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, personalityOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	heldOpen,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** An MCP tool listed among the top-level tools. */
const LOOKUP: CustomTool = {
	name: "mcp__docs_lookup",
	label: "docs/lookup",
	description: "Look up a page of the project docs",
	parameters: type({ q: "string" }),
	loadMode: "essential",
	mcpServerName: "docs",
	mcpToolName: "lookup",
	async execute() {
		return { content: [{ type: "text", text: "page" }] };
	},
};

describe("a resumed process that sends the stored prompt", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one) under `personality`, with `mcpTools` active from
	 * the start, that sends one prompt and exits. With `inFlight`, its request stays in flight until `inFlight` ran.
	 */
	async function runProcess(
		dir: TempDir,
		personality: string,
		sessionFile: string | undefined,
		mcpTools: CustomTool[],
		inFlight?: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, personalityOverlay(personality));
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const sent = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const { requests, restore } = mockGatewayFetch(turn => {
			const reply = answer(turn, { cacheWriteTokens: 100 });
			if (!inFlight) return reply;
			sent.resolve();
			return heldOpen(reply, released.promise);
		});
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
			mcpTools,
			contextFiles: [],
			skills: [],
		});
		try {
			const prompted = session.prompt(sessionFile ? "after the resume" : "first");
			if (inFlight) {
				await sent.promise;
				await inFlight(session);
				released.resolve();
			}
			await prompted;
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			released.resolve();
			await session.dispose();
			authStorage.close();
			restore();
		}
	}

	it("announces no withdrawal of a tool that arrived while the stored prompt's first request was in flight", async () => {
		using dir = TempDir.createSync("@pi-stored-prompt-listing-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, "default", undefined, [], session => session.refreshMCPTools([LOOKUP]));
		// Another process resumes the session under another personality, so its own build differs and the stored
		// prompt is sent again; its MCP server never connects.
		const resumed = await runProcess(dir, "pragmatic", live.sessionFile, []);

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		// Preconditions: the first request never carried the tool, and the resumed request sends the stored prompt.
		expect(copiesIn(first, LOOKUP.name)).toBe(0);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// No request on the branch carried the tool: nothing is withdrawn.
		expect(copiesIn(second.messages, "No longer available")).toBe(0);
	}, 60_000);

	it("announces no arrival of a tool the stored prompt lists that left while its first request was in flight", async () => {
		using dir = TempDir.createSync("@pi-stored-prompt-listing-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(dir, "default", undefined, [LOOKUP], session => session.refreshMCPTools([]));
		// The resumed process has the tool from the start, as the first request did.
		const resumed = await runProcess(dir, "pragmatic", live.sessionFile, [LOOKUP]);

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		// Preconditions: the stored prompt lists the tool, and the resumed request sends it.
		expect(copiesIn(first.system, LOOKUP.name)).toBeGreaterThan(0);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// The prompt the model holds lists the tool: nothing arrived.
		expect(copiesIn(second.messages, "Now available")).toBe(0);
	}, 60_000);
});
