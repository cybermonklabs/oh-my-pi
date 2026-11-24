/**
 * A `skills.*` change on a bound prompt is held only when its rediscovery moves the skills a rebuild would list. The
 * registry can list other skills than the prompt for a reason that is not the change: a skill written since the prompt
 * was built waits for a rebuild of its own, and the skill notice tells the model of it. A change whose rediscovery
 * finds what the registry listed before it (a custom directory with no skills in it) moves nothing, so it must not be
 * announced as held.
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
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Project skills only: the developer's own skills stay out of discovery. */
const PROJECT_SKILLS =
	"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";

/** The calls a reload of `skills.*` starts: the skill rediscovery, and the hold of a change no rebuild takes. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshSkillsAndCommands", "holdToolDeclarationChange"];

const CHECKLIST = { name: "release-checklist", description: "Walk the release checklist step by step" };
const TRIAGE = { name: "bug-triage", description: "Sort incoming bug reports by severity" };

const MINUTE_MS = 60_000;

function skillFile({ name, description }: { name: string; description: string }): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

describe("a skills change whose rediscovery moves nothing while the registry lists a skill written since", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is not announced as held", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-skill-list-other-reason-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(dir.join(`.omp/skills/${CHECKLIST.name}/SKILL.md`), skillFile(CHECKLIST));
		const empty = dir.join("no-skills-here");
		await fs.mkdir(empty, { recursive: true });
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
			// A skill written after the prompt was built: the registry takes it, the prompt's list waits.
			await Bun.write(dir.join(`.omp/skills/${TRIAGE.name}/SKILL.md`), skillFile(TRIAGE));
			await session.reloadSkills();
			// The sync adds a directory with no skills: the rediscovery finds what the registry listed before it.
			await reloadOverlay(
				{ session, settings, overlay },
				`${LONG_ENTRIES}${PROJECT_SKILLS}  customDirectories:\n    - ${JSON.stringify(empty)}\n`,
				RELOAD_REBUILDS,
			);
			setClock(MINUTE_MS);
			await session.prompt("after the change");
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}

		const [first, changed] = gateway.requests;
		if (!first || !changed) throw new Error("Expected two requests");
		const notices = textOf(changed.messages.slice(first.messages.length));
		// Preconditions: the prompt lists the first skill alone and keeps its bytes, and the skill notice tells the
		// model of the skill written since.
		expect(textOf(first.system)).toContain(`${CHECKLIST.name}: ${CHECKLIST.description}`);
		expect(textOf(first.system)).not.toContain(TRIAGE.description);
		expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));
		expect(notices).toContain(TRIAGE.description);

		expect(notices).not.toContain(SETTINGS_NOTICE);
	}, 60_000);
});
