import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { disposeAllKernelSessions } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import { turnAbortKind } from "../../src/session/exit-diagnostics";
import { USER_INTERRUPT_LABEL } from "../../src/session/messages";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-session-tool-timeout-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(...tools: AgentTool[]): ToolSession {
	const sessionId = `session-tool-timeout-${crypto.randomUUID()}`;
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

/** A tool whose work stays in flight until the test calls `release()` (or the call is aborted). */
function slowTool(name: string): {
	tool: AgentTool;
	started: Promise<void>;
	release: () => void;
	aborted: () => boolean;
	/** Settles with the call's abort reason once its signal aborts. */
	abortReason: Promise<unknown>;
} {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const abortReason = Promise.withResolvers<unknown>();
	let aborted = false;
	return {
		started: started.promise,
		release: () => released.resolve(),
		aborted: () => aborted,
		abortReason: abortReason.promise,
		tool: {
			name,
			label: name,
			description: "Returns delegated work once released",
			parameters: type({}),
			async execute(_id, _args, signal) {
				const result = Promise.withResolvers<AgentToolResult>();
				void released.promise.then(() => result.resolve({ content: [{ type: "text", text: "review complete" }] }));
				const onAbort = () => {
					aborted = true;
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
		},
	};
}

async function warmEval(evalTool: EvalTool, language: "js" | "py"): Promise<void> {
	// Start the real worker/kernel outside the measured cell, so interpreter
	// startup cannot hide whether the delegated call reached execution.
	await evalTool.execute("warmup", { language, code: "print('ready')", timeout: 0 });
}

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

describe("eval delegated session tools", () => {
	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: still aborts an awaited tool.task when the turn is cancelled`,
			async () => {
				const delegated = slowTool("task");
				const evalTool = new EvalTool(makeSession(delegated.tool));
				await warmEval(evalTool, language);
				const controller = new AbortController();
				const pending = evalTool.execute(
					"cancel-delegated-work",
					{ language, code: "print(await tool.task({}))", timeout: 1 },
					controller.signal,
				);

				await delegated.started;
				controller.abort(new Error("turn cancelled"));
				const result = await pending;
				expect(delegated.aborted()).toBe(true);
				expect(result.details?.cells?.[0]?.status).toBe("error");
				expect(result.details?.cells?.[0]?.output).not.toContain("review complete");
			},
			15_000,
		);
	}
});

describe("eval delegated session tools in an auto-backgrounded cell", () => {
	it("js: a stop of the turn while the cell runs in the foreground stops its tool.task", async () => {
		// If this regresses, the eval tool cancels the cell's foreground job with the platform's unmarked reason,
		// which a sync subagent the cell started reads as a cut-off: `omp --restore` relaunches work the turn stopped.
		const delegated = slowTool("task");
		const manager = new AsyncJobManager({});
		try {
			const session: ToolSession = {
				...makeSession(delegated.tool),
				settings: Settings.isolated({
					"async.enabled": false,
					"eval.autoProvision": false,
					"eval.autoBackground.enabled": true,
				}),
				asyncJobManager: manager,
			};
			const evalTool = new EvalTool(session);
			await warmEval(evalTool, "js");
			const controller = new AbortController();
			const pending = evalTool.execute(
				"stop-delegated-work",
				{ language: "js", code: "print(await tool.task({}))", timeout: 0 },
				controller.signal,
			);

			await delegated.started;
			controller.abort(USER_INTERRUPT_LABEL);
			await expect(pending).rejects.toThrow();
			expect(turnAbortKind(await delegated.abortReason)).toBe("stop");
		} finally {
			await manager.dispose();
		}
	}, 15_000);
});
