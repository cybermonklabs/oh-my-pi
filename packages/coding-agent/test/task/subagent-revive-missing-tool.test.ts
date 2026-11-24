/**
 * A cold revive builds a subagent's custom tool again where the live parent's eval kernel
 * can serve it. Where it cannot, the revived subagent keeps the tool in its tool list from the stored
 * descriptor, a call to it answers that the tool is unavailable, the next turn names it to the model, omp
 * logs a warning naming the subagent and the tool, and the revive is never refused for it.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { createEvalCustomTools } from "@oh-my-pi/pi-coding-agent/task/eval-tools";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	type IrcSendResult,
	LOOKUP_TOOL,
	lastToolResult,
	openReviveEnv,
	type ReviveEnv,
	type SpawnedSubagent,
	spawnerOptions,
	userTexts,
} from "./revive-harness";

/** The call a woken subagent makes to its custom tool. */
const LOOKUP_CALL = { name: LOOKUP_TOOL.name, arguments: { key: "a" } };

/** An eval spawn (`agent()`) of subagent `id` by `parent`, with the custom tool unless `withTool` is false. */
function evalSpawn(env: ReviveEnv, parent: ToolSession, id: string, withTool = true): ExecutorOptions {
	return {
		...spawnerOptions(parent),
		...env.subagentInputs(id),
		description: "lookup rows",
		customTools: withTool ? createEvalCustomTools(parent, [LOOKUP_TOOL]) : undefined,
	};
}

function warnings(warn: Mock<typeof logger.warn>): string[] {
	return warn.mock.calls.map(args => Bun.inspect(args));
}

/** The wire entry of the custom tool in a request's tool list, as JSON bytes. */
function lookupToolEntry(tools: string | undefined): string | undefined {
	const entries: unknown = tools === undefined ? [] : JSON.parse(tools);
	const list: unknown[] = Array.isArray(entries) ? entries : [];
	const entry = list.find(tool => isRecord(tool) && tool.name === LOOKUP_TOOL.name);
	return entry === undefined ? undefined : JSON.stringify(entry);
}

/**
 * The revive kept the custom tool as unavailable: the send revived the subagent; the first request carries
 * the held base prompt and, byte for byte, the tool list of the last request before the park, the tool
 * included, with a notice naming the tool; a call to the tool answers that it is unavailable and names it;
 * and omp's log holds a warning naming the subagent and the tool. Where a tool source changed while the
 * subagent was parked (`toolSourceChanged`), only the custom tool's own entry keeps its bytes.
 */
function expectKeptUnavailable(
	sent: IrcSendResult,
	parked: SpawnedSubagent,
	warn: Mock<typeof logger.warn>,
	toolSourceChanged = false,
): void {
	expect(sent.receipt.outcome).toBe("revived");
	const request = sent.request;
	expect(request?.toolNames).toContain(LOOKUP_TOOL.name);
	if (toolSourceChanged) {
		expect(lookupToolEntry(request?.tools)).toBe(lookupToolEntry(parked.lastRequest.tools));
	} else {
		expect(request?.tools).toBe(parked.lastRequest.tools);
	}
	expect(request?.system).toEqual(parked.lastRequest.system);
	const notices = request ? userTexts(request).filter(text => text.includes(LOOKUP_TOOL.name)) : [];
	expect(notices.length).toBeGreaterThan(0);
	const result = sent.session ? lastToolResult(sent.session, LOOKUP_TOOL.name) : undefined;
	expect(result?.isError).toBe(true);
	expect(result?.text).toContain(LOOKUP_TOOL.name);
	expect(result?.text).toMatch(/unavailable/i);
	const named = warnings(warn).filter(text => text.includes(parked.id) && text.includes(LOOKUP_TOOL.name));
	expect(named.length).toBeGreaterThan(0);
}

describe("a custom tool whose parent and eval kernel are live", () => {
	const id = "KernelLive";
	let env: ReviveEnv | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
		env.installColdReviver(root);
		await env.spawn(evalSpawn(env, root.toolSession, id));
		await env.park(id);
		env.dropWarmReviver(id);
		env.turns = { ...env.turns, wakeToolCall: LOOKUP_CALL };
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("an IRC send revives the subagent cold, it calls the custom tool, and the parent's kernel answers", async () => {
		if (!env) throw new Error("The test process did not start");
		const sent = await env.ircSend(id);
		expect(sent.receipt.outcome).toBe("revived");
		const result = sent.session ? lastToolResult(sent.session, LOOKUP_TOOL.name) : undefined;
		expect(result).toEqual({ text: `${LOOKUP_TOOL.name} answered {"key":"a"}`, isError: false });
		expect(env.kernels.calls).toEqual([{ tool: LOOKUP_TOOL.name, args: { key: "a" } }]);
	}, 30_000);
});

