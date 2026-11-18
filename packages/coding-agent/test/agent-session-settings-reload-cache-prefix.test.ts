import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionAPI, ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	continuesCachedPrompt,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	streamedAnswer,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** The `--config` overlay a configuration sync rewrites under a running session. */
const OVERLAY = "providers:\n  cacheRetention: long\n";

const HOUR_MS = 60 * 60_000;

/** Every reply writes the prompt cache. */
const CACHE_WRITE_TOKENS = 100;

/** A text reply; the request it answers sent `inputTokens` uncached. */
function textAnswer(turn: number, inputTokens?: number): Response {
	return answer(turn, { inputTokens, cacheWriteTokens: CACHE_WRITE_TOKENS });
}

function toolCallAnswer(turn: number, name: string, input: Record<string, unknown>): Response {
	return streamedAnswer(
		turn,
		{ type: "tool_use", id: `toolu_${turn}`, name, input: {} },
		[{ type: "input_json_delta", partial_json: JSON.stringify(input) }],
		"tool_use",
		{ cacheWriteTokens: CACHE_WRITE_TOKENS },
	);
}

/** Every text a wire value carries: text blocks, string contents and nested tool results. */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textOf).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	return [record.text, record.content].map(textOf).join("\n");
}

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	modelRegistry: ModelRegistry;
}

