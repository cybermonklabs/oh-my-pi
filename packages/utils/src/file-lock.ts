/**
 * Cross-process advisory lock for packages that serialize access to an
 * on-disk resource. The native handle is process-owned and automatically
 * released on exit: Windows uses named mutexes, Linux an open-file-description
 * lock on `${filePath}.lock`, and other Unix platforms `flock(2)` on it.
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
 * One attempt of a waiting loop: on Linux, claim the lease unless the native
 * probe finds it held. The probe takes nothing, and it and the claim each
 * answer at once. The loop's last attempt claims without the probe, and a
 * probe that fails leaves the answer to the claim. Elsewhere no probe runs.
 */
function attemptLock(lockPath: string, lastAttempt: boolean): NativeFileLock | null {
	if (!lastAttempt && process.platform === "linux") {
		try {
			if (NativeFileLock.isHeld(lockPath)) return null;
		} catch {
			// The probe failed: the claim decides.
		}
	}
	return tryAcquireLock(lockPath);
}

/** Acquire an exclusive lease without waiting; `null` while another holder owns it. */
export function tryAcquireFileLock(filePath: string): FileLockHandle | null {
	return tryAcquireLock(getLockPath(filePath));
}

/**
 * {@link tryAcquireFileLock} for a caller that tries again later: on Linux it
 * probes the lease first and answers `null`, without claiming, while another
 * holder owns it; elsewhere it claims. A probe that fails leaves the answer to
 * the claim.
 */
export function tryAcquireFileLockUnlessHeld(filePath: string): FileLockHandle | null {
	return attemptLock(getLockPath(filePath), false);
}

/**
 * Whether any holder, including this process, owns the lease, observed without
 * taking it, so a concurrent `tryAcquireFileLock` never meets the probe.
 * Throws when the lock cannot be probed.
 */
export function isFileLockHeld(filePath: string): boolean {
	return NativeFileLock.isHeld(getLockPath(filePath));
}

/**
 * Acquire an exclusive lease; callers must release it when their operation ends.
 * On Linux each attempt but the last probes the lease before it claims it.
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
