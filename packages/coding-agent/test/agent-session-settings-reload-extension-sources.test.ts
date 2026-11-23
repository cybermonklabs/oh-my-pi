/**
 * An edit of `extensions` or `disabledExtensions` while a session runs reconciles the extensions and rediscovers the
 * skills: a `skill:<name>` entry in `disabledExtensions` hides that skill. On a prompt a prefix-bound model has
 * answered under, the system prompt keeps the skill list it was sent with until the held rebuild, as for any other
 * settings change that alters the list, and the hidden skill notice tells the model what changed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** Project skills only: the developer's own skills stay out of discovery. */
const PROJECT_SKILLS =
	"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";

const CHECKLIST = { name: "release-checklist", description: "Walk the release checklist step by step" };
const TRIAGE = { name: "incident-triage", description: "Triage a production incident from its alerts" };

const MINUTE_MS = 60_000;

describe("an extension-sources edit that hides a skill on a prefix-bound model", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("keeps the system prompt's skill list until the held rebuild, and tells the model the skill is gone", async () => {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const dir = TempDir.createSync("@pi-settings-reload-extension-sources-");
		cleanups.push(() => dir.remove());
		for (const { name, description } of [CHECKLIST, TRIAGE]) {
			await Bun.write(
				dir.join(`.omp/skills/${name}/SKILL.md`),
				`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
			);
		}
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, `${LONG_ENTRIES}${PROJECT_SKILLS}`);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(restore);
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

		await session.prompt("first");
		now += 30_000;
		const changedAt = now;
		// The edit reconciles the extensions first, then rediscovers skills and commands: wait for that rediscovery.
		const refreshed = Promise.withResolvers<void>();
		const refresh = session.refreshSkillsAndCommands.bind(session);
		vi.spyOn(session, "refreshSkillsAndCommands").mockImplementation(async options => {
			await refresh(options);
			refreshed.resolve();
		});
		await reloadOverlay(
			{ session, settings, overlay },
			`${LONG_ENTRIES}${PROJECT_SKILLS}disabledExtensions:\n  - skill:${TRIAGE.name}\n`,
			["holdToolDeclarationChange"],
		);
		await refreshed.promise;
		now += MINUTE_MS;
		await session.prompt("a minute after the change");
		now = changedAt + 5 * MINUTE_MS;
		await session.prompt("five minutes after the change");

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the prompt the model answered under lists both skills.
		expect(copiesIn(first.system, `- ${TRIAGE.name}: ${TRIAGE.description}`)).toBe(1);
		// A rebuilt list rewrites the system prompt and every message after it in the cache.
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		const sinceFirst = second.messages.slice(first.messages.length);
		expect(copiesIn(sinceFirst, "No longer available:")).toBe(1);
		expect(copiesIn(sinceFirst, `- \`${TRIAGE.name}\``)).toBe(1);
		// The held rebuild comes at the first request five minutes after the change, with the list the edit leaves.
		expect(copiesIn(third.system, `- ${CHECKLIST.name}: ${CHECKLIST.description}`)).toBe(1);
		expect(copiesIn(third.system, TRIAGE.name)).toBe(0);
	}, 60_000);
});