describe("prompt rebuilds a configuration reload starts on a prefix-bound model", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A temp dir removed once the sessions started under it are disposed. */
	function createTempDir(): TempDir {
		const dir = TempDir.createSync("@pi-settings-reload-cache-prefix-");
		cleanups.push(() => dir.remove());
		return dir;
	}

	/**
	 * A session on the gateway's claude-opus-5-5 (a 1M window unless `contextWindow` says otherwise) whose settings
	 * load `OVERLAY` and `overlay` as a `--config` file. `replies` answers requests by their 1-based number; the rest
	 * get text. With `discoverSkills` the session discovers its skills as a CLI session does, so a `skill://` read
	 * of an unknown name rediscovers them.
	 */
	async function startSession(
		tempDir: TempDir,
		options: {
			toolNames: string[];
			discoverContextFiles?: boolean;
			discoverSkills?: boolean;
			overlay?: string;
			contextWindow?: number;
			extensions?: ExtensionFactory[];
			replies?: Record<number, (turn: number) => Response>;
		},
	): Promise<Harness> {
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml(options.contextWindow));
		const overlay = tempDir.join("overlay.yml");
		await Bun.write(overlay, `${OVERLAY}${options.overlay ?? ""}`);
		const settings = await Settings.loadIsolated({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			configFiles: [overlay],
		});
		const { requests } = mockGatewayFetch(turn => (options.replies?.[turn] ?? textAnswer)(turn));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: options.toolNames,
			...(options.discoverContextFiles ? {} : { contextFiles: [] }),
			extensions: options.extensions,
			...(options.discoverSkills ? {} : { skills: [] }),
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, settings, requests, overlay, modelRegistry };
	}

	/** Rewrites the overlay and reloads it as the config watcher does, then waits for the rebuilds the change starts. */
	async function reloadOverlay(harness: Harness, content: string): Promise<void> {
		const rebuilds = [
			vi.spyOn(harness.session, "refreshBaseSystemPrompt"),
			vi.spyOn(harness.session, "reconcileBuiltinTools"),
			vi.spyOn(harness.session, "refreshSkillsAndCommands"),
		];
		await Bun.write(harness.overlay, content);
		await harness.settings.reloadFromDisk();
		// The settings listeners run in the microtask the reload queued for them.
		await Promise.resolve();
		await Promise.all(rebuilds.flatMap(spy => spy.mock.results.map(result => result.value)));
		for (const spy of rebuilds) spy.mockRestore();
	}

	function requestPair(harness: Harness): [MessagesRequest, MessagesRequest] {
		const [first, second] = harness.requests;
		if (!first || !second) throw new Error("Expected two requests");
		return [first, second];
	}

	it("keeps the system prompt and tools when a reload changes personality, and names the change in a notice", async () => {
		const tempDir = createTempDir();
		const harness = await startSession(tempDir, { toolNames: ["read"] });
		await harness.session.prompt("first");

		await reloadOverlay(harness, `${OVERLAY}personality: pragmatic\n`);
		await harness.session.prompt("second");

		const [first, second] = requestPair(harness);
		expect(continuesCachedPrompt(first, second)).toBe(true);
		const notice = textOf(second.messages.slice(first.messages.length));
		expect(notice).toContain("`personality`");
		expect(notice).toContain('"default"');
		expect(notice).toContain('"pragmatic"');
	}, 30_000);

	it("keeps the tools when a reload disables todo, and refuses a call to it naming the setting", async () => {
		const tempDir = createTempDir();
		const harness = await startSession(tempDir, {
			toolNames: ["read", "eval", "todo"],
			replies: { 2: turn => toolCallAnswer(turn, "todo", { op: "view" }) },
		});
		await harness.session.prompt("first");

		await reloadOverlay(harness, `${OVERLAY}todo:\n  enabled: false\n`);
		await harness.session.prompt("second");

		const [first, second] = requestPair(harness);
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(continuesCachedPrompt(first, second)).toBe(true);
		const notice = textOf(second.messages.slice(first.messages.length));
		expect(notice).toContain("`todo.enabled`");
		expect(notice).toContain("`todo`");

		// The model called `todo` in its answer to the second request; the third request carries the refusal.
		const third = harness.requests[2];
		if (!third) throw new Error("Expected the request after the refused call");
		const results = third.messages.flatMap(message =>
			Array.isArray(message.content)
				? (message.content as Array<Record<string, unknown>>).filter(block => block.type === "tool_result")
				: [],
		);
		const refusal = results.find(block => block.tool_use_id === "toolu_2");
		expect(refusal?.is_error).toBe(true);
		expect(textOf(refusal)).toContain("todo.enabled");
	}, 30_000);

	it("keeps the system prompt when a reload changes disabledProviders after a context file was edited", async () => {
		const tempDir = createTempDir();
		await Bun.write(tempDir.join("AGENTS.md"), "# Rules\n\n- The rule the session started with.\n");
		const harness = await startSession(tempDir, { toolNames: ["read"], discoverContextFiles: true });
		await harness.session.prompt("first");

		await Bun.write(tempDir.join("AGENTS.md"), "# Rules\n\n- A rule added while the session runs.\n");
		await reloadOverlay(harness, `${OVERLAY}disabledProviders:\n  - ollama\n`);
		await harness.session.prompt("second");

		const [first, second] = requestPair(harness);
		expect(withoutCacheControl(first.system)).toContain("The rule the session started with.");
		expect(continuesCachedPrompt(first, second)).toBe(true);
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`disabledProviders`");
	}, 30_000);

	it("keeps the held prompt and tools through a skill:// read of a skill installed meanwhile", async () => {
		const tempDir = createTempDir();
		// Project skills only: the developer's own skills stay out of discovery.
		const projectSkills =
			"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";
		const harness = await startSession(tempDir, {
			toolNames: ["read", "eval", "todo"],
			discoverSkills: true,
			overlay: projectSkills,
			replies: { 3: turn => toolCallAnswer(turn, "read", { path: "skill://late-skill" }) },
		});
		await harness.session.prompt("first");
		await reloadOverlay(
			harness,
			`${OVERLAY}${projectSkills}personality: pragmatic\ntodo:\n  enabled: false\ndisabledProviders:\n  - ollama\n`,
		);
		await harness.session.prompt("second");

		// The skill list the prompt keeps lacks the new skill, so its rediscovery rebuilds nothing of its own.
		await Bun.write(
			tempDir.join(".omp/skills/late-skill/SKILL.md"),
			"---\nname: late-skill\ndescription: A skill installed while the session runs.\n---\n\n# Late skill\n\nThe body of the late skill.\n",
		);
		await harness.session.prompt("A skill was installed. Read it.");

		const [, second, third, fourth] = harness.requests;
		if (!second || !third || !fourth) throw new Error("Expected the requests around the skill read");
		expect(textOf(fourth.messages.slice(third.messages.length))).toContain("The body of the late skill.");
		expect(continuesCachedPrompt(second, fourth)).toBe(true);
	}, 30_000);

	it("keeps the held prompt through a skill:// read when the reload only reran skill discovery", async () => {
		const tempDir = createTempDir();
		const projectSkills =
			"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";
		const harness = await startSession(tempDir, {
			toolNames: ["read", "eval"],
			discoverSkills: true,
			overlay: projectSkills,
			replies: { 3: turn => toolCallAnswer(turn, "read", { path: "skill://late-skill" }) },
		});
		await harness.session.prompt("first");
		// `disabledProviders` reruns skill discovery and nothing else: the hold it takes is the skill list's alone.
		await reloadOverlay(harness, `${OVERLAY}${projectSkills}disabledProviders:\n  - ollama\n`);
		await harness.session.prompt("second");

		await Bun.write(
			tempDir.join(".omp/skills/late-skill/SKILL.md"),
			"---\nname: late-skill\ndescription: A skill installed while the session runs.\n---\n\n# Late skill\n\nThe body of the late skill.\n",
		);
		await harness.session.prompt("A skill was installed. Read it.");

		const [, second, third, fourth] = harness.requests;
		if (!second || !third || !fourth) throw new Error("Expected the requests around the skill read");
		expect(textOf(fourth.messages.slice(third.messages.length))).toContain("The body of the late skill.");
		expect(continuesCachedPrompt(second, fourth)).toBe(true);
	}, 30_000);

	it("keeps the held prompt through a skill:// read when a skills-only reload follows a context file edit", async () => {
		const tempDir = createTempDir();
		const projectSkills =
			"skills:\n  enableCodexUser: false\n  enableClaudeUser: false\n  enableClaudeProject: false\n  enablePiUser: false\n  enableAgentsUser: false\n";
		await Bun.write(tempDir.join("AGENTS.md"), "# Rules\n\n- The rule the session started with.\n");
		const harness = await startSession(tempDir, {
			toolNames: ["read", "eval"],
			discoverSkills: true,
			discoverContextFiles: true,
			overlay: projectSkills,
			replies: { 3: turn => toolCallAnswer(turn, "read", { path: "skill://late-skill" }) },
		});
		await harness.session.prompt("first");
		// The held rebuild would carry the edited context file, so the build the kept prompt stands in for differs
		// from it; the skill read's rebuild renders that build again and changes nothing of its own.
		await Bun.write(tempDir.join("AGENTS.md"), "# Rules\n\n- A rule added while the session runs.\n");
		await reloadOverlay(harness, `${OVERLAY}${projectSkills}disabledProviders:\n  - ollama\n`);
		await harness.session.prompt("second");

		await Bun.write(
			tempDir.join(".omp/skills/late-skill/SKILL.md"),
			"---\nname: late-skill\ndescription: A skill installed while the session runs.\n---\n\n# Late skill\n\nThe body of the late skill.\n",
		);
		await harness.session.prompt("A skill was installed. Read it.");

		const [first, second, third, fourth] = harness.requests;
		if (!first || !second || !third || !fourth) throw new Error("Expected the requests around the skill read");
		expect(textOf(fourth.messages.slice(third.messages.length))).toContain("The body of the late skill.");
		expect(withoutCacheControl(fourth.system)).toContain("The rule the session started with.");
		expect(continuesCachedPrompt(second, fourth)).toBe(true);
	}, 30_000);

	it("keeps the held prompt and tools when an extension registers its tool again unchanged", async () => {
		const tempDir = createTempDir();
		let extension: ExtensionAPI | undefined;
		const registerProbe = (pi: ExtensionAPI): void => {
			pi.registerTool({
				name: "probe",
				label: "Probe",
				description: "A tool an extension registers.",
				parameters: pi.typebox.Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		const harness = await startSession(tempDir, {
			toolNames: ["read", "eval", "todo", "probe"],
			extensions: [
				pi => {
					extension = pi;
					registerProbe(pi);
				},
			],
		});
		await harness.session.prompt("first");
		await reloadOverlay(harness, `${OVERLAY}todo:\n  enabled: false\n`);
		await harness.session.prompt("second");

		// The extension registers its tool again with the same definition: the session applies its tools again with
		// a forced rebuild, which changes nothing of its own.
		if (!extension) throw new Error("Expected the extension to load");
		registerProbe(extension);
		await harness.session.runToolRegistryMutation(async () => {});
		await harness.session.prompt("third");

		const [, second, third] = harness.requests;
		if (!second || !third) throw new Error("Expected three requests");
		expect(continuesCachedPrompt(second, third)).toBe(true);
	}, 30_000);

	it("sends the rebuilt prompt at the first request after the held prompt's cache entry lapsed", async () => {
		const tempDir = createTempDir();
		const harness = await startSession(tempDir, { toolNames: ["read"] });
		await harness.session.prompt("first");
		await reloadOverlay(harness, `${OVERLAY}personality: pragmatic\n`);
		await harness.session.prompt("second");
		// The entry is still live: the rebuild stays held.
		await harness.session.prompt("third");

		// Two hours on, the one-hour entry the third request wrote is gone.
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * HOUR_MS);
		await harness.session.prompt("fourth");

		const [first, , third, fourth] = harness.requests;
		if (!first || !third || !fourth) throw new Error("Expected four requests");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(fourth.system)).not.toBe(withoutCacheControl(first.system));
		expect(textOf(fourth.messages.slice(third.messages.length))).not.toContain("`personality`");
	}, 30_000);

	it("keeps the held prompt across an admitted cut that keeps earlier messages, and sends it rebuilt after a compaction", async () => {
		// A forced auto-shake elides old read results and keeps the messages before them cached: the prompt stays held.
		// (A prefix-bound model prunes nothing inside a warm prefix, so the shake is the partial cut a session can make.)
		const shakeDir = createTempDir();
		const parts = ["part1.txt", "part2.txt", "part3.txt", "part4.txt"];
		for (const [index, part] of parts.entries()) {
			const lines = Array.from(
				{ length: 400 },
				(_, line) => `${part} line ${line}: ${"alpha beta gamma delta ".repeat(5)}`,
			);
			await Bun.write(shakeDir.join(part), `${lines.join("\n")}\n${index}\n`);
		}
		const shake = "compaction:\n  methodOrder: [shake]\n  asyncEnabled: false\n";
		const shaken = await startSession(shakeDir, {
			toolNames: ["read"],
			overlay: shake,
			contextWindow: 100_000,
			replies: {
				...Object.fromEntries(
					parts.map((part, index) => [index + 2, (turn: number) => toolCallAnswer(turn, "read", { path: part })]),
				),
				// The reply after the reads fills the window past its reserve.
				[parts.length + 2]: (turn: number) => textAnswer(turn, 90_000),
			},
		});
		await shaken.session.prompt("first");
		await reloadOverlay(shaken, `${OVERLAY}${shake}personality: pragmatic\n`);
		await shaken.session.prompt("read the parts");
		await shaken.session.prompt("after the shake");
		const [shakeFirst] = shaken.requests;
		const afterShake = shaken.requests.at(-1);
		if (!shakeFirst || !afterShake) throw new Error("Expected the requests around the shake");
		expect(textOf(afterShake.messages)).toContain("[shaken ~");
		expect(withoutCacheControl(afterShake.system)).toBe(withoutCacheControl(shakeFirst.system));

		// A compaction forced by a full window rewrites every message anyway: the next request carries the rebuild.
		const compactDir = createTempDir();
		const soft = "compaction:\n  methodOrder: [soft]\n  asyncEnabled: false\n  keepRecentTokens: 1\n";
		const compacted = await startSession(compactDir, {
			toolNames: ["read"],
			overlay: soft,
			contextWindow: 100_000,
			// The second request fills the window past its reserve.
			replies: { 2: turn => textAnswer(turn, 90_000) },
		});
		// No model to summarize with: the admitted compaction starts, then ends skipped.
		vi.spyOn(compacted.modelRegistry, "getAvailable").mockReturnValue([]);
		await compacted.session.prompt("first");
		await reloadOverlay(compacted, `${OVERLAY}${soft}personality: pragmatic\n`);
		await compacted.session.prompt("second");
		await compacted.session.prompt("third");
		const [compactFirst, compactSecond, compactThird] = compacted.requests;
		if (!compactFirst || !compactSecond || !compactThird) throw new Error("Expected three requests");
		expect(withoutCacheControl(compactSecond.system)).toBe(withoutCacheControl(compactFirst.system));
		expect(withoutCacheControl(compactThird.system)).not.toBe(withoutCacheControl(compactFirst.system));
	}, 60_000);
});
