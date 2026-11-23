/**
 * Plan review sends the approved plan in its own plan-approved prompt and marks the reference sent, so no reference
 * message goes out with it. A process that resumes the session loads that prompt with the history: the first request
 * after the restart carries the plan already and must not send a reference with a second copy of it.
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
const PLAN = `# Approved Plan\n\n${PLAN_MARKER}\n`;

describe("approved plan sent in the plan-approved prompt, after a restart", () => {
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

	it("sends no reference with a second copy of the plan in the first request after the restart", async () => {
		const tempDir = TempDir.createSync("@pi-plan-reference-approved-prompt-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, async session => {
			const file = resolveLocalUrlToPath(PLAN_URL, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, PLAN);
			// The approval as plan review records and dispatches it: the plan rides the plan-approved prompt.
			session.setPlanReferencePath(PLAN_URL);
			session.sessionManager.appendModeChange("none", { approvedPlanFilePath: PLAN_URL });
			session.markPlanReferenceSent();
			await session.prompt(`Plan approved. Execute it:\n\n${PLAN}`, { synthetic: true });
			await session.prompt("Continue.");
		});
		const resumed = await runProcess(tempDir, live.sessionFile, async session => {
			await session.prompt("Pick up where we left off.");
		});

		const [first, second] = live.requests;
		const [afterRestart] = resumed.requests;
		if (!first || !second || !afterRestart) throw new Error("Expected the requests before and after the restart");
		expect(copiesIn(first.messages, PLAN_MARKER)).toBe(1);
		expect(copiesIn(second.messages, PLAN_MARKER)).toBe(1);
		expect(continuesCachedPrompt(second, afterRestart)).toBe(true);
		expect(copiesIn(afterRestart.messages, PLAN_MARKER)).toBe(1);
	}, 30_000);
});
