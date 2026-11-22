/**
 * Older records: a parked subagent whose `session_init` an older omp wrote, with no spawn spec, revives cold
 * as the cold revive did before spawn specs, part by part, with the values the reviving omp's spawn gives every
 * subagent applied to it. Each fixture under `test/fixtures/session-init/` is a parked subagent transcript a
 * released omp wrote (`<release>-<shape>.jsonl`); a test copies it into its own workspace, points its header at
 * that workspace, and revives it through the persisted reviver factory, reading `createAgentSession`'s options
 * through the harness's call-through spy and the wake turn's lifecycle frames from the event bus.
 *
 * Two legacy branches no captured release can show are held by existing tests: the strip of a synthetic
 * `write` from a read-only record (every captured release already leaves `write` out of a read-only agent's
 * tools) by "strips synthetic write from legacy read-only cold revival" in `persisted-revive.test.ts`, and the
 * oldest record's single joined `systemPrompt` string by "reads a legacy joined-string system prompt as one
 * block" in `test/session/peek-session-init.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { formatModelRoleAlias } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { openReviveEnv, type RecordedRequest, type ReviveEnv, type RevivedSubagent, userTexts } from "./revive-harness";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "session-init");
/** Every fixture, by file name. */
const FIXTURES = fs
	.readdirSync(FIXTURE_DIR)
	.filter(name => name.endsWith(".jsonl"))
	.sort();
/** The fixture a spawn spec of another version is added to: a default task subagent of the newest release. */
const VERSIONED_FIXTURE = "v18.18.6-sami.20261121-220649-default.jsonl";

/** The live wake limit: a legacy wake turn runs with none, so a slower answer still completes it. */
const LIVE_RUNTIME_LIMIT_MS = 100;
/** How long each answer of the revived subagent's model takes: past {@link LIVE_RUNTIME_LIMIT_MS}. */
const ANSWER_DELAY_MS = 300;
/** The root's settings: the models the fixtures' records name, and their roles. */
const SETTINGS: Readonly<Record<string, unknown>> = {
	modelRoles: { default: "fake/fake-model", task: "fake/fake-model", smol: "fake/fake-model-2" },
	"task.maxRuntimeMs": LIVE_RUNTIME_LIMIT_MS,
	"task.maxEffort": Effort.High,
};

/** The parts of a transcript line a test reads. */
type Line = Record<string, unknown>;

/** Text of `fixture` with its header's `cwd` set to `cwd` (the factory revives no record whose cwd is gone), and `edit` applied to each `session_init`. */
function relocatedFixture(fixture: string, cwd: string, edit: (init: Line) => Line = init => init): string {
	const lines = fs.readFileSync(path.join(FIXTURE_DIR, fixture), "utf8").split("\n");
	return lines
		.map(line => {
			if (line.length === 0) return line;
			const entry: Line = JSON.parse(line);
			if (entry.type === "session") return JSON.stringify({ ...entry, cwd });
			if (entry.type === "session_init") return JSON.stringify(edit(entry));
			return line;
		})
		.join("\n");
}

/** One lifecycle frame of the revived subagent. */
interface Frame {
	status: unknown;
	agentSource: unknown;
	description: unknown;
	parentToolCallId: unknown;
	index: unknown;
}

/** The answer of a fixture subagent's model, after {@link ANSWER_DELAY_MS}: a `yield` where the session has one. */
function fixtureAnswer(request: RecordedRequest): MockResponse | undefined {
	if (!request.model.startsWith("fake/")) return undefined;
	if (request.messages.at(-1)?.role === "toolResult") return { delayMs: ANSWER_DELAY_MS, content: ["done"] };
	if (!request.toolNames.includes("yield")) return { delayMs: ANSWER_DELAY_MS, content: ["ack"] };
	const workPool = userTexts(request).some(text => text.includes("<workpool"));
	const args = workPool ? { key: 1, data: "ok" } : { data: { summary: "ok" } };
	return { delayMs: ANSWER_DELAY_MS, content: [{ type: "toolCall" as const, name: "yield", arguments: args }] };
}

/** A fixture revived cold and woken once. */
interface RevivedFixture {
	env: ReviveEnv;
	id: string;
	/** The latest `session_init` of the copied transcript. */
	init: Line;
	/** The latest session-local switch (a `prewalk` or `temporary` model change) of the transcript, if any. */
	sessionLocalModel: string | undefined;
	revived: RevivedSubagent;
	frames: Frame[];
	warn: Mock<typeof logger.warn>;
}

/** Bound on the wait for the woken subagent's first request: a revive that built no usable session sends none. */
const FIRST_REQUEST_BOUND_MS = 15_000;

