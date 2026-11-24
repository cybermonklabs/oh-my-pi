/**
 * A subagent whose session started on a startup fallback: the model its spawn requested matched no available
 * model, and that model's own `retry.fallbackChains` entry chose another. Revived warm and revived cold, it runs on
 * the model its session started on, and each run after a revive reports that model as a fallback with the reason
 * the spawn's run gave. The requested model becomes available before the revives, and neither revive moves to it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type ExecutorOptions, runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { readSpawnSpec, type SpawnSpecStartupFallback } from "@oh-my-pi/pi-coding-agent/task/spawn-spec";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { fixtureAgent, openReviveEnv, type ReviveEnv, SPAWN_MODEL, spawnerOptions } from "./revive-harness";

/** The model the spawn requests: no model at spawn, a scripted model from the revives on. */
const REQUESTED_MODEL = "mock/mock-requested";
const ID = "StartupFallback";

/** A run after a revive, and the models its requests went to. */
interface RevivedRun {
	result: SingleResult;
	requestModels: string[];
}

/** One more monitored turn of `ID`, which revives it through the lifecycle (warm while its reviver is adopted). */
async function runAfterRevive(env: ReviveEnv): Promise<RevivedRun> {
	const first = env.requests.length;
	const result = await runSubagentFollowUpTurn({
		id: ID,
		agent: fixtureAgent(),
		message: "Report one more row.",
		structured: false,
		storeMaskCwd: env.cwd,
	});
	return { result, requestModels: env.requests.slice(first).map(request => request.model) };
}

describe("a subagent spawned on a startup fallback", () => {
	let env: ReviveEnv | undefined;
	let spawn: SingleResult | undefined;
	let stored: SpawnSpecStartupFallback | undefined;
	let warm: RevivedRun | undefined;
	let cold: RevivedRun | undefined;

	beforeAll(async () => {
		env = await openReviveEnv({ "retry.fallbackChains": { [REQUESTED_MODEL]: [SPAWN_MODEL] } });
		const root = env.createLiveParent();
		env.installColdReviver(root);
		const options: ExecutorOptions = {
			...spawnerOptions(root.toolSession),
			...env.subagentInputs(ID),
			modelOverride: REQUESTED_MODEL,
		};
		spawn = await runSubprocess(options);
		if (spawn.exitCode !== 0) throw new Error(`Spawn of ${ID} failed: ${spawn.error ?? spawn.stderr}`);
		const init = (await SessionManager.peekSessionInit(path.join(env.artifactsDir, `${ID}.jsonl`)))?.init;
		if (!init) throw new Error(`${ID} stored no session_init`);
		stored = readSpawnSpec(init).startupFallback;
		// The requested model can serve from now on; a revive starts on the model the session started on.
		env.addModel("mock-requested");
		await env.park(ID);
		warm = await runAfterRevive(env);
		await env.park(ID);
		env.dropWarmReviver(ID);
		cold = await runAfterRevive(env);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the spawn's run reports its startup fallback, and its spawn spec stores the fallback's model and reason", () => {
		if (!spawn) throw new Error("The test process did not start");
		expect(spawn.resolvedModel).toBe(SPAWN_MODEL);
		expect(spawn.resolvedModelIsFallback).toBe(true);
		expect(spawn.resolvedModelFallbackReason).toContain(
			`retry.fallbackChains["${REQUESTED_MODEL}"] chose the replacement`,
		);
		expect(stored?.model).toBe(SPAWN_MODEL);
		expect(stored?.reason).toBe(spawn.resolvedModelFallbackReason);
	}, 30_000);

	it("warm revive: the run starts on the fallback model, not the requested one, and reports the fallback with the spawn's reason", () => {
		if (!spawn || !warm) throw new Error("The test process did not start");
		expect(warm.result.exitCode).toBe(0);
		expect(warm.requestModels.length).toBeGreaterThan(0);
		expect(new Set(warm.requestModels)).toEqual(new Set([SPAWN_MODEL]));
		expect(warm.result.resolvedModel).toBe(spawn.resolvedModel);
		expect(warm.result.resolvedModelIsFallback).toBe(true);
		expect(warm.result.resolvedModelFallbackReason).toBe(spawn.resolvedModelFallbackReason);
	}, 30_000);

	it("cold revive: the run starts on the fallback model, not the requested one, and reports the fallback with the spawn's reason", () => {
		if (!spawn || !cold) throw new Error("The test process did not start");
		expect(cold.result.exitCode).toBe(0);
		expect(cold.requestModels.length).toBeGreaterThan(0);
		expect(new Set(cold.requestModels)).toEqual(new Set([SPAWN_MODEL]));
		expect(cold.result.resolvedModel).toBe(spawn.resolvedModel);
		expect(cold.result.resolvedModelIsFallback).toBe(true);
		expect(cold.result.resolvedModelFallbackReason).toBe(spawn.resolvedModelFallbackReason);
	}, 30_000);
});
