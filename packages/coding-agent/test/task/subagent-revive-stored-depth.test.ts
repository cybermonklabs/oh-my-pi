/**
 * The task depth of a subagent that a cold revive brings back is held to the live parent chain. A stored
 * record that claims a lower depth (a writer of the session store) does not lift `task.maxRecursionDepth`:
 * the revived subagent gets no spawn capacity that the live chain withholds.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { openReviveEnv, type RevivedSubagent, type ReviveEnv, spawnerOptions } from "./revive-harness";

/** Rewrites every `session_init` of `file`: the stored task depth set to `depth`, spawns "*", and "task" in the stored tool names. */
async function claimDepth(file: string, depth: number): Promise<number> {
	const lines = (await Bun.file(file).text()).split("\n");
	let changed = 0;
	const rewritten = lines.map(line => {
		if (!line.includes('"session_init"')) return line;
		const record: unknown = JSON.parse(line);
		if (!isRecord(record) || record.type !== "session_init" || !isRecord(record.spawnSpec)) return line;
		const { policy, tools } = record.spawnSpec;
		if (!isRecord(policy) || !isRecord(tools)) return line;
		policy.taskDepth = depth;
		policy.spawns = "*";
		if (Array.isArray(tools.toolNames) && !tools.toolNames.includes("task")) tools.toolNames.push("task");
		changed++;
		return JSON.stringify(record);
	});
	await Bun.write(file, rewritten.join("\n"));
	return changed;
}

describe("a cold revive under task.maxRecursionDepth 1 of a subagent the root spawned", () => {
	let env: ReviveEnv | undefined;
	let untouched: RevivedSubagent | undefined;
	let claimed: RevivedSubagent | undefined;
	let changed = 0;

	beforeAll(async () => {
		env = await openReviveEnv({ "task.maxRecursionDepth": 1 });
		const root = env.createLiveParent();
		env.installColdReviver(root);
		for (const id of ["DepthKept", "DepthClaimed"]) {
			await env.spawn({ ...spawnerOptions(root.toolSession), ...env.subagentInputs(id) });
			await env.park(id);
		}
		changed = await claimDepth(path.join(env.artifactsDir, "DepthClaimed.jsonl"), 0);
		env.dropWarmReviver("DepthKept");
		untouched = await env.revive("DepthKept");
		env.dropWarmReviver("DepthClaimed");
		claimed = await env.revive("DepthClaimed");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("revives at depth 1 with no task tool", () => {
		expect(untouched?.build.options.taskDepth).toBe(1);
		expect(untouched?.session.getAllToolNames()).not.toContain("task");
	});

	it("revives at depth 1 with no task tool when its stored record claims depth 0", () => {
		expect(changed).toBeGreaterThan(0);
		expect(claimed?.build.options.taskDepth).toBe(1);
		expect(claimed?.session.getAllToolNames()).not.toContain("task");
	});
});