/** A test process with the models the fixtures name and the cold reviver over a live root. */
async function openFixtureProcess(): Promise<ReviveEnv> {
	const env = await openReviveEnv(SETTINGS);
	env.scriptDiscovery();
	env.addModel("fake-model", { provider: "fake" });
	env.addModel("fake-model-2", { provider: "fake" });
	env.respond = fixtureAnswer;
	env.installColdReviver(env.createLiveParent());
	return env;
}

/** Copies `fixture` into `env`'s workspace, revives it cold as subagent `id`, and wakes it once. */
async function reviveFixture(
	env: ReviveEnv,
	fixture: string,
	id: string,
	edit?: (init: Line) => Line,
): Promise<RevivedFixture> {
	const sessionFile = path.join(env.artifactsDir, `${id}.jsonl`);
	await Bun.write(sessionFile, relocatedFixture(fixture, env.cwd, edit));
	const records: unknown[] = Bun.JSONL.parse(await Bun.file(sessionFile).text());
	const entries = records.filter(isRecord);
	const sessionLocalModel = entries.findLast(
		entry => entry.type === "model_change" && (entry.role === "prewalk" || entry.role === "temporary"),
	)?.model;
	const init = entries.findLast(entry => entry.type === "session_init");
	if (!init) throw new Error(`${fixture} holds no session_init`);
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		status: "parked",
		session: null,
		sessionFile,
	});
	const frames: Frame[] = [];
	env.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (!isRecord(payload) || payload.id !== id) return;
		const { status, agentSource, description, parentToolCallId, index } = payload;
		frames.push({ status, agentSource, description, parentToolCallId, index });
	});
	const revived = await env.revive(id);
	// A record that holds a batch's yield items revives behind that pooled yield contract, which queues an IRC
	// message instead of waking a turn; the pool releases it with an empty batch, as here, before the wake.
	if (Array.isArray(init.workPoolYieldItems)) await revived.session.setWorkPoolYieldItems([]);
	const warn = vi.spyOn(logger, "warn");
	const bound = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => bound.resolve(undefined), FIRST_REQUEST_BOUND_MS);
	try {
		await Promise.race([env.wake(revived.session, id), bound.promise]);
	} finally {
		clearTimeout(timer);
	}
	return {
		env,
		id,
		init,
		sessionLocalModel: typeof sessionLocalModel === "string" ? sessionLocalModel : undefined,
		revived,
		frames,
		warn,
	};
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The model options of the legacy variant for the record `init`. */
function expectLegacyModel(options: CreateAgentSessionOptions, fixture: RevivedFixture): void {
	const { init } = fixture;
	if (init.perCallModel === true) {
		// An older per-call record holds its exact model and level, which the per-call rule starts it on.
		const model = options.model ? formatModelStringWithRouting(options.model) : undefined;
		expect<unknown>(model).toBe(init.perCallModelIdentity);
		expect(options.modelPattern).toBeUndefined();
		expect(options.disableModelFallback).toBe(true);
		expect(options.disableServerSideFallback).toBe(true);
		return;
	}
	const resolvedModel = typeof init.resolvedModel === "string" ? init.resolvedModel : undefined;
	const role = typeof init.modelRole === "string" && init.modelRole !== "default" ? init.modelRole : undefined;
	const spawnPattern = role ? [formatModelRoleAlias(role), ...(resolvedModel ? [resolvedModel] : [])] : resolvedModel;
	const pattern = fixture.sessionLocalModel
		? [fixture.sessionLocalModel, ...(spawnPattern === undefined ? [] : [spawnPattern].flat())]
		: spawnPattern;
	expect(options.model).toBeUndefined();
	expect(options.modelPattern).toEqual(pattern);
	expect(options.modelPatternAuthFallback).toBe(resolvedModel);
}

