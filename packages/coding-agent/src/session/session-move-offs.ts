/**
 * The sessions this process moved off to a sibling because it lost their
 * lease, so a subagent transcript nested under one can follow it in-process:
 * `SessionManager` records each move-off, and a nested session whose writes
 * the lost lease refused reads the move-off of its parent, or waits for it.
 */
import * as path from "node:path";
import type { SessionStorage } from "./session-storage";

/** One move-off: the sibling the session went on in, and the copy of its subagent rows there. */
export interface SessionMoveOff {
	/** The sibling session file. */
	to: string;
	/** Resolves once the rows under the old session's artifacts directory are copied under the sibling's. Never rejects. */
	copied: Promise<void>;
}

interface MoveOffEntry {
	moveOff: SessionMoveOff | undefined;
	recorded: PromiseWithResolvers<SessionMoveOff>;
}

const logs = new WeakMap<SessionStorage, Map<string, MoveOffEntry>>();

function entryOf(storage: SessionStorage, from: string): MoveOffEntry {
	let log = logs.get(storage);
	if (!log) {
		log = new Map();
		logs.set(storage, log);
	}
	const key = path.resolve(from);
	let entry = log.get(key);
	if (!entry) {
		entry = { moveOff: undefined, recorded: Promise.withResolvers() };
		log.set(key, entry);
	}
	return entry;
}

/** Record that the session at `from` in `storage` moved off as `moveOff` describes, waking its waiters. */
export function recordSessionMoveOff(storage: SessionStorage, from: string, moveOff: SessionMoveOff): void {
	const entry = entryOf(storage, from);
	entry.moveOff = moveOff;
	entry.recorded.resolve(moveOff);
}

/**
 * The move-offs that continue the session at `from` in `storage`, in order:
 * its own, then that of the sibling it went on in, and so on. Empty when it
 * has not moved off in this process.
 */
export function sessionMoveOffChain(storage: SessionStorage, from: string): SessionMoveOff[] {
	const log = logs.get(storage);
	const chain: SessionMoveOff[] = [];
	const seen = new Set<string>();
	for (let key = path.resolve(from); log && !seen.has(key);) {
		seen.add(key);
		const moveOff = log.get(key)?.moveOff;
		if (!moveOff) break;
		chain.push(moveOff);
		key = path.resolve(moveOff.to);
	}
	return chain;
}

/** Resolves when the session at `from` in `storage` moves off in this process. */
export function nextSessionMoveOff(storage: SessionStorage, from: string): Promise<SessionMoveOff> {
	return entryOf(storage, from).recorded.promise;
}

/** Drop a wait on `from` that ended without its session moving off. */
export function forgetSessionMoveOffWait(storage: SessionStorage, from: string): void {
	const log = logs.get(storage);
	const key = path.resolve(from);
	if (log?.get(key)?.moveOff === undefined) log?.delete(key);
}
