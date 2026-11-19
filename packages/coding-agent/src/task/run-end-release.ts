/**
 * Release hooks (`ExecutorOptions.onRelease`) of kept-alive subagent runs whose resource the run's own end still
 * uses after its `finalizeSubagentLifecycle`: an isolated run's worktree, which its end capture reads, and a
 * seance's temporary artifacts directory, where its end publishes its result.
 *
 * The agent lifecycle can call such a hook while the run is still ending: `adopt` refuses an agent that a release
 * holds and calls its hook at once, and a release of an agent adopted a moment before calls it too. The run's own
 * `finalizeSubagentLifecycle` calls the hook and awaits it when it adopts nothing, before the run's end can go on,
 * so a hook that waited there for the run's end would wait for itself.
 */

/** A kept-alive run's release hook, held until the run's own end is done with what it releases. */
export interface RunEndRelease {
	/**
	 * The hook. Its first call starts the release, which waits for {@link RunEndRelease.end}. Called before that,
	 * the hook returns at once and the run's end waits for the release instead; called after, it returns the release.
	 */
	readonly onRelease: () => Promise<void>;
	/**
	 * Say that the run's end is done with the resource. A release the hook started goes on now and is returned, for
	 * the run's end to await before it hands its result on; `undefined` when the hook was not called.
	 */
	end(): Promise<void> | undefined;
}

/**
 * Hold `release` until the run's end calls {@link RunEndRelease.end}. `onStart` gets the release as the hook starts
 * it, while it still waits for that end (to keep a signal exit waiting for it, say).
 */
export function releaseAfterRunEnd(
	release: () => Promise<void>,
	onStart?: (releasing: Promise<void>) => void,
): RunEndRelease {
	const runEnd = Promise.withResolvers<void>();
	let ended = false;
	let releasing: Promise<void> | undefined;
	return {
		onRelease: () => {
			if (!releasing) {
				releasing = runEnd.promise.then(release);
				onStart?.(releasing);
			}
			return ended ? releasing : Promise.resolve();
		},
		end: () => {
			ended = true;
			runEnd.resolve();
			return releasing;
		},
	};
}