function defineFixtureCases(fixture: string, result: () => RevivedFixture): void {
	it(`${fixture}: model takes the legacy variant`, () => {
		const revived = result();
		expectLegacyModel(revived.revived.build.options, revived);
	}, 30_000);

	it(`${fixture}: thinking level and effort ceiling take the legacy variant`, () => {
		const { init, revived } = result();
		const options = revived.build.options;
		if (init.perCallModel === true) {
			expect<unknown>(options.thinkingLevel).toBe(init.perCallThinkingLevel ?? undefined);
			expect(options.thinkingLevelCeiling).toBe(Effort.High);
		} else {
			expect(options.thinkingLevel).toBeUndefined();
			expect(options.thinkingLevelCeiling).toBeUndefined();
		}
	}, 30_000);

	it(`${fixture}: settings take the legacy variant over the live root settings`, () => {
		const { env, init, revived } = result();
		// No fixture holds an advisor, a retry-fallback chain or a compaction threshold, the other legacy inputs.
		expect([init.advisor, init.retryFallback, init.compactionThreshold]).toEqual([undefined, undefined, undefined]);
		const expected = createSubagentSettings(
			env.settings,
			init.readSummarize === false ? { "read.summarize.enabled": false } : {},
		);
		expect(revived.build.settingsLayers).toEqual(expected.overlayLayers());
	}, 30_000);

	it(`${fixture}: tools take the legacy variant, with no custom tool`, () => {
		const { init, revived } = result();
		const options = revived.build.options;
		const tools = stringList(init.tools);
		const mounted = stringList(init.mountedTools);
		const expected =
			init.readOnly === true && tools.includes("write") ? tools.filter(name => name !== "write") : tools;
		expect(options.toolNames).toEqual(expected);
		expect(options.mountedToolNames).toEqual(mounted);
		expect(options.customTools ?? []).toEqual([]);
		const allowed = new Set([...expected, ...mounted]);
		expect(revived.session.getActiveToolNames().filter(name => !allowed.has(name))).toEqual([]);
	}, 30_000);

	it(`${fixture}: policy takes the legacy variant`, () => {
		const { env, init, revived } = result();
		const options = revived.build.options;
		const restricted = init.restrictToolNames === true;
		expect(options.cwd).toBe(env.cwd);
		expect(options.enableLsp).toBe(!restricted);
		expect(options.enableIrc).toBe(restricted ? false : undefined);
		expect(options.skipPythonPreflight).toBeUndefined();
		expect(options.enableMCP).toBe(false);
		expect(options.spawns).toBe(typeof init.spawns === "string" ? init.spawns : "");
		expect(options.taskDepth).toBe(1);
	}, 30_000);

	it(`${fixture}: every prompt build before the first model call returns the record's system prompt`, () => {
		const { init, revived } = result();
		expect(revived.prompt).toEqual(init.systemPrompt);
	}, 30_000);

	it(`${fixture}: the wake turn takes the legacy wake inputs`, () => {
		const { id, frames, warn } = result();
		const [started] = frames;
		expect(started).toEqual({
			status: "started",
			agentSource: "user",
			description: undefined,
			parentToolCallId: undefined,
			index: 0,
		});
		// The live limit is shorter than one answer, and the legacy wake turn has none.
		const limited = warn.mock.calls.filter(
			([message, fields]) => message.includes("runtime limit") && fields?.id === id,
		);
		expect(limited).toEqual([]);
	}, 30_000);

	it(`${fixture}: the constant cacheWarming false applies`, () => {
		expect(result().revived.build.options.cacheWarming).toBe(false);
	}, 30_000);

	it(`${fixture}: the constant excludeAgentsMd true applies`, () => {
		expect(result().revived.build.options.excludeAgentsMd).toBe(true);
	}, 30_000);

	it(`${fixture}: the constant hasUI false applies`, () => {
		expect(result().revived.build.options.hasUI).toBe(false);
	}, 30_000);
}

for (const [index, fixture] of FIXTURES.entries()) {
	describe(`subagent revive of an older record: ${fixture}`, () => {
		let env: ReviveEnv | undefined;
		let revived: RevivedFixture | undefined;

		beforeAll(async () => {
			env = await openFixtureProcess();
			revived = await reviveFixture(env, fixture, `OldRecord${index + 1}`);
		}, 60_000);

		afterAll(async () => {
			await env?.close();
		}, 30_000);

		defineFixtureCases(fixture, () => {
			if (!revived) throw new Error(`${fixture} was not revived`);
			return revived;
		});
	});
}

describe("subagent revive of an older record whose spawn spec has another version", () => {
	let env: ReviveEnv | undefined;
	let revived: RevivedFixture | undefined;

	beforeAll(async () => {
		// A spec of a version this omp does not write: a model, level and tools that differ from the record's.
		const spawnSpec = {
			v: 2,
			model: "fake/fake-model-2",
			thinkingLevel: Effort.High,
			tools: { toolNames: ["read"], mountedToolNames: [], keepTodo: false, customTools: [] },
		};
		env = await openFixtureProcess();
		revived = await reviveFixture(env, VERSIONED_FIXTURE, "OtherVersionSpec", init => ({ ...init, spawnSpec }));
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a spawnSpec of another version revives as an older record", () => {
		if (!revived) throw new Error(`${VERSIONED_FIXTURE} was not revived`);
		const options = revived.revived.build.options;
		expectLegacyModel(options, revived);
		expect(options.thinkingLevel).toBeUndefined();
		expect(options.toolNames).toEqual(stringList(revived.init.tools));
		expect(revived.revived.prompt).toEqual(revived.init.systemPrompt);
	}, 30_000);
});
