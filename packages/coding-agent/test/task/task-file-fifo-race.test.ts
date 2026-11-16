import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { Subprocess } from "bun";

type Writer = Subprocess;
type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };

// A taskFile that is a FIFO must be refused without opening it: opening a FIFO, even non-blocking, lets a
// process blocked in its own open of that FIFO for writing go on. Here the path is a regular file when the
// tool reads its type and a FIFO, with a writer blocked in its open, by the time the tool opens it. The
// moment is forced by renaming the FIFO into place as soon as the tool first reaches the path through
// node:fs/promises (`stat`, `lstat` or `open`) after approval.
describe.skipIf(process.platform === "win32")("taskFile swapped for a FIFO after its type is read", () => {
	let tempDir: TempDir;
	let directory: string;
	const executions: ExecutorOptions[] = [];
	const writers = new Set<Writer>();

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-task-file-fifo-race-");
		// Real path: macOS tmpdir is a symlink (/var → /private/var), and approval shows resolved targets.
		directory = await fs.realpath(tempDir.path());
		executions.length = 0;
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [{ name: "task", description: "Task agent", systemPrompt: "Complete the task.", source: "bundled" }],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			executions.push(options);
			const progress: AgentProgress = {
				index: options.index,
				id: options.id,
				agent: options.agent.name,
				agentSource: options.agent.source,
				task: options.task,
				assignment: options.assignment,
				status: "completed",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 1,
				tokens: 0,
				cost: 0,
				durationMs: 1,
			};
			options.onProgress?.(progress);
			return { ...progress, exitCode: 0, output: "Completed.", stderr: "", truncated: false };
		});
	});

	afterEach(async () => {
		for (const writer of writers) {
			if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
			await writer.exited;
		}
		writers.clear();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await tempDir.remove();
	});

	async function createWrapper(select: ExtensionUIContext["select"]) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.file": true,
			"tools.approvalMode": "always-ask",
			"tools.restrictedFolders": [path.join(directory, "restricted")],
		});
		const tool = await TaskTool.create({
			cwd: directory,
			hasUI: true,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			localProtocolOptions: { getArtifactsDir: () => path.join(directory, "artifacts") },
		} as unknown as ToolSession);
		const sessionManager = SessionManager.inMemory(directory);
		const modelRegistry = {} as ModelRegistry;
		const runner = new ExtensionRunner([], new ExtensionRuntime(), directory, sessionManager, modelRegistry);
		runner.initialize(
			{} as Parameters<ExtensionRunner["initialize"]>[0],
			{} as Parameters<ExtensionRunner["initialize"]>[1],
			undefined,
			{ select } as ExtensionUIContext,
		);
		const wrapper = new ExtensionToolWrapper(
			{
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: tool.parameters,
				approval: tool.approval,
				bindApprovalTargets: tool.bindApprovalTargets,
				approvalRestrictionPaths: tool.approvalRestrictionPaths,
				formatApprovalDetails: tool.formatApprovalDetails,
				execute: tool.execute.bind(tool),
			},
			runner,
		);
		const context: AgentToolContext = {
			settings,
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => undefined,
		};
		return { wrapper, context, tool };
	}

	/** A FIFO with a writer blocked in its open; the writer goes on only when something opens the FIFO. */
	async function fifoWithBlockedWriter(fifo: string): Promise<Writer> {
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		const writer = Bun.spawn(["sh", "-c", 'echo started && printf x > "$1"', "sh", fifo], {
			stdout: "pipe",
			stderr: "ignore",
		});
		writers.add(writer);
		await (writer.stdout as ReadableStream<Uint8Array>).getReader().read();
		// Let the shell reach its open() of the FIFO. The writer is another process blocked in the kernel, so a
		// fake clock cannot stand in for these real waits.
		await Bun.sleep(200);
		expect(writer.exitCode).toBeNull();
		return writer;
	}

	/** Whether the writer is still blocked two seconds on (a generous bound for a released writer to exit), or went on. */
	async function writerAfterTwoSeconds(writer: Writer): Promise<string> {
		return Promise.race([
			writer.exited.then(code => `went on (exit ${code}, signal ${writer.signalCode})`),
			Bun.sleep(2_000).then(() => "still blocked"),
		]);
	}

	/**
	 * Rename `fifo` over `taskFile` the first time the tool reaches `taskFile` through node:fs/promises once
	 * `armed()` holds: right after a type read returns, or right before an open.
	 */
	function swapInFifoOnFirstAccess(taskFile: string, fifo: string, armed: () => boolean): () => boolean {
		let swapped = false;
		const due = (target: unknown) => !swapped && armed() && String(target) === taskFile;
		const swap = async () => {
			swapped = true;
			await realRename(fifo, taskFile);
		};
		const realRename = fs.rename;
		const realStat = fs.stat;
		const realLstat = fs.lstat;
		const realOpen = fs.open;
		vi.spyOn(fs, "stat").mockImplementation((async (target: nodeFs.PathLike, options?: nodeFs.StatOptions) => {
			const entry = await realStat(target, options as nodeFs.StatOptions & { bigint: true });
			if (due(target)) await swap();
			return entry;
		}) as typeof fs.stat);
		vi.spyOn(fs, "lstat").mockImplementation((async (target: nodeFs.PathLike, options?: nodeFs.StatOptions) => {
			const entry = await realLstat(target, options as nodeFs.StatOptions & { bigint: true });
			if (due(target)) await swap();
			return entry;
		}) as typeof fs.lstat);
		vi.spyOn(fs, "open").mockImplementation((async (target: nodeFs.PathLike, ...rest: [string | number, number]) => {
			if (due(target)) await swap();
			return realOpen(target, ...rest);
		}) as typeof fs.open);
		return () => swapped;
	}

	function expectRefused(result: Result, taskFile: string) {
		const text = result.content.map(part => part.text ?? "").join("\n");
		expect(result.isError, text).toBe(true);
		expect(text).toContain(`taskFile ${JSON.stringify(taskFile)}`);
		expect(executions).toHaveLength(0);
	}

	// Regressed: a process writing into a FIFO the agent named as its taskFile is let go (or killed by
	// SIGPIPE) although the call is refused.
	it("an unapproved call refuses the FIFO and leaves its writer blocked", async () => {
		const taskFile = path.join(directory, "task.md");
		const fifo = path.join(directory, "spare.fifo");
		await Bun.write(taskFile, "Assignment.");
		const writer = await fifoWithBlockedWriter(fifo);
		const swapped = swapInFifoOnFirstAccess(taskFile, fifo, () => true);
		const { tool } = await createWrapper(async () => "Approve");

		const result = (await tool.execute("unapproved", { taskFile })) as Result;

		expect(swapped()).toBe(true);
		expectRefused(result, taskFile);
		expect(await writerAfterTwoSeconds(writer)).toBe("still blocked");
	}, 15_000);

	// Regressed: after the user approved a regular file, a FIFO renamed over it lets its writer go on.
	it("an approved call refuses the FIFO renamed over the approved file and leaves its writer blocked", async () => {
		const taskFile = path.join(directory, "task.md");
		const fifo = path.join(directory, "spare.fifo");
		await Bun.write(taskFile, "Assignment.");
		const writer = await fifoWithBlockedWriter(fifo);
		let approved = false;
		const swapped = swapInFifoOnFirstAccess(taskFile, fifo, () => approved);
		const { wrapper, context } = await createWrapper(async () => {
			approved = true;
			return "Approve";
		});

		const result = (await wrapper.execute("approved", { taskFile }, undefined, undefined, context)) as Result;

		expect(approved).toBe(true);
		expect(swapped()).toBe(true);
		expectRefused(result, taskFile);
		expect(await writerAfterTwoSeconds(writer)).toBe("still blocked");
	}, 15_000);
});
