/**
 * A stored spawn spec never widens what the live process allows. A writer of the session store edits a parked
 * subagent's stored record (its ids, depth, cwd, credential source, workspace roots, prompt id, artifacts dir,
 * settings overlay and wake limits); the cold revive builds the subagent from the live values instead: the
 * depth of the live parent chain, the ids of the registry ref, the live parent's credential source and roots,
 * discovery at the live root's cwd, and limits no looser than the live settings.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { cfgTaskMaxRecursionDepth, cfgTaskSoftRequestBudget } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	type LiveParent,
	openReviveEnv,
	type RecordedRequest,
	type RevivedSubagent,
	type ReviveEnv,
	spawnerOptions,
	userTexts,
	WAKE_BODY,
} from "./revive-harness";

/** The id, parent id and prompt id the edited record claims. */
const IMPOSTOR = "Impostor";
const IMPOSTOR_PARENT = "ImpostorParent";
/** The credential source the edited record claims. */
const STOLEN_CREDENTIAL_SOURCE = "stolen-credential-source";
/** What the runtime limit logs when it aborts a turn. */
const LIMIT_WARNING = "Subagent runtime limit exceeded; aborting";
/** The text of the steering notice a run gets once it reaches its soft request budget. */
const BUDGET_NOTICE = "[budget notice]";
/** Bound on the wait for a woken turn to start and to end: past the limits these cases set, short of their timeouts. */
const TURN_BOUND_MS = 12_000;
/** The answer of a model that holds a request until the turn is aborted. */
const HELD: MockResponse = { delayMs: 120_000, content: ["late"] };

/** One lifecycle frame of a subagent, with the time it was seen. */
interface LifecycleFrame {
	id: string;
	status: string;
	at: number;
}

/** Every lifecycle frame `bus` carries from now on, in order. */
function recordFrames(bus: EventBus): LifecycleFrame[] {
	const frames: LifecycleFrame[] = [];
	bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
		if (!isRecord(payload)) return;
		frames.push({ id: String(payload.id), status: String(payload.status), at: Date.now() });
	});
	return frames;
}

/** A turn after `frames[from]`: its `started` frame, and its end where one came within the bound. */
interface Turn {
	started: LifecycleFrame;
	ended: LifecycleFrame | undefined;
}

/**
 * Waits for the next turn of `id` (of any subagent where `id` is undefined) after `frames[from]` to start, then up
 * to the bound for it to end. The turn runs on real timers (a runtime limit, a held model answer), so the wait
 * polls the frames on the platform clock rather than a fake one.
 */
async function nextTurn(frames: LifecycleFrame[], id: string | undefined, from: number): Promise<Turn> {
	const startDeadline = Date.now() + TURN_BOUND_MS;
	for (;;) {
		const after = frames.slice(from).filter(frame => id === undefined || frame.id === id);
		const started = after.find(frame => frame.status === "started");
		if (started) {
			const ended = after.find(frame => frame.status !== "started" && frame.at >= started.at);
			if (ended || Date.now() - started.at > TURN_BOUND_MS) return { started, ended };
		} else if (Date.now() > startDeadline) {
			throw new Error(`No turn of ${id ?? "any subagent"} started`);
		}
		await Bun.sleep(20);
	}
}

/** Holds every request of a wake turn: one whose conversation carries the IRC message that woke it. */
function holdWake(request: RecordedRequest): MockResponse | undefined {
	return userTexts(request).some(text => text.includes(WAKE_BODY)) ? HELD : undefined;
}

/** The `key` part of a stored record, which the edit changes in place. */
function part(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) throw new Error(`The stored record has no ${key} part`);
	return value;
}

/** Edits the spawn spec of every `session_init` of `file` in place, as a writer of the session store does. */
async function editStoredSpec(file: string, edit: (spec: Record<string, unknown>) => void): Promise<number> {
	const lines = (await Bun.file(file).text()).split("\n");
	let changed = 0;
	const rewritten = lines.map(line => {
		if (!line.includes('"session_init"')) return line;
		const record: unknown = JSON.parse(line);
		if (!isRecord(record) || record.type !== "session_init" || !isRecord(record.spawnSpec)) return line;
		edit(record.spawnSpec);
		changed++;
		return JSON.stringify(record);
	});
	await Bun.write(file, rewritten.join("\n"));
	return changed;
}

/** A test process with a live root parent and the cold reviver over it, with `id` spawned by the root and parked. */
async function spawnAndPark(
	id: string,
	settings: Readonly<Record<string, unknown>> = {},
): Promise<{ env: ReviveEnv; root: LiveParent; sessionFile: string }> {
	const env = await openReviveEnv(settings);
	const root = env.createLiveParent();
	env.installColdReviver(root);
	const spawned = await env.spawn({ ...spawnerOptions(root.toolSession), ...env.subagentInputs(id) });
	await env.park(id);
	return { env, root, sessionFile: spawned.sessionFile };
}

