/**
 * A cold revive arms the spawn's prewalk target only where the spawn would arm it: a target whose provider
 * lost its credential while the subagent was parked is skipped, with a warning that names it.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { fixtureAgent, openReviveEnv, type RevivedSubagent, type ReviveEnv, spawnerOptions } from "./revive-harness";

const PROVIDER = "mock-credential";
const TARGET = `${PROVIDER}/mock-credential-prewalk`;

describe("a prewalk target whose provider lost its credential between the park and the revive", () => {
	const id = "PrewalkCredentialGone";
	let env: ReviveEnv | undefined;
	let cold: RevivedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;
	let armedAtSpawn: string | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.installColdReviver(root);
		env.scriptDiscovery();
		env.addModel("mock-credential-prewalk", { provider: PROVIDER });
		const agent = fixtureAgent({ prewalk: TARGET });
		await env.spawn({ ...spawnerOptions(root.toolSession), ...env.subagentInputs(id, agent) });
		const spawnBuild = env.builds.find(build => build.options.agentId === id);
		const armed = spawnBuild?.options.prewalk;
		armedAtSpawn = armed ? formatModelStringWithRouting(armed.target) : undefined;
		await env.park(id);
		env.dropWarmReviver(id);
		env.authStorage.keys.removeRuntime(PROVIDER);
		warn = vi.spyOn(logger, "warn");
		cold = await env.revive(id);
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the spawn armed it, and the cold revive does not, and omp logs that it was skipped", () => {
		if (!cold || !warn) throw new Error("The test process did not start");
		expect(armedAtSpawn).toBe(TARGET);
		expect(cold.build.options.prewalk).toBeUndefined();
		const skipped = warn.mock.calls.filter(([, fields]) => isRecord(fields) && fields.subagent === id);
		expect(skipped.map(([, fields]) => (isRecord(fields) ? fields.target : undefined))).toContain(TARGET);
	});
});
