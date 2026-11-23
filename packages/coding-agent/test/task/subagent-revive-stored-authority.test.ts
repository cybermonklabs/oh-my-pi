/**
 * A stored spawn spec never widens what the live process allows. A writer of the session store edits a parked
 * subagent's stored record (its ids, depth, cwd, credential source, workspace roots, cache-warming value, prompt id,
 * artifacts dir, settings overlay, list of live inputs and wake limits, the shape of its policy part, and the
 * workspace roots of its file's header); the cold revive builds the subagent from the live values instead: the
 * depth of the live parent chain, the ids of the registry ref, the live parent's credential source, roots, cost
 * gate and extensions, the constants every spawn writes, and limits no looser than the live settings. It builds in
 * the cwd of its file's header, where its tools run, not the cwd of the edited policy. A revive writes the header's
 * workspace roots once, as the roots its session uses, so a warm revive rewrites no file for unchanged roots and a
 * root the run took from the live settings stays.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { cfgWorkspaceAdditionalDirectories } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { cfgTaskMaxRecursionDepth, cfgTaskSoftRequestBudget } from "@oh-my-pi/pi-coding-agent/task/settings";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { localSession } from "../helpers/local-session";
import {
	editSessionRecords,
	editStoredSpawnSpecs,
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

/** Sets the workspace roots the header of `file` holds. */
function editHeaderRoots(file: string, roots: string[]): Promise<number> {
	return editSessionRecords(file, record => {
		if (record.type !== "session") return false;
		record.additionalDirectories = roots;
		return true;
	});
}

/**
 * A test process with a live root parent and the cold reviver over it, with `id` spawned by the root and parked;
 * `prepare` runs on the root before the spawn, `beforePark` between the spawn and the park.
 */
