/**
 * A subagent's artifacts directory sits beside its parent's transcript, on the parent's store. Under the
 * file store that location is the session store itself, so a location that refuses writes must not
 * fail the launch: the directory is made by the first write that needs it, once it can be.
 */
import { afterEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runStructuredSubagent } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read"],
};

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function parentSession(sessionFile: string): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		settings: Settings.isolated({ "task.maxRecursionDepth": 2, "task.isolation.enabled": false }),
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getSessionAgents: () => [],
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
}

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

/** Launches one subagent of `sessionFile`'s session; its run makes `beforeRun`'s change, then writes its output artifact. */
async function launch(sessionFile: string, beforeRun: () => Promise<void>) {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [AGENT], projectAgentsDir: null });
	const dispatched: executorModule.ExecutorOptions[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		dispatched.push(options);
		await beforeRun();
		await writeArtifact(path.join(options.artifactsDir as string, `${options.id}.md`), "done");
		return result(options.id);
	});
	const settled = await runStructuredSubagent({
		session: parentSession(sessionFile),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		retainArtifacts: true,
	});
	return { settled, dispatched };
}

it("launches a subagent whose parent's session directory refuses writes, and its artifacts land once it accepts them", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refused-artifacts-"));
	roots.push(root);
	const store = path.join(root, "store");
	// Dangling until the run: nothing can be made under it.
	await fs.symlink(store, path.join(root, "sessions"), "dir");
	const parentFile = path.join(root, "sessions", "parent.jsonl");

	const { settled, dispatched } = await launch(parentFile, () => fs.mkdir(store));

	expect(settled.result.exitCode).toBe(0);
	expect(dispatched).toHaveLength(1);
	expect(dispatched[0]?.artifactsDir).toBe(path.join(root, "sessions", "parent"));
	expect(await fs.readFile(path.join(store, "parent", `${dispatched[0]?.id}.md`), "utf8")).toBe("done");
});

it("control: a subagent of a parent whose session directory accepts writes launches and keeps its artifacts, as before", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refused-artifacts-"));
	roots.push(root);
	await fs.mkdir(path.join(root, "sessions"));
	const parentFile = path.join(root, "sessions", "parent.jsonl");

	const { settled, dispatched } = await launch(parentFile, async () => {});

	expect(settled.result.exitCode).toBe(0);
	expect(dispatched[0]?.artifactsDir).toBe(path.join(root, "sessions", "parent"));
	expect(await fs.readFile(path.join(root, "sessions", "parent", `${dispatched[0]?.id}.md`), "utf8")).toBe("done");
});
