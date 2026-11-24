/**
 * A configuration sync ignores a skill the bound prompt lists: the session holds the change, so the prompt keeps the
 * skill until the rebuild. A copy that cannot hold the change (a `/tan` clone, a parked subagent revived cold) takes
 * the session's build, the prompt that goes out with the change (`AgentSession.withheldPromptBuild`), as the one it
 * sends. That build must list the skills the held rebuild lists, as the session's own requests do once the change goes
 * out; one that still lists the ignored skill offers the copy's model a skill its session no longer has.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
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

describe("the build a session gives its copies while it holds a skills change", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("lists the skills the held rebuild lists", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-withheld-build-skills-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(
			dir.join(`.omp/skills/${CHECKLIST.name}/SKILL.md`),
			`---\nname: ${CHECKLIST.name}\ndescription: ${CHECKLIST.description}\n---\n\n# ${CHECKLIST.name}\n`,
		);
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `${LONG_ENTRIES}${PROJECT_SKILLS}`);
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
			await reloadOverlay(
				{ session, settings, overlay },
				`${LONG_ENTRIES}${PROJECT_SKILLS}  ignoredSkills:\n    - ${CHECKLIST.name}\n`,
				RELOAD_REBUILDS,
			);
			setClock(MINUTE_MS);
			await session.prompt("while held");
			const build = session.withheldPromptBuild;
			// Past the deadline the change's notice gave, the session sends the rebuilt prompt.
			setClock(7 * MINUTE_MS);
			await session.prompt("after the deadline");

			const [first, held, late] = gateway.requests;
			if (!first || !held || !late) throw new Error("Expected three requests");
			const listing = `${CHECKLIST.name}: ${CHECKLIST.description}`;
			// Preconditions: the prompt lists the skill; the change is held and announced, so the request keeps the
			// skill; past the deadline the session's prompt lists it no more.
			expect(textOf(first.system)).toContain(listing);
			expect(textOf(held.messages.slice(first.messages.length))).toContain(SETTINGS_NOTICE);
			expect(textOf(held.system)).toContain(listing);
			expect(textOf(late.system)).not.toContain(listing);
			if (!build) throw new Error("Expected the session to withhold the change");

			expect(textOf(build)).not.toContain(listing);
			expect(build).toEqual(session.baseSystemPrompt);
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
