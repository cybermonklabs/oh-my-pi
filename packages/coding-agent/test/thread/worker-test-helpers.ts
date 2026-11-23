import { afterEach } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { SubagentWorker, type SubagentWorkerOptions } from "../../src/thread/subagent-worker";

/** Helpers of a test file that starts subagent workers; what each test makes with them ends with that test. */
export interface WorkerTests {
	/** Run after the current test, in the order they were added. */
	readonly cleanups: Array<() => void>;
	/** A worker the current test owns: terminated after it. */
	startWorker(options?: SubagentWorkerOptions): SubagentWorker;
	/**
	 * The first record logged from now on whose message is `matches`, or that `matches` accepts; `onRecord` sees every
	 * record before that.
	 */
	nextRecord(
		matches: string | ((event: logger.LogEvent) => boolean),
		onRecord?: (event: logger.LogEvent) => void,
	): Promise<logger.LogEvent>;
}

/** Registers, in the calling test file, a hook that runs each test's cleanups after it, and returns its helpers. */
export function useWorkerTests(): WorkerTests {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});
	return {
		cleanups,
		startWorker: (options = {}) => {
			const worker = new SubagentWorker(options);
			cleanups.push(() => worker.terminate());
			return worker;
		},
		nextRecord: (matches, onRecord) => {
			const { promise, resolve } = Promise.withResolvers<logger.LogEvent>();
			cleanups.push(
				logger.registerLogSink(event => {
					onRecord?.(event);
					if (typeof matches === "string" ? event.message === matches : matches(event)) resolve(event);
				}),
			);
			return promise;
		},
	};
}
