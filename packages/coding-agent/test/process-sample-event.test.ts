/**
 * The `process_sample` session event is a plain fire-and-forget event: the generic
 * runner dispatch must deliver it without any per-event registration.
 */

import { describe, expect, it } from "bun:test";
import type { ProcessSample } from "@oh-my-pi/pi-coding-agent/debug/memory-sample";
import { HookRunner, type LoadedHook } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import type { ProcessSampleEvent } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function sample(): ProcessSample {
	return {
		identity: { pid: 4242, startedAtMs: 1_762_700_000_000 },
		seq: 1,
		reason: "start",
		uptimeMs: 10,
		cpu: { userMs: 5, systemMs: 2 },
		process: null,
		cgroup: null,
		main: {
			thread: "main",
			jscHeapBytes: null,
			jscFootprintBytes: null,
			pageFaults: null,
			cpuMs: 7,
			heapUsedBytes: 1,
			heapTotalBytes: 2,
			externalBytes: 3,
		},
		workers: [],
		work: {
			journalEntries: 0,
			toolCalls: 0,
			topTools: [],
			subagentDispatches: 0,
			fileReads: 0,
			compactions: 0,
			liveSubagents: 0,
			parkedSubagents: 0,
			tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
			tokensIncludeSubagents: false,
			subagentWorkers: 0,
		},
		costMs: 1,
		workerWaitMs: 0,
	};
}

function hookCapturing(received: ProcessSampleEvent[]): LoadedHook {
	const handlers: LoadedHook["handlers"] = new Map();
	handlers.set("process_sample", [
		async (...args: unknown[]) => {
			received.push(args[0] as ProcessSampleEvent);
			return undefined;
		},
	]);
	return {
		path: "test-hook",
		resolvedPath: "test-hook",
		handlers,
		messageRenderers: new Map(),
		commands: new Map(),
		setSendMessageHandler: () => {},
		setAppendEntryHandler: () => {},
	};
}

describe("process_sample event", () => {
	it("reaches a hook handler through the generic emit path and returns no result", async () => {
		const received: ProcessSampleEvent[] = [];
		const runner = new HookRunner(
			[hookCapturing(received)],
			process.cwd(),
			undefined as unknown as SessionManager,
			undefined as unknown as ModelRegistry,
		);

		const result = await runner.emit({ type: "process_sample", sessionId: "s1", sample: sample() });

		expect(result).toBeUndefined();
		expect(received).toHaveLength(1);
		expect(received[0]?.sessionId).toBe("s1");
		expect(received[0]?.sample.seq).toBe(1);
	});
});