describe("a custom tool after the parent resumed in a new lifecycle manager whose kernel does not define it", () => {
	let env: ReviveEnv | undefined;
	let withTool: SpawnedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
		withTool = await env.spawn(evalSpawn(env, root.toolSession, "ToolGone"));
		await env.spawn(evalSpawn(env, root.toolSession, "NoCustomTool", false));
		await env.park("ToolGone");
		await env.park("NoCustomTool");
		// The resumed parent's kernel defines no tool.
		env.restart(env.createLiveParent());
		warn = vi.spyOn(logger, "warn");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the send succeeds, the tool stays in the tool list byte for byte, a notice names it, a call answers it is unavailable, and a warning names the subagent and the tool", async () => {
		if (!env || !withTool || !warn) throw new Error("The test process did not start");
		env.turns = { ...env.turns, wakeToolCall: LOOKUP_CALL };
		expectKeptUnavailable(await env.ircSend("ToolGone"), withTool, warn);
	}, 30_000);

	it("a parked subagent of the same parent with no custom tool revives with no notice", async () => {
		if (!env) throw new Error("The test process did not start");
		env.turns = { yieldArguments: env.turns.yieldArguments };
		const sent = await env.ircSend("NoCustomTool");
		expect(sent.receipt.outcome).toBe("revived");
		const texts = sent.request ? userTexts(sent.request) : [];
		expect(texts.filter(text => text.includes(LOOKUP_TOOL.name) || /unavailable/i.test(text))).toEqual([]);
	}, 30_000);
});

describe("a custom tool of a subagent killed before the send", () => {
	const id = "KilledToolGone";
	let env: ReviveEnv | undefined;
	let spawned: SpawnedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
		spawned = await env.spawn(evalSpawn(env, root.toolSession, id));
		await env.park(id);
		env.restart(env.createLiveParent());
		await env.kill(id);
		warn = vi.spyOn(logger, "warn");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("the send reopens and revives the killed subagent, which keeps the tool as unavailable, with the notice and the warning", async () => {
		if (!env || !spawned || !warn) throw new Error("The test process did not start");
		env.turns = { ...env.turns, wakeToolCall: LOOKUP_CALL };
		expectKeptUnavailable(await env.ircSend(id), spawned, warn);
	}, 30_000);
});

describe("a custom tool of a subagent whose parent ref is parked", () => {
	const parentId = "ParkedParent";
	const id = "ChildOfParked";
	let env: ReviveEnv | undefined;
	let spawned: SpawnedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		// The root's kernel defines the tool, but the subagent's parent is the parked ref, which is not live.
		env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
		env.installColdReviver(root);
		await env.spawn({ ...spawnerOptions(root.toolSession), ...env.subagentInputs(parentId) });
		spawned = await env.spawn({ ...evalSpawn(env, root.toolSession, id), parentAgentId: parentId, taskDepth: 1 });
		await env.park(id);
		await env.park(parentId);
		env.dropWarmReviver(id);
		warn = vi.spyOn(logger, "warn");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("a subagent whose parent ref is parked keeps its custom tool as unavailable, with the notice and the warning", async () => {
		if (!env || !spawned || !warn) throw new Error("The test process did not start");
		env.turns = { ...env.turns, wakeToolCall: LOOKUP_CALL };
		expectKeptUnavailable(await env.ircSend(id), spawned, warn);
	}, 30_000);
});

describe("a custom tool after eval tools were turned off in the live parent", () => {
	const id = "EvalToolsOff";
	let env: ReviveEnv | undefined;
	let spawned: SpawnedSubagent | undefined;
	let warn: Mock<typeof logger.warn> | undefined;

	beforeAll(async () => {
		env = await openReviveEnv();
		const root = env.createLiveParent();
		env.kernels.define(root.toolSession, [LOOKUP_TOOL]);
		spawned = await env.spawn(evalSpawn(env, root.toolSession, id));
		await env.park(id);
		// The resumed parent's kernel still defines the tool, but its settings turn eval tools off.
		const resumed = env.createLiveParent(env.createSettings({ "eval.tools.enabled": false }));
		env.kernels.define(resumed.toolSession, [LOOKUP_TOOL]);
		env.restart(resumed);
		warn = vi.spyOn(logger, "warn");
	}, 60_000);

	afterAll(async () => {
		await env?.close();
	}, 30_000);

	it("with eval tools turned off in the live parent, the revive keeps each custom tool as unavailable and is not refused", async () => {
		if (!env || !spawned || !warn) throw new Error("The test process did not start");
		env.turns = { ...env.turns, wakeToolCall: LOOKUP_CALL };
		// Turning eval tools off is a tool source change: the subagent's own eval and task tools then describe
		// themselves without kernel-defined tools, so only the custom tool's entry keeps its bytes.
		expectKeptUnavailable(await env.ircSend(id), spawned, warn, true);
	}, 30_000);
});
