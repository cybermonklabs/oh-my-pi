/**
 * A process that resumes a session while its prompt cache entry is warm keeps the system prompt the transcript was
 * last sent with in place of its own build, and sends its own build once the change it withholds is five minutes old.
 * Here the configuration ignored a skill the stored prompt lists while no process ran, so this process's own build
 * leaves it out. A configuration sync then lists the skill again: the skills the session has are the ones the kept
 * prompt lists, so the sync holds nothing and rebuilds nothing, but the session's own build must take the skill list
 * in. The prompt that goes out five minutes on must list every skill the session has, as the kept prompt did, and not
 * the list the session was started with.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlayRebuild, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Project skills only: the developer's own skills stay out of discovery. */
const PROJECT_SKILLS =
	"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";

const MINUTE_MS = 60_000;

/** The calls a reload of `skills.*` starts: the skill rediscovery, and the hold of a change no rebuild takes. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshSkillsAndCommands", "holdToolDeclarationChange"];

const CHECKLIST = { name: "release-checklist", description: "Walk the release checklist step by step" };

const TRIAGE = { name: "incident-triage", description: "Triage a production incident from its alerts" };

/** {@link PROJECT_SKILLS} with {@link TRIAGE} ignored. */
const TRIAGE_IGNORED = `${LONG_ENTRIES}${PROJECT_SKILLS}  ignoredSkills:\n    - ${TRIAGE.name}\n`;

/** The line a system prompt lists `skill` with. */
function listed(skill: { name: string; description: string }): string {
	return `- ${skill.name}: ${skill.description}`;
}

describe("a kept restored prompt whose skill list a sync gives the session again", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one) that discovers its skills from the project, its
	 * settings loaded from an overlay with `overlay`: runs `steps` on the session, then exits. Returns the requests and
	 * the session file.
	 */
	async function runProcess(
		dir: TempDir,
		overlay: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, settings: Settings, overlayPath: string) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(restore);
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
		});
		try {
			await steps(session, settings, overlayPath);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	it("lists every skill the session has in the prompt that goes out five minutes on", async () => {
		using dir = TempDir.createSync("@pi-restored-prompt-skill-list-adopted-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		for (const { name, description } of [CHECKLIST, TRIAGE]) {
			await Bun.write(
				dir.join(`.omp/skills/${name}/SKILL.md`),
				`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
			);
		}
		setClock(0);
		const before = await runProcess(dir, `${LONG_ENTRIES}${PROJECT_SKILLS}`, undefined, async session => {
			await session.prompt("first");
		});
		setClock(MINUTE_MS);
		const resumed = await runProcess(dir, TRIAGE_IGNORED, before.sessionFile, async (session, settings, overlay) => {
			await session.prompt("after the restart");
			await reloadOverlay({ session, settings, overlay }, `${LONG_ENTRIES}${PROJECT_SKILLS}`, RELOAD_REBUILDS);
			setClock(2 * MINUTE_MS);
			await session.prompt("after the sync");
			setClock(7 * MINUTE_MS);
			await session.prompt("five minutes on");
		});

		const [first] = before.requests;
		const [restarted, synced, late] = resumed.requests;
		if (!first || !restarted || !synced || !late) throw new Error("Expected the two processes' requests");
		// Preconditions: the resumed process keeps the transcript's prompt, which lists both skills, and tells the
		// model that the ignored skill is gone; after the sync it keeps that prompt still.
		expect(copiesIn(first.system, listed(TRIAGE))).toBe(1);
		expect(withoutCacheControl(restarted.system)).toBe(withoutCacheControl(first.system));
		expect(textOf(restarted.messages.slice(first.messages.length))).toContain("No longer available:");
		expect(withoutCacheControl(synced.system)).toBe(withoutCacheControl(first.system));

		expect(copiesIn(late.system, listed(CHECKLIST))).toBe(1);
		expect(copiesIn(late.system, listed(TRIAGE))).toBe(1);
	}, 60_000);
});
