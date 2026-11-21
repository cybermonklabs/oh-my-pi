/**
 * A resumed process keeps its transcript's stored system prompt while the next request reads that transcript's cache
 * entry, with the skill list the previous process rendered. A skill installed or removed between the processes reaches
 * the model on a kept prompt only through the hidden skill notice, so the notice must compare the live skills with what
 * the kept prompt lists, not with what this process's own build would list.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
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

const DEPLOY: Skill = {
	name: "deploy-playbook",
	description: "Deploy with blue/green switches",
	filePath: "/skills/deploy-playbook/SKILL.md",
	baseDir: "/skills/deploy-playbook",
	source: "test",
};

describe("skill notice on a resumed process's kept transcript prompt", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		// Last in, first out: each session is disposed before the temp dir it writes to is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** One process on the session file (a new session without one) with `skills` loaded. */
	async function runProcess(
		tempDir: TempDir,
		sessionFile: string | undefined,
		skills: Skill[],
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
			// `read` serves `skill://`, so the prompt lists the skills.
			toolNames: ["read"],
			contextFiles: [],
			skills,
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

	it("announces a skill installed since the kept prompt was sent", async () => {
		const tempDir = TempDir.createSync("@pi-restored-prompt-skill-notice-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, [], async session => {
			await session.prompt("First.");
		});
		const resumed = await runProcess(tempDir, live.sessionFile, [DEPLOY], async session => {
			await session.prompt("After the restart.");
		});

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		// Precondition: the resumed request keeps the transcript's prompt, which lists no such skill.
		expect(withoutCacheControl(first.system)).toBe(withoutCacheControl(last.system));
		expect(copiesIn(first.system, DEPLOY.name)).toBe(0);
		// The skill is loaded and `skill://` serves it, so the model must be told of it.
		expect(copiesIn(first.messages, `- ${DEPLOY.name}: ${DEPLOY.description}`)).toBe(1);
	}, 30_000);

	it("withdraws a skill the kept prompt lists that the resumed process no longer has", async () => {
		const tempDir = TempDir.createSync("@pi-restored-prompt-skill-notice-");
		cleanups.push(() => tempDir.remove());
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, undefined, [DEPLOY], async session => {
			await session.prompt("First.");
		});
		const resumed = await runProcess(tempDir, live.sessionFile, [], async session => {
			await session.prompt("After the restart.");
		});

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		// Precondition: the resumed request keeps the transcript's prompt, which still lists the skill.
		expect(withoutCacheControl(first.system)).toBe(withoutCacheControl(last.system));
		expect(copiesIn(first.system, DEPLOY.name)).toBeGreaterThan(0);
		// Reading it fails now, so the model must be told it is gone.
		expect(copiesIn(first.messages, "No longer available:")).toBe(1);
		expect(copiesIn(first.messages, `- \`${DEPLOY.name}\``)).toBe(1);
	}, 30_000);
});
