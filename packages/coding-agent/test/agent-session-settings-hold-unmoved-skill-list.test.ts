/**
 * A `skills.*` change on a bound prompt rediscovers the skills, and is held only when the rediscovered list moves the
 * skills the prompt lists: the prompt keeps its list until the rebuild and the hidden settings notice names the change.
 * A change whose rediscovery finds the skills the prompt lists, each with the description it gives (an ignore pattern
 * no skill matches), moves nothing a rebuild would send. Such a change must not be announced as held, as the release,
 * which holds no change, announces none.
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

/** {@link PROJECT_SKILLS} with an ignore pattern no skill matches. */
const NOTHING_IGNORED = `${LONG_ENTRIES}${PROJECT_SKILLS}  ignoredSkills:\n    - no-such-skill\n`;

/** The calls a reload of `skills.*` starts: the skill rediscovery, and the hold of a change no rebuild takes. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshSkillsAndCommands", "holdToolDeclarationChange"];

const CHECKLIST = { name: "release-checklist", description: "Walk the release checklist step by step" };

const MINUTE_MS = 60_000;

describe("a skills change whose rediscovery moves no skill the bound prompt lists", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is not announced as held", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-unmoved-skill-list-");
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
			await reloadOverlay({ session, settings, overlay }, NOTHING_IGNORED, RELOAD_REBUILDS);
			setClock(MINUTE_MS);
			await session.prompt("after the change");

			const [first, changed] = gateway.requests;
			if (!first || !changed) throw new Error("Expected two requests");
			// Preconditions: the prompt lists the skill, and the request after the change sends the prompt as it was.
			expect(textOf(first.system)).toContain(`${CHECKLIST.name}: ${CHECKLIST.description}`);
			expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));

			expect(textOf(changed.messages.slice(first.messages.length))).not.toContain(SETTINGS_NOTICE);
		} finally {
			await session.dispose();
			authStorage.close();
			gateway.restore();
		}
	}, 60_000);
});