/** A cold revive of `id` through the lifecycle, or the error it failed with. */
async function reviveCold(env: ReviveEnv, id: string): Promise<{ revived?: RevivedSubagent; failure?: string }> {
	env.dropWarmReviver(id);
	try {
		return { revived: await env.revive(id) };
	} catch (error) {
		return { failure: error instanceof Error ? error.message : String(error) };
	}
}

describe("a cold revive of a record whose stored depth, cwd, credential source, roots, prompt id and settings were edited", () => {
	const id = "StoredPolicy";
	let env: ReviveEnv | undefined;
	let root: LiveParent | undefined;
	let revived: RevivedSubagent | undefined;
	let failure: string | undefined;
	let warn: Mock<typeof logger.warn> | undefined;
	let elsewhere = "";
	let changed = 0;
	let wakeFrames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await spawnAndPark(id, { "task.maxRecursionDepth": 2 });
		env = opened.env;
		root = opened.root;
		const frames = recordFrames(env.eventBus);
		elsewhere = path.join(env.root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		changed = await editStoredSpec(opened.sessionFile, spec => {
			const policy = part(spec, "policy");
			policy.taskDepth = 0;
			policy.cwd = elsewhere;
			policy.credentialSourceSessionId = STOLEN_CREDENTIAL_SOURCE;
			policy.additionalDirectories = [elsewhere];
			part(spec, "prompt").id = IMPOSTOR;
			part(part(part(spec, "settings"), "layers"), "overrides").task = { maxRecursionDepth: 5 };
		});
		warn = vi.spyOn(logger, "warn");
		({ revived, failure } = await reviveCold(env, id));
		if (!revived) return;
		// The turn's frames are read whichever id they carry.
		const from = frames.length;
		await env.wake(revived.session, id);
		await nextTurn(frames, undefined, from);
		wakeFrames = frames.slice(from);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the edit reached every session_init of the record, and the revive built the subagent", () => {
		expect(changed).toBeGreaterThan(0);
		expect(failure).toBeUndefined();
	});

	it("taskDepth: the depth of the live parent chain, not the stored 0", () => {
		expect(revived?.build.options.taskDepth).toBe(1);
	});

	it("policy.credentialSourceSessionId: the live parent's", () => {
		expect(revived?.build.options.credentialSourceSessionId).toBe(root?.toolSession.getCredentialSourceSessionId?.());
		expect(revived?.build.options.credentialSourceSessionId).not.toBe(STOLEN_CREDENTIAL_SOURCE);
	});

	it("policy.cwd: discovery runs at the live root's cwd", () => {
		expect(revived?.build.options.cwd).toBe(env?.cwd);
	});

	it("policy.additionalDirectories: the live parent's", () => {
		expect(revived?.build.options.additionalDirectories).toEqual(root?.toolSession.additionalDirectories);
	});

	it("settings: a stored value no spawn writes reads through to the live parent, with a warning naming the subagent", () => {
		const settings = revived?.build.options.settings;
		if (!settings || !warn) throw new Error(`The revive built no session: ${failure}`);
		expect(cfgTaskMaxRecursionDepth.get(settings)).toBe(2);
		expect(JSON.stringify(revived?.build.settingsLayers)).not.toContain("maxRecursionDepth");
		const named = warn.mock.calls.filter(
			([message, fields]) => message.includes("no spawn writes") && isRecord(fields) && fields.subagent === id,
		);
		expect(named.length).toBeGreaterThan(0);
	});

	it("prompt.id: the wake turn's frames carry the registry ref's id", () => {
		expect(wakeFrames.some(frame => frame.id === id)).toBe(true);
		expect(wakeFrames.filter(frame => frame.id === IMPOSTOR)).toEqual([]);
	});
});

