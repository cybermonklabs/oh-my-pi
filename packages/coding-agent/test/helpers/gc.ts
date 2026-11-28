/**
 * Collects across a few event-loop turns and returns how many of `refs`' targets are still reachable.
 * Bun's conservative stack scan can pin the most recently dropped object in a stale native stack slot
 * (deterministically so on Windows), so callers settle several targets and tolerate one survivor.
 * A caller must keep whatever should hold the targets (an owner signal, a transcript) live until this
 * returns, by reading it afterwards: a dead local lets the runtime collect what it alone reached.
 */
export async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
	let live = refs.length;
	for (let turn = 0; turn < 20; turn++) {
		Bun.gc(true);
		live = refs.filter(ref => ref.deref() !== undefined).length;
		if (live === 0) break;
		// A WeakRef target stays alive until the current task ends: a zero-length sleep yields one
		// task so the next collection can clear it (no wall-clock wait; fake timers cannot end a task).
		await Bun.sleep(0);
	}
	return live;
}
