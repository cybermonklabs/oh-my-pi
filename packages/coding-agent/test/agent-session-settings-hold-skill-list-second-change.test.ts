/**
 * A `skills.*` change on a bound prompt is held only when its rediscovery moves the skills a request would list. While
 * an earlier change is held whose rediscovery took a skill off the list, a later `skills.*` change whose rediscovery
 * finds the same skills as before it (a custom directory with no skills in it) moves nothing the held rebuild would
 * not send already. Such a change must not be announced as held: the settings notice may name the earlier change only.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	type OverlayRebuild,
	reloadOverlay,
	SETTINGS_NOTICE,
	setClock,
} from "./helpers/agent-session-setup";
import { answer, gatewayModelsYml, gatewaySessionOptions, mockGatewayFetch, textOf } from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Project skills only: the developer's own skills stay out of discovery. */
const PROJECT_SKILLS =
	"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";

/** The calls a reload of `skills.*` starts: the skill rediscovery, and the hold of a change no rebuild takes. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshSkillsAndCommands", "holdToolDeclarationChange"];

const CHECKLIST = { name: "release-checklist", description: "Walk the release checklist step by step" };

const MINUTE_MS = 60_000;

describe("a skills change whose rediscovery moves nothing while an earlier skills change is held", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is not announced as held", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-skill-list-second-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(
			dir.join(`.omp/skills/${CHECKLIST.name}/SKILL.md`),
			`---\nname: ${CHECKLIST.name}\ndescription: ${CHECKLIST.description}\n---\n\n# ${CHECKLIST.name}\n`,
		);
		const empty = dir.join("no-skills-here");
		await fs.mkdir(empty, { recursive: true });
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `${LONG_ENTRIES}${PROJECT_SKILLS}`);
		const ignored = `${LONG_ENTRIES}${PROJECT_SKILLS}  ignoredSkills:\n    - ${CHECKLIST.name}\n`;
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
		});
		try {
			setClock(0);
			await session.prompt("first");
			// The first change takes the skill off the list: it is held.
			await reloadOverlay({ session, settings, overlay }, ignored, RELOAD_REBUILDS);
			setClock(MINUTE_MS);
			await session.prompt("after the first change");
			// The second adds a directory with no skills: the rediscovery finds what it found before.
			await reloadOverlay(
				{ session, settings, overlay },
				`${ignored}  customDirectories:\n    - ${JSON.stringify(empty)}\n`,
				RELOAD_REBUILDS,
			);
			setClock(2 * MINUTE_MS);
			await session.prompt("after the second change");

			const [first, firstChange, secondChange] = gateway.requests;
			if (!first || !firstChange || !secondChange) throw new Error("Expected three requests");
			const firstNotices = textOf(firstChange.messages.slice(first.messages.length));
			const secondNotices = textOf(secondChange.messages.slice(firstChange.messages.length));
			// Preconditions: the prompt lists the skill, and the first change is held and announced.
			expect(textOf(first.system)).toContain(`${CHECKLIST.name}: ${CHECKLIST.description}`);
			expect(firstNotices).toContain(SETTINGS_NOTICE);
			expect(firstNotices).toContain("skills.ignoredSkills");

			expect(secondNotices).not.toContain("skills.customDirectories");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
