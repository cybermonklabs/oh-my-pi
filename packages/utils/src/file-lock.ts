/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Linux uses abstract Unix sockets, Windows uses named
 * mutexes, and other Unix platforms use `flock(2)` on `${filePath}.lock`.
 */
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";

/** Controls bounded waiting when an advisory file lock is contended. */
export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
	/** Cancel acquisition while waiting for another process to release the resource. */
	signal?: AbortSignal;
}

/** An exclusive OS-backed lease. Releasing an already released handle is safe. */
export interface FileLockHandle {
	release(): void;
}

const DEFAULT_OPTIONS = {
	retries: 50,
	retryDelayMs: 100,
};

function getLockPath(filePath: string): string {
	return `${path.resolve(filePath)}.lock`;
}

function tryAcquireLock(lockPath: string): NativeFileLock | null {
	const lock = NativeFileLock.tryAcquire(lockPath);
	if (lock.acquired) return lock;
	lock.release();
	return null;
}

/**
 * One attempt of a waiting loop: claim the lease unless the native probe finds
 * it held. On Linux a claim of a lease another process holds blocks the thread
 * for about 50 ms before it answers (see {@link tryAcquireFileLock}), while the
 * probe answers at once, so a loop that waits for a holder does not stall its
 * thread on every attempt. A wrong "held" (under gVisor a probe can still reach
 * a just-released name) costs the loop one retry delay, so the loop's last
 * attempt claims without the probe, and a probe that fails leaves the answer to
 * the claim.
 */
function attemptLock(lockPath: string, lastAttempt: boolean): NativeFileLock | null {
	if (!lastAttempt) {
		try {
			if (NativeFileLock.isHeld(lockPath)) return null;
		} catch {
			// No probe on this platform, or it failed: the claim decides.
		}
	}
	return tryAcquireLock(lockPath);
}

/**
 * Acquire an exclusive lease without waiting for its holder to release it;
 * `null` while another holder owns it. On Linux a refused claim is retried,
 * because under gVisor a probe can make a free lease look taken for a few
 * milliseconds: for at most 200 ms, and for about 50 ms while another process
 * holds the lease, blocking the calling thread meanwhile. A claim of a lease
 * this process holds answers `null` at once. `isFileLockHeld` tells whether a
 * lease is held without that wait.
 */
export function tryAcquireFileLock(filePath: string): FileLockHandle | null {
	return tryAcquireLock(getLockPath(filePath));
}

/**
 * {@link tryAcquireFileLock} for a caller that tries again later: on Linux,
 * while another holder owns the lease, a probe answers `null` at once where a
 * claim would block the thread for about 50 ms; elsewhere a claim answers at
 * once, so no probe runs. The probe can also read a just-released lease as
 * held, which costs such a caller one retry; a probe that fails leaves the
 * answer to the claim.
 */
export function tryAcquireFileLockUnlessHeld(filePath: string): FileLockHandle | null {
	const lockPath = getLockPath(filePath);
	return process.platform === "linux" ? attemptLock(lockPath, false) : tryAcquireLock(lockPath);
}

/**
 * Whether any holder, including this process, owns the lease, observed without
 * taking it. Under gVisor the probe can make a concurrent `tryAcquireFileLock`
 * find the lease in use for a few milliseconds, which that claim retries, so
 * the probe does not make it fail. Throws when the lock cannot be probed.
 */
export function isFileLockHeld(filePath: string): boolean {
	return NativeFileLock.isHeld(getLockPath(filePath));
}

/**
 * Acquire an exclusive lease; callers must release it when their operation ends.
 * While another holder owns it, each attempt but the last only probes the lease,
 * so the wait does not block the event loop between the retry delays.
 */
export async function acquireFileLock(filePath: string, options: FileLockOptions = {}): Promise<FileLockHandle> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = attemptLock(lockPath, attempt + 1 === opts.retries);
		if (lock) return lock;
		if (attempt + 1 < opts.retries) await scheduler.wait(opts.retryDelayMs, { signal: opts.signal });
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

function acquireLockSync(filePath: string, options: FileLockOptions = {}): NativeFileLock {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lockPath = getLockPath(filePath);

	for (let attempt = 0; attempt < opts.retries; attempt++) {
		opts.signal?.throwIfAborted();
		const lock = attemptLock(lockPath, attempt + 1 === opts.retries);
		if (lock) return lock;
		if (attempt + 1 < opts.retries && opts.retryDelayMs > 0) Bun.sleepSync(opts.retryDelayMs);
	}

	throw new Error(`Failed to acquire lock for ${filePath} after ${opts.retries} attempts`);
}

/** Run `fn` while holding an OS-backed exclusive lock for `filePath`. */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lock = await acquireFileLock(filePath, options);
	try {
		return await fn();
	} finally {
		lock.release();
	}
}

/** Run synchronous `fn` while holding an OS-backed exclusive lock for `filePath`. */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: FileLockOptions = {}): T {
	const lock = acquireLockSync(filePath, options);
	try {
		return fn();
	} finally {
		lock.release();
	}
}

/**
 * Test-only acquisition handle for forcing ownership handoffs. This is not
 * part of the supported package API.
 */
export const __internalsForTesting = {
	tryAcquireLock,
	getLockPath,
};
