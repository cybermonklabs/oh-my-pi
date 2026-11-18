/**
 * The bridged host calls of a JavaScript kernel's run (a `tool.task` that a kernel-defined tool or a cell awaits)
 * abort with the reason that ended the run, so a sync subagent such a call started is cut off, not stopped, when the
 * process of the agent that ran it goes away, and `omp --restore` goes on with it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { resolveJsKernelIdentity } from "../../src/eval/js";
import { disposeAllVmContexts, invokeJsTool } from "../../src/eval/js/context-manager";
import { INTERRUPTED_TURN_ERROR, turnAbortKind } from "../../src/session/exit-diagnostics";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-js-bridged-call-abort-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

/** A host tool whose call stays in flight until its signal aborts; `abortReason` settles with that signal's reason. */
function heldTool(name: string): { tool: AgentTool; started: Promise<void>; abortReason: Promise<unknown> } {
	const started = Promise.withResolvers<void>();
	const abortReason = Promise.withResolvers<unknown>();
	const tool: AgentTool = {
		name,
		label: name,
		description: "Holds its call until the call is aborted",
		parameters: type({}),
		async execute(_id, _args, signal) {
			const result = Promise.withResolvers<AgentToolResult>();
			const onAbort = () => {
				abortReason.resolve(signal?.reason);
				result.reject(signal?.reason);
			};
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			started.resolve();
			try {
				return await result.promise;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
	return { tool, started: started.promise, abortReason: abortReason.promise };
}

function toolSession(...tools: AgentTool[]): ToolSession {
	const sessionId = `js-bridged-call-abort-${crypto.randomUUID()}`;
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "eval.autoProvision": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

/** Defines `relay` in the session's JavaScript kernel: a tool another agent can call, which awaits `tool.task`. */
async function defineRelay(session: ToolSession): Promise<void> {
	const result = await new EvalTool(session).execute("define-relay", {
		language: "js",
		code: "tool(async function relay() { return await tool.task({}); })",
		timeout: 0,
	});
	expect(result.details?.cells?.[0]?.status).toBe("complete");
}

/** Another agent's call of the kernel's `relay` tool, aborted by `signal`. */
function callRelay(session: ToolSession, signal?: AbortSignal) {
	return invokeJsTool(
		{ op: "call", name: "relay", args: {} },
		{ ...resolveJsKernelIdentity(session), session, signal },
	);
}

test("a kernel-defined tool's call that its caller's process exit aborted cuts off the tool.task it awaits", async () => {
	// If this regresses, the call aborts its bridged calls with the error it made of the exit's reason, which reads to
	// a sync subagent the tool started as a stop: its turn ends on an aborted record, and `omp --restore` leaves the
	// work the exit cut off unfinished.
	const delegated = heldTool("task");
	const session = toolSession(delegated.tool);
	await defineRelay(session);
	const caller = new AbortController();
	const call = callRelay(session, caller.signal);
	await delegated.started;
	caller.abort(INTERRUPTED_TURN_ERROR);

	expect(await call).toMatchObject({ ok: false });
	expect(turnAbortKind(await delegated.abortReason)).toBe("cutOff");
}, 15_000);

test("a cell's abort for its process exit cuts off the tool.task of a kernel-defined tool's call on the same kernel", async () => {
	// If this regresses, the kill of the kernel aborts the bridged calls of its other runs with the cell's kill error,
	// which reads to a sync subagent a kernel-defined tool started as a stop: `omp --restore` leaves the work the exit
	// cut off unfinished.
	const delegated = heldTool("task");
	const cellCall = heldTool("review");
	const session = toolSession(delegated.tool, cellCall.tool);
	await defineRelay(session);
	const call = callRelay(session);
	await delegated.started;
	const turn = new AbortController();
	const cell = new EvalTool(session).execute(
		"held-cell",
		{ language: "js", code: "print(await tool.review({}))", timeout: 0 },
		turn.signal,
	);
	await cellCall.started;
	turn.abort(INTERRUPTED_TURN_ERROR);

	expect(await call).toMatchObject({ ok: false });
	expect(turnAbortKind(await delegated.abortReason)).toBe("cutOff");
	// The cell ends on its own abort; what it reports is not this test's contract.
	await Promise.allSettled([cell]);
}, 15_000);