describe("a cold revive of a record whose stored wake.artifactsDir was edited", () => {
	const id = "StoredArtifacts";
	let env: ReviveEnv | undefined;
	let failure: string | undefined;
	let elsewhere = "";
	let own = "";

	beforeAll(async () => {
		const opened = await spawnAndPark(id);
		env = opened.env;
		const frames = recordFrames(env.eventBus);
		elsewhere = path.join(env.root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		await editStoredSpec(opened.sessionFile, spec => {
			part(spec, "wake").artifactsDir = elsewhere;
		});
		const cold = await reviveCold(env, id);
		failure = cold.failure;
		if (!cold.revived) return;
		// The spawn's run wrote its output here; the wake turn's output must be written again.
		own = path.join(env.artifactsDir, `${id}.md`);
		await fs.rm(own, { force: true });
		// A wake turn that yields writes its output to the run's artifacts dir.
		env.turns = { ...env.turns, wakeToolCall: { name: "yield", arguments: env.turns.yieldArguments } };
		const from = frames.length;
		await env.wake(cold.revived.session, id);
		await nextTurn(frames, id, from);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("wake.artifactsDir: the wake turn's output goes to the ref's own dir, never the stored one", async () => {
		expect(failure).toBeUndefined();
		expect(await fs.readdir(elsewhere)).toEqual([]);
		expect(await Bun.file(own).exists()).toBe(true);
	});
});

describe("a cold revive of a record whose stored identity.agentId was edited", () => {
	const id = "StoredAgentId";
	let env: ReviveEnv | undefined;
	let revived: RevivedSubagent | undefined;
	let failure: string | undefined;

	beforeAll(async () => {
		const opened = await spawnAndPark(id);
		env = opened.env;
		await editStoredSpec(opened.sessionFile, spec => {
			part(spec, "identity").agentId = IMPOSTOR;
		});
		({ revived, failure } = await reviveCold(env, id));
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("identity.agentId: the subagent revives as the registry ref's id", () => {
		expect(failure).toBeUndefined();
		expect(revived?.build.options.agentId).toBe(id);
	});
});

describe("a cold revive of a record whose stored identity.parentAgentId and identity.parentTaskPrefix were edited", () => {
	const id = "StoredParent";
	let env: ReviveEnv | undefined;
	let revived: RevivedSubagent | undefined;
	let failure: string | undefined;

	beforeAll(async () => {
		const opened = await spawnAndPark(id);
		env = opened.env;
		await editStoredSpec(opened.sessionFile, spec => {
			const identity = part(spec, "identity");
			identity.parentAgentId = IMPOSTOR_PARENT;
			identity.parentTaskPrefix = "";
		});
		({ revived, failure } = await reviveCold(env, id));
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("identity.parentAgentId: the registry ref's parent", () => {
		expect(failure).toBeUndefined();
		expect(AgentRegistry.global().get(id)?.parentId).toBe(MAIN_AGENT_ID);
		expect(revived?.build.options.parentAgentId).toBe(MAIN_AGENT_ID);
	});

	it("identity.parentTaskPrefix: the registry ref's id", () => {
		expect(failure).toBeUndefined();
		expect(revived?.build.options.parentTaskPrefix).toBe(id);
	});
});

describe("a cold revive of a record whose stored wake limit was edited to none, the live task.maxRuntimeMs 2000", () => {
	const id = "StoredNoLimit";
	let env: ReviveEnv | undefined;
	let frames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await spawnAndPark(id, { "task.maxRuntimeMs": 2_000 });
		env = opened.env;
		frames = recordFrames(env.eventBus);
		await editStoredSpec(opened.sessionFile, spec => {
			part(spec, "wake").maxRuntimeMs = 0;
		});
		env.dropWarmReviver(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("wake.maxRuntimeMs: the woken turn ends at the live limit, and omp logs it", async () => {
		if (!env) throw new Error("The test process did not start");
		const warn = vi.spyOn(logger, "warn");
		env.respond = holdWake;
		const from = frames.length;
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		expect(receipt.outcome).toBe("revived");
		const turn = await nextTurn(frames, id, from);
		expect(turn.ended?.status).toBe("aborted");
		const elapsed = (turn.ended?.at ?? Number.POSITIVE_INFINITY) - turn.started.at;
		expect(elapsed).toBeGreaterThanOrEqual(2_000);
		expect(elapsed).toBeLessThanOrEqual(10_000);
		const logged = warn.mock.calls.some(
			([message, fields]) =>
				message === LIMIT_WARNING && isRecord(fields) && fields.id === id && fields.maxRuntimeMs === 2_000,
		);
		expect(logged).toBe(true);
	}, 30_000);
});

describe("a cold revive of a record whose stored soft request budget was edited to none, the live budget 1", () => {
	const id = "StoredNoBudget";
	let env: ReviveEnv | undefined;
	let frames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await spawnAndPark(id);
		env = opened.env;
		frames = recordFrames(env.eventBus);
		await editStoredSpec(opened.sessionFile, spec => {
			part(spec, "wake").softRequestBudget = 0;
		});
		cfgTaskSoftRequestBudget.override(env.settings, 1);
		// The woken turn calls a tool, so it sends a second request after its first.
		env.turns = { ...env.turns, wakeToolCall: { name: "read", arguments: { path: "CONTEXT.md" } } };
		env.dropWarmReviver(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("wake.softRequestBudget: the woken turn gets the live budget's notice", async () => {
		if (!env) throw new Error("The test process did not start");
		const from = env.requests.length;
		const sentFrom = frames.length;
		const receipt = await IrcBus.global().send({ from: MAIN_AGENT_ID, to: id, body: WAKE_BODY });
		expect(receipt.outcome).toBe("revived");
		await nextTurn(frames, id, sentFrom);
		const notified = env.requests
			.slice(from)
			.some(request => userTexts(request).some(text => text.includes(BUDGET_NOTICE)));
		expect(notified).toBe(true);
	}, 30_000);
});