async function spawnAndPark(
	id: string,
	settings: Readonly<Record<string, unknown>> = {},
	prepare?: (env: ReviveEnv, root: LiveParent) => void,
	beforePark?: (env: ReviveEnv, root: LiveParent) => Promise<void>,
): Promise<{ env: ReviveEnv; root: LiveParent; sessionFile: string }> {
	const env = await openReviveEnv(settings);
	const root = env.createLiveParent();
	env.installColdReviver(root);
	prepare?.(env, root);
	const spawned = await env.spawn({ ...spawnerOptions(root.toolSession), ...env.subagentInputs(id) });
	await beforePark?.(env, root);
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

/** Counts, from now on, the whole-file rewrites of `file` through the session storage the session manager writes by. */
function countRewrites(file: string): () => number {
	const lines = vi.spyOn(FileSessionStorage.prototype, "writeLinesAtomic");
	const text = vi.spyOn(FileSessionStorage.prototype, "writeTextAtomic");
	const target = path.resolve(file);
	return () => {
		const written = [...lines.mock.calls, ...text.mock.calls].map(([fpath]) => path.resolve(fpath));
		return written.filter(fpath => fpath === target).length;
	};
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
	let elsewhere = "";

	beforeAll(async () => {
		const opened = await spawnAndPark(id, { "task.maxRecursionDepth": 2 });
		env = opened.env;
		root = opened.root;
		const frames = recordFrames(env.eventBus);
		elsewhere = path.join(env.root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		changed = await editStoredSpawnSpecs(opened.sessionFile, spec => {
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

	it("policy.cwd: the build runs in the stored session's cwd, where its tools run, never the stored policy's", () => {
		expect(revived?.build.options.cwd).toBe(revived?.session.sessionManager.getCwd());
		expect(revived?.build.options.cwd).toBe(env?.cwd);
		expect(revived?.build.options.cwd).not.toBe(elsewhere);
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

describe("a cold revive of a record whose stored list of live inputs leaves out costGate and preloadedPreparedExtensions", () => {
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
		await editStoredSpawnSpecs(opened.sessionFile, spec => {
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

	it("preloadedPreparedExtensions: the live parent's, whatever the list names, so the revive discovers no extensions of its own", () => {
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
		await editStoredSpawnSpecs(opened.sessionFile, spec => {
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
		await editStoredSpawnSpecs(opened.sessionFile, spec => {
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
		await editStoredSpawnSpecs(opened.sessionFile, spec => {
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
		await editStoredSpawnSpecs(opened.sessionFile, spec => {
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
		await editStoredSpawnSpecs(opened.sessionFile, spec => {
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

describe("a cold revive of a record whose stored policy part has a shape no spawn writes, and whose header's roots were edited", () => {
	const id = "MalformedPolicy";
	let env: ReviveEnv | undefined;
	let revived: RevivedSubagent | undefined;
	let failure: string | undefined;
	let changed = 0;
	let elsewhere = "";

	beforeAll(async () => {
		const opened = await spawnAndPark(id, { "providers.cacheWarming": "idle" });
		env = opened.env;
		elsewhere = path.join(env.root, "elsewhere");
		await fs.mkdir(elsewhere, { recursive: true });
		changed = await editStoredSpawnSpecs(opened.sessionFile, spec => {
			part(spec, "policy").taskDepth = "x";
		});
		await editHeaderRoots(opened.sessionFile, [elsewhere]);
		({ revived, failure } = await reviveCold(env, id));
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the edit reached every session_init of the record, and the revive built the subagent", () => {
		expect(changed).toBeGreaterThan(0);
		expect(failure).toBeUndefined();
	});

	it("policy.cacheWarming: the constant every spawn writes, false, so the session holds no cache warmer", () => {
		expect(revived?.build.options.cacheWarming).toBe(false);
		expect(revived?.session.cacheWarmingStatus).toBeUndefined();
	});

	it("the header's additionalDirectories: a root only the header holds is not kept", () => {
		if (!revived) throw new Error(`The revive built no session: ${failure}`);
		expect(revived.session.sessionManager.getAdditionalDirectories()).not.toContain(elsewhere);
	});
});

describe("a warm revive of a subagent whose spawner has a workspace root", () => {
	const id = "WarmRoots";
	let env: ReviveEnv | undefined;
	let root: LiveParent | undefined;
	let rewrites = -1;
	let roots: string[] = [];

	beforeAll(async () => {
		const opened = await spawnAndPark(id);
		env = opened.env;
		root = opened.root;
		const rewritten = countRewrites(opened.sessionFile);
		const revived = await env.revive(id);
		rewrites = rewritten();
		roots = revived.session.sessionManager.getAdditionalDirectories();
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("rewrites the whole session file zero times for its roots, and the session holds the spawner's root", () => {
		expect(root?.toolSession.additionalDirectories?.length).toBeGreaterThan(0);
		expect(roots).toEqual(root?.toolSession.additionalDirectories ?? []);
		expect(rewrites).toBe(0);
	});
});

describe("a root the live workspace.additionalDirectories setting gained during the subagent's run", () => {
	const id = "LiveSettingRoot";
	let env: ReviveEnv | undefined;
	let added = "";
	let warmRoots: string[] = [];
	let coldRoots: string[] = [];
	let failure: string | undefined;

	beforeAll(async () => {
		const opened = await spawnAndPark(id, {}, undefined, async opening => {
			added = path.join(opening.root, "added");
			await fs.mkdir(added, { recursive: true });
			// The subagent's session follows a live edit of the setting into its file's header.
			const live = localSession(AgentRegistry.global().get(id)?.session);
			const followed = Promise.withResolvers<void>();
			const addRoot = live.sessionManager.addWorkspaceDirectory.bind(live.sessionManager);
			vi.spyOn(live.sessionManager, "addWorkspaceDirectory").mockImplementation(async directory => {
				const resolved = await addRoot(directory);
				if (live.sessionManager.getAdditionalDirectories().includes(added)) followed.resolve();
				return resolved;
			});
			cfgWorkspaceAdditionalDirectories.override(opening.settings, [added]);
			await followed.promise;
		});
		env = opened.env;
		const warm = await env.revive(id);
		warmRoots = warm.session.sessionManager.getAdditionalDirectories();
		await env.park(id);
		const cold = await reviveCold(env, id);
		failure = cold.failure;
		coldRoots = cold.revived?.session.sessionManager.getAdditionalDirectories() ?? [];
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("is still a root of the warm-revived session while the setting holds it", () => {
		expect(warmRoots).toContain(added);
	});

	it("is still a root of the cold-revived session while the setting holds it", () => {
		expect(failure).toBeUndefined();
		expect(coldRoots).toContain(added);
	});
});
