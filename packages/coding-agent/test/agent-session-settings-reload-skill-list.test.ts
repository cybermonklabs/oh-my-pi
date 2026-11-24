/**
 * A settings reload that changes which skills the session discovers, on a prompt a prefix-bound model has answered
 * under: the registry follows the rediscovered skills at once, but the system prompt keeps the list it was sent with
 * until the held rebuild, so the next request reads the cached prompt and the hidden skill notice tells the model what
 * changed. A reload always rediscovers through the extension runner every SDK session has, so this is the
 * `resources_discover` branch of `SessionTools.refreshSkills`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlayRebuild, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Project skills only: the developer's own skills stay out of discovery. */
const PROJECT_SKILLS =
	"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";

const MINUTE_MS = 60_000;

/** The longest a held settings change may wait while requests keep the cache warm. */
const HOLD_BOUND_MS = 5 * MINUTE_MS;

/** The calls a reload of `skills.*` starts: the skill rediscovery, and the hold of a change no rebuild takes. */
const RELOAD_REBUILDS: readonly OverlayRebuild[] = ["refreshSkillsAndCommands", "holdToolDeclarationChange"];

interface ProjectSkill {
	name: string;
	description: string;
}

const CHECKLIST: ProjectSkill = { name: "release-checklist", description: "Walk the release checklist step by step" };

const TRIAGE: ProjectSkill = { name: "incident-triage", description: "Triage a production incident from its alerts" };

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
}

describe("a settings reload that changes the discovered skills on a prefix-bound model", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A clock `Date.now` reads, moved by the test. */
	function startClock(): { advance(ms: number): void; now(): number } {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		return {
			advance: ms => {
				now += ms;
			},
			now: () => now,
		};
	}

	/**
	 * A session on the gateway's claude-opus-5-5 that discovers its skills as a CLI session does, from `skills`
	 * installed in the project, with `LONG_ENTRIES` and `PROJECT_SKILLS` loaded as a `--config` file.
	 */
	async function startSession(skills: readonly ProjectSkill[]): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-reload-skill-list-");
		cleanups.push(() => dir.remove());
		for (const { name, description } of skills) {
			await Bun.write(
				dir.join(`.omp/skills/${name}/SKILL.md`),
				`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
			);
		}
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `${LONG_ENTRIES}${PROJECT_SKILLS}`);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
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
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay };
	}

	it("keeps the system prompt when a reload ignores a listed skill, withdraws it in the skill notice, and lists the rest five minutes on", async () => {
		const clock = startClock();
		const harness = await startSession([CHECKLIST, TRIAGE]);
		await harness.session.prompt("first");
		clock.advance(30_000);
		const changedAt = clock.now();
		await reloadOverlay(
			harness,
			`${LONG_ENTRIES}${PROJECT_SKILLS}  ignoredSkills:\n    - ${TRIAGE.name}\n`,
			RELOAD_REBUILDS,
		);
		clock.advance(MINUTE_MS);
		await harness.session.prompt("a minute after the change");
		clock.advance(changedAt + HOLD_BOUND_MS - clock.now());
		await harness.session.prompt("five minutes after the change");

		const [first, second, third] = harness.requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the prompt the model answered under lists both skills.
		expect(copiesIn(first.system, `- ${CHECKLIST.name}: ${CHECKLIST.description}`)).toBe(1);
		expect(copiesIn(first.system, `- ${TRIAGE.name}: ${TRIAGE.description}`)).toBe(1);
		// A rebuilt list rewrites the system prompt and every message after it in the cache.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// Reading the ignored skill fails now, so the model must be told it is gone.
		const sinceFirst = second.messages.slice(first.messages.length);
		expect(copiesIn(sinceFirst, "No longer available:")).toBe(1);
		expect(copiesIn(sinceFirst, `- \`${TRIAGE.name}\``)).toBe(1);
		// The held rebuild comes at the first request five minutes after the change, with the list the reload found.
		expect(copiesIn(third.system, `- ${CHECKLIST.name}: ${CHECKLIST.description}`)).toBe(1);
		expect(copiesIn(third.system, TRIAGE.name)).toBe(0);
	}, 60_000);

	it("keeps the system prompt when a reload adds a skill directory, announces its skill, and lists it five minutes on", async () => {
		const clock = startClock();
		const harness = await startSession([CHECKLIST]);
		const extra = TempDir.createSync("@pi-settings-reload-skill-dir-");
		cleanups.push(() => extra.remove());
		await Bun.write(
			extra.join(`${TRIAGE.name}/SKILL.md`),
			`---\nname: ${TRIAGE.name}\ndescription: ${TRIAGE.description}\n---\n\n# ${TRIAGE.name}\n`,
		);
		await harness.session.prompt("first");
		clock.advance(30_000);
		const changedAt = clock.now();
		await reloadOverlay(
			harness,
			`${LONG_ENTRIES}${PROJECT_SKILLS}  customDirectories:\n    - ${extra.path()}\n`,
			RELOAD_REBUILDS,
		);
		clock.advance(MINUTE_MS);
		await harness.session.prompt("a minute after the change");
		clock.advance(changedAt + HOLD_BOUND_MS - clock.now());
		await harness.session.prompt("five minutes after the change");

		const [first, second, third] = harness.requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the prompt the model answered under lists only the project's skill.
		expect(copiesIn(first.system, `- ${CHECKLIST.name}: ${CHECKLIST.description}`)).toBe(1);
		expect(copiesIn(first.system, TRIAGE.name)).toBe(0);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// `skill://` serves the new skill now, so the model must be told of it.
		expect(copiesIn(second.messages.slice(first.messages.length), `- ${TRIAGE.name}: ${TRIAGE.description}`)).toBe(1);
		expect(copiesIn(third.system, `- ${CHECKLIST.name}: ${CHECKLIST.description}`)).toBe(1);
		expect(copiesIn(third.system, `- ${TRIAGE.name}: ${TRIAGE.description}`)).toBe(1);
	}, 60_000);
});
