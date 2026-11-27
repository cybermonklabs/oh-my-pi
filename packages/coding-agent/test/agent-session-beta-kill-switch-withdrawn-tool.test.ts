/**
 * Claude Code's `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` kill switch turns off mid-conversation tool changes on the
 * `anthropic` provider: a request under it declares the roster alone, and a tool taken off the roster leaves the
 * declaration. A transcript an earlier process recorded without the switch still holds that process's declaration.
 * The non-message figure (the status line, the compaction checks) must count only what the
 * request declares: a withdrawn tool it counts though the request no longer sends it makes compaction start early.
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

const KILL_SWITCH = "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS";

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

/** Tokens of the definitions `request` declares for tools not on `session`'s roster. */
function offRosterWireTokens(session: AgentSession, request: MessagesRequest | undefined): number {
	const active = new Set(session.agent.state.tools.map(tool => tool.name));
	return (request?.tools ?? [])
		.filter(tool => !active.has(tool.name))
		.reduce((tokens, tool) => tokens + wireToolTokens(session.agent.tokenizer, tool), 0);
}

/** One process on the gateway's claude-opus-5-5 with `read` and `debug`, on `sessionFile` or a new session. */
async function runProcess(
	tempDir: TempDir,
	sessionFile: string | undefined,
	steps: (session: AgentSession, requests: MessagesRequest[]) => Promise<void>,
): Promise<string> {
	const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
		settings: Settings.isolated({ "providers.cacheRetention": "long" }),
		model,
		toolNames: ["read", "debug"],
		contextFiles: [],
		skills: [],
	});
	try {
		await steps(session, requests);
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session");
		return file;
	} finally {
		await session.dispose();
		authStorage.close();
		restore();
	}
}

/**
 * A session one process ran a prompt on; resumed in a second process with the kill switch set if `killSwitch`, which
 * runs a prompt, takes `debug` off the roster, and runs another. `check` gets the non-message figure taken before that
 * last prompt, the roster figure taken with it, and the last prompt's request.
 */
async function resumeAndWithdraw(
	killSwitch: boolean,
	check: (session: AgentSession, figure: number, rosterFigure: number, request: MessagesRequest | undefined) => void,
): Promise<void> {
	using tempDir = TempDir.createSync("@pi-beta-kill-switch-withdrawn-tool-");
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
	const sessionFile = await runProcess(tempDir, undefined, async session => {
		await session.prompt("first");
	});
	const previous = process.env[KILL_SWITCH];
	if (killSwitch) process.env[KILL_SWITCH] = "1";
	try {
		await runProcess(tempDir, sessionFile, async (session, requests) => {
			await session.prompt("second");
			await session.setActiveToolsByName(["read"]);
			const figure = computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision);
			const rosterFigure = activeRosterFigure(session);
			await session.prompt("third");
			check(session, figure, rosterFigure, requests.at(-1));
		});
	} finally {
		if (previous === undefined) delete process.env[KILL_SWITCH];
		else process.env[KILL_SWITCH] = previous;
	}
}

describe("non-message figure on a resumed session under Claude Code's experimental-beta kill switch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("counts no withdrawn tool the request under the kill switch does not declare", async () => {
		await resumeAndWithdraw(true, (session, figure, rosterFigure, request) => {
			// Precondition: the request under the kill switch declared the roster alone.
			expect((request?.tools ?? []).map(tool => tool.name)).toEqual(["read"]);

			expect(figure).toBe(rosterFigure + offRosterWireTokens(session, request));
		});
	}, 60_000);

	it("keeps counting none after that request", async () => {
		await resumeAndWithdraw(true, (session, _figure, _rosterFigure, request) => {
			// Precondition: the request under the kill switch declared the roster alone.
			expect((request?.tools ?? []).map(tool => tool.name)).toEqual(["read"]);

			expect(computeNonMessageTokens(session, session.agent.tokenizer, session.settings.revision)).toBe(
				activeRosterFigure(session),
			);
		});
	}, 60_000);

	it("counts the withdrawn tool a request without the kill switch still declares", async () => {
		await resumeAndWithdraw(false, (session, figure, rosterFigure, request) => {
			// Precondition: the request without the kill switch declared the withdrawn tool beside the roster.
			expect((request?.tools ?? []).map(tool => tool.name).sort()).toEqual(["debug", "read"]);

			expect(figure).toBe(rosterFigure + offRosterWireTokens(session, request));
		});
	}, 60_000);
});
