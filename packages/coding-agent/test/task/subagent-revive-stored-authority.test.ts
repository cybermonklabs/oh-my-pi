/**
 * A stored spawn spec never widens what the live process allows. A writer of the session store edits a parked
 * subagent's stored record (its ids, depth, cwd, credential source, workspace roots, cache-warming value, prompt id,
 * artifacts dir, settings overlay, list of live inputs and wake limits, and the workspace roots of its file's
 * header); the cold revive builds the subagent from the live values instead: the depth of the live parent chain,
 * the ids of the registry ref, the live parent's credential source, roots, cost gate and extensions, discovery at
 * the live root's cwd, the constants every spawn writes, and limits no looser than the live settings.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { cfgTaskMaxRecursionDepth, cfgTaskSoftRequestBudget } from "@oh-my-pi/pi-coding-agent/task/settings";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	expectEndedAtLimit,
	heldTurn,
	holdWake,
	type LifecycleFrame,
	type LiveParent,
	limitLogged,
	openReviveEnv,
	type RevivedSubagent,
	type ReviveEnv,
	recordFrames,
	spawnerOptions,
	userTexts,
	WAKE_BODY,
} from "./revive-harness";

/** The id, parent id and prompt id the edited record claims. */
const IMPOSTOR = "Impostor";
const IMPOSTOR_PARENT = "ImpostorParent";
/** The credential source the edited record claims. */
const STOLEN_CREDENTIAL_SOURCE = "stolen-credential-source";
/** The text of the steering notice a run gets once it reaches its soft request budget. */
const BUDGET_NOTICE = "[budget notice]";

/** The `key` part of a stored record, which the edit changes in place. */
function part(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) throw new Error(`The stored record has no ${key} part`);
	return value;
}

/** Edits every line of `file` that `edit` changes, as a writer of the session store does; counts the lines changed. */
async function editRecords(file: string, edit: (record: Record<string, unknown>) => boolean): Promise<number> {
	const lines = (await Bun.file(file).text()).split("\n");
	let changed = 0;
	const rewritten = lines.map(line => {
		if (line.trim() === "") return line;
		const record: unknown = JSON.parse(line);
		if (!isRecord(record) || !edit(record)) return line;
		changed++;
		return JSON.stringify(record);
	});
	await Bun.write(file, rewritten.join("\n"));
	return changed;
}

/** Edits the spawn spec of every `session_init` of `file` in place. */
function editStoredSpec(file: string, edit: (spec: Record<string, unknown>) => void): Promise<number> {
	return editRecords(file, record => {
		if (record.type !== "session_init" || !isRecord(record.spawnSpec)) return false;
		edit(record.spawnSpec);
		return true;
	});
}

/** Sets the workspace roots the header of `file` holds. */
function editHeaderRoots(file: string, roots: string[]): Promise<number> {
	return editRecords(file, record => {
		if (record.type !== "session") return false;
		record.additionalDirectories = roots;
		return true;
	});
}

/**
 * A test process with a live root parent and the cold reviver over it, with `id` spawned by the root and parked;
 * `prepare` runs on the root before the spawn.
 */
async function spawnAndPark(
	id: string,
	settings: Readonly<Record<string, unknown>> = {},
	prepare?: (env: ReviveEnv, root: LiveParent) => void,
): Promise<{ env: ReviveEnv; root: LiveParent; sessionFile: string }> {
	const env = await openReviveEnv(settings);
	const root = env.createLiveParent();
	env.installColdReviver(root);
	prepare?.(env, root);
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

describe("a cold revive of a record whose stored depth, cwd, credential source, roots, cache warming, prompt id and settings, and whose header's roots, were edited", () => {
	const id = "StoredPolicy";
	let env: ReviveEnv | undefined;
	let root: LiveParent | undefined;
	let revived: RevivedSubagent | undefined;
	let failure: string | undefined;
	let warn: Mock<typeof logger.warn> | undefined;
	let changed = 0;
	let wakeFrames: LifecycleFrame[] = [];

	beforeAll(async () => {
		const opened = await spawnAndPark(id, { "task.maxRecursionDepth": 2 });
		env = opened.env;
		root = opened.root;
		const frames = recordFrames(env.eventBus);
		const elsewhere = path.join(env.root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		changed = await editStoredSpec(opened.sessionFile, spec => {
			const policy = part(spec, "policy");
			policy.taskDepth = 0;
			policy.cwd = elsewhere;
			policy.credentialSourceSessionId = STOLEN_CREDENTIAL_SOURCE;
			policy.additionalDirectories = [elsewhere];
			policy.cacheWarming = true;
			part(spec, "prompt").id = IMPOSTOR;
			part(part(part(spec, "settings"), "layers"), "overrides").task = { maxRecursionDepth: 5 };
		});
		await editHeaderRoots(opened.sessionFile, [elsewhere]);
		warn = vi.spyOn(logger, "warn");
		({ revived, failure } = await reviveCold(env, id));
		if (!revived) return;
		// The turn's frames are read whichever id they carry.
		const from = frames.length;
		await env.wake(revived.session, id);
		await heldTurn(frames, undefined, from);
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

	it("the header's additionalDirectories: the session holds only the live parent's roots", () => {
		expect(revived?.session.sessionManager.getAdditionalDirectories()).toEqual(
			root?.toolSession.additionalDirectories,
		);
	});

	it("policy.cacheWarming: the constant every spawn writes, false", () => {
		expect(revived?.build.options.cacheWarming).toBe(false);
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

describe("a cold revive of a record whose stored list of live inputs leaves out the cost gate and the prepared extensions", () => {
	const id = "StoredLiveInputs";
	let env: ReviveEnv | undefined;
	let root: LiveParent | undefined;
	let revived: RevivedSubagent | undefined;
	let failure: string | undefined;

	beforeAll(async () => {
		const opened = await spawnAndPark(id, {}, (opening, parent) => {
			// The tree's cost gate, which every spawner passes on.
			parent.toolSession.costGate = new CostGate(opening.settings, 0, () => {});
		});
		env = opened.env;
		root = opened.root;
		await editStoredSpec(opened.sessionFile, spec => {
			const names = Array.isArray(spec.liveInputs) ? spec.liveInputs : [];
			spec.liveInputs = names.filter(name => name !== "costGate" && name !== "preloadedPreparedExtensions");
		});
		({ revived, failure } = await reviveCold(env, id));
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("costGate: the tree's, so the live session.maxCost still holds", () => {
		expect(failure).toBeUndefined();
		expect(root?.toolSession.costGate).toBeDefined();
		expect(revived?.build.options.costGate).toBe(root?.toolSession.costGate);
	});

	it("preloadedPreparedExtensions: the live parent's, so the revive discovers no extensions of its own", () => {
		expect(failure).toBeUndefined();
		expect(revived?.build.options.preloadedPreparedExtensions).toBe(root?.toolSession.preparedExtensions);
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
		await heldTurn(frames, id, from);
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
		expectEndedAtLimit(await heldTurn(frames, id, from), 2_000);
		expect(limitLogged(warn, id, 2_000)).toBe(true);
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
		await heldTurn(frames, id, sentFrom);
		const notified = env.requests
			.slice(from)
			.some(request => userTexts(request).some(text => text.includes(BUDGET_NOTICE)));
		expect(notified).toBe(true);
	}, 30_000);
});
