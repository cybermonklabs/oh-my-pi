/**
 * A `skills.*` change on a bound prompt is held only when its rediscovery moves the skills a request would list. A
 * prompt lists skills only while `skillful` is on and an active tool reads `skill://`: a session with neither lists
 * none, so a rediscovery that takes a skill off the registry moves nothing a rebuild would send. Such a change must not
 * be announced as held.
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

/** The calls a reload of `skills.*` starts: the skill rediscovery, and the hold of a change no rebuild takes. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshSkillsAndCommands", "holdToolDeclarationChange"];

const CHECKLIST = { name: "release-checklist", description: "Walk the release checklist step by step" };

const MINUTE_MS = 60_000;

async function runCase(head: string, toolNames: string[]): Promise<void> {
	using dir = TempDir.createSync("@pi-settings-hold-unlisted-skill-list-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	await Bun.write(
		dir.join(`.omp/skills/${CHECKLIST.name}/SKILL.md`),
		`---\nname: ${CHECKLIST.name}\ndescription: ${CHECKLIST.description}\n---\n\n# ${CHECKLIST.name}\n`,
	);
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, `${LONG_ENTRIES}${head}${PROJECT_SKILLS}`);
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
		toolNames,
		contextFiles: [],
	});
	try {
		setClock(0);
		await session.prompt("first");
		// The change takes the skill off the registry.
		await reloadOverlay(
			{ session, settings, overlay },
			`${LONG_ENTRIES}${head}${PROJECT_SKILLS}  ignoredSkills:\n    - ${CHECKLIST.name}\n`,
			RELOAD_REBUILDS,
		);
		setClock(MINUTE_MS);
		await session.prompt("after the change");
		setClock(7 * MINUTE_MS);
		await session.prompt("after the deadline");

		const [first, changed, late] = gateway.requests;
		if (!first || !changed || !late) throw new Error("Expected three requests");
		// Preconditions: the prompt lists no skill, and no request's prompt follows the change, not even the one after
		// the deadline.
		expect(textOf(first.system)).not.toContain(CHECKLIST.description);
		expect(withoutCacheControl(changed.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(late.system)).toBe(withoutCacheControl(first.system));

		expect(textOf(changed.messages.slice(first.messages.length))).not.toContain(SETTINGS_NOTICE);
	} finally {
		await session.dispose();
		authStorage.close();
		gateway.restore();
	}
}

describe("a skills change on a bound prompt that lists no skills", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("is not announced as held with `skillful` off", async () => {
		await runCase("skillful: false\n", ["read"]);
	}, 60_000);

	it("is not announced as held without a tool that reads skill URIs", async () => {
		await runCase("", ["grep"]);
	}, 60_000);
});
