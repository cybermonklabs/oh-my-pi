/**
 * The approved-plan reference goes out once with the first request after the approval and stays in the history from
 * there. A resumed process, and a `/resume` switch to the session, load that history: its requests already carry the
 * reference, so the first request after the restart or the switch must not send a second copy of the plan.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
} from "./helpers/anthropic-gateway";

const PLAN_MARKER = "APPROVED-PLAN-MIGRATE-THE-WORKERS";
const PLAN_URL = "local://approved-plan.md";

describe("approved plan reference in a loaded history that carries it", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one). */
	async function runProcess(
		tempDir: TempDir,
		sessionFile: string | undefined,
		steps: (session: AgentSession) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
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
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await steps(session);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests: gateway.requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}

	/** Approves the plan as plan review records it, then sends two prompts: the first carries the reference. */
	async function approveAndWork(session: AgentSession): Promise<void> {
		const file = resolveLocalUrlToPath(PLAN_URL, {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		});
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `# Approved Plan\n\n${PLAN_MARKER}\n`);
		session.setPlanReferencePath(PLAN_URL);
		session.sessionManager.appendModeChange("none", { approvedPlanFilePath: PLAN_URL });
		await session.prompt("Start on the plan.");
		await session.prompt("Continue.");
	}

	it("sends no second copy of the plan in the first request after the restart", async () => {
		const tempDir = TempDir.createSync("@pi-plan-reference-resume-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, approveAndWork);
		const resumed = await runProcess(tempDir, live.sessionFile, async session => {
			await session.prompt("Pick up where we left off.");
			await session.prompt("And continue.");
		});

		const [first, second] = live.requests;
		const [afterRestart, next] = resumed.requests;
		if (!first || !second || !afterRestart || !next) throw new Error("Expected two requests in each process");
		expect(copiesIn(first.messages, PLAN_MARKER)).toBe(1);
		expect(copiesIn(second.messages, PLAN_MARKER)).toBe(1);
		// The resumed history goes out as the last request sent it, the reference included.
		expect(continuesCachedPrompt(second, afterRestart)).toBe(true);
		// So the request carries the plan already: a second copy repeats the whole plan in the conversation.
		expect(copiesIn(afterRestart.messages, PLAN_MARKER)).toBe(1);
		expect(copiesIn(next.messages, PLAN_MARKER)).toBe(1);
	}, 30_000);

	it("sends no second copy of the plan after a switch back to the session that carries it", async () => {
		const tempDir = TempDir.createSync("@pi-plan-reference-resume-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, approveAndWork);
		// A later process opens other work first, then `/resume`s the session with the approved plan.
		const other = await runProcess(tempDir, undefined, async session => {
			await session.prompt("Other work.");
			expect(await session.switchSession(live.sessionFile)).toBe(true);
			await session.prompt("Back to the plan.");
		});

		const second = live.requests[1];
		const [, afterSwitch] = other.requests;
		if (!second || !afterSwitch) throw new Error("Expected the requests before and after the switch");
		expect(continuesCachedPrompt(second, afterSwitch)).toBe(true);
		expect(copiesIn(afterSwitch.messages, PLAN_MARKER)).toBe(1);
	}, 30_000);
});
