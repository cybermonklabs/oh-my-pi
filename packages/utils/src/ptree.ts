/**
 * Process tree management utilities for Bun subprocesses.
 *
 * - Track managed child processes for cleanup on shutdown (postmortem).
 * - Drain stdout/stderr to avoid subprocess pipe deadlocks.
 * - Cross-platform tree kill for process groups (Windows taskkill, Unix -pid).
 * - Convenience helpers: captureText / execText, AbortSignal, timeouts.
 */

import * as os from "node:os";
import { Process, type ProcessTerminateOptions } from "@oh-my-pi/pi-natives";
import type { Spawn, Subprocess } from "bun";

type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;

/** A Bun subprocess with stdout/stderr always piped (stdin may vary). */
type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;

const LINUX_SUBREAPER_COMMAND_ENV = "OMP_PTREE_SUBREAPER_COMMAND";
const LINUX_SUBREAPER_BUN_BE_BUN_ENV = "OMP_PTREE_SUBREAPER_BUN_BE_BUN";
const SUBREAPER_KILL_WINDOW_MS = 100;
const SUBREAPER_KILL_POLL_MS = 5;

/** Set for the launcher of a tool process: what it writes to stderr when its exec fails. */
const TOOL_EXEC_FAILED_ENV = "OMP_TOOL_EXEC_FAILED";
/** The `BUN_BE_BUN` of the command a tool process launcher runs, unset when the key is missing. */
const TOOL_EXEC_BUN_BE_BUN_ENV = "OMP_TOOL_EXEC_BUN_BE_BUN";

/**
 * The launcher of a tool process (`exec`'s `toolOomScore`): this build's
 * runtime, run as `-e` with `-- <file> <argv0> <args>...`, sets its own OOM
 * adjustment to 1000 and replaces itself with the file. The program keeps
 * the pid, inherits the adjustment, and starts with the caller's
 * environment and with every signal the runtime ignores at its default, as
 * `Bun.spawn` starts it. A failed exec writes `$OMP_TOOL_EXEC_FAILED` to
 * stderr and exits 127.
 */
const TOOL_EXEC_SCRIPT = `
const fs = require("node:fs");
try {
	fs.writeFileSync("/proc/self/oom_score_adj", "1000");
} catch {}
const env = { ...process.env };
const failed = env.${TOOL_EXEC_FAILED_ENV} ?? "";
const callerBunBeBun = env.${TOOL_EXEC_BUN_BE_BUN_ENV};
delete env.${TOOL_EXEC_FAILED_ENV};
delete env.${TOOL_EXEC_BUN_BE_BUN_ENV};
if (callerBunBeBun === undefined) delete env.BUN_BE_BUN;
else env.BUN_BE_BUN = callerBunBeBun;
// An exec keeps an ignored signal ignored and resets a handled one.
process.on("SIGPIPE", () => {});
process.on("SIGXFSZ", () => {});
// The experimental execve's warning would otherwise reach the program's stderr, should it print.
process.removeAllListeners("warning");
process.on("warning", () => {});
const [file, ...argv] = process.argv.slice(1);
try {
	process.execve(file, argv, env);
} catch {}
fs.writeSync(2, failed);
process.exit(127);
`;

/**
 * `root`'s children, or `undefined` when the walk could not read every candidate (the natives
 * throw then, with no descriptor left say): a sweep that gets `undefined` reads again at its
 * next pass instead of ending. A handle that cannot even tell whether its process runs is
 * unusable (a class of another realm, say): its error is rethrown, for the caller's fallback
 * that signals the process directly.
 */
function childrenOf(root: Process): Process[] | undefined {
	try {
		return root.children();
	} catch (error) {
		throwIfUnusable(root, error);
		return undefined;
	}
}

/**
 * `process.killTree(signal)`, going on past a walk it could not finish: it already signalled
 * every process it read, and the process group the root leads. An unusable handle's error is
 * rethrown ({@link childrenOf}).
 */
function signalTree(process: Process, signal?: number): void {
	try {
		process.killTree(signal);
	} catch (error) {
		throwIfUnusable(process, error);
	}
}

/** Rethrows `error` when `process`'s handle cannot be used at all: its `status()` fails too. */
function throwIfUnusable(process: Process, error: unknown): void {
	try {
		process.status();
	} catch {
		throw error;
	}
}

/**
 * Build the Linux child-subreaper entrypoint.
 *
 * @internal Exported so tests can force a missing first libc soname and verify
 * the loader continues to the next candidate.
 */
export function createLinuxSubreaperScript(libcCandidates: readonly string[] = ["libc.so.6", "libc.so"]): string {
	return `
import { dlopen, FFIType } from "bun:ffi";

let libc;
for (const soname of ${JSON.stringify(libcCandidates)}) {
	try {
		libc = dlopen(soname, {
			prctl: {
				args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
				returns: FFIType.i32,
			},
			waitpid: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		break;
	} catch {}
}
if (!libc) throw new Error("failed to load libc for Linux child supervision");

if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) {
	throw new Error("failed to become a Linux child subreaper");
}

const commandJson = Bun.env.${LINUX_SUBREAPER_COMMAND_ENV};
if (!commandJson) throw new Error("missing supervised command");
const callerBunBeBun = Bun.env.${LINUX_SUBREAPER_BUN_BE_BUN_ENV};
delete Bun.env.${LINUX_SUBREAPER_COMMAND_ENV};
delete Bun.env.${LINUX_SUBREAPER_BUN_BE_BUN_ENV};
if (callerBunBeBun === undefined) delete Bun.env.BUN_BE_BUN;
else Bun.env.BUN_BE_BUN = callerBunBeBun;
const command = JSON.parse(commandJson);
const child = Bun.spawn(command, {
	stdin: "inherit",
	stdout: "pipe",
	stderr: "pipe",
	windowsHide: true,
	env: Bun.env,
});

async function relay(stream, destination) {
	const writer = destination.writer();
	for await (const chunk of stream) writer.write(chunk);
	await writer.flush();
}

function hasLiveChildren() {
	let childPid;
	do {
		childPid = libc.symbols.waitpid(-1, null, 1);
	} while (childPid > 0);
	return childPid === 0;
}

const [exitCode] = await Promise.all([
	child.exited,
	relay(child.stdout, Bun.stdout),
	relay(child.stderr, Bun.stderr),
]);
while (hasLiveChildren()) await Bun.sleep(10);
process.exit(exitCode ?? 1);
`;
}

const LINUX_SUBREAPER_SCRIPT = createLinuxSubreaperScript();

// ── Exceptions ───────────────────────────────────────────────────────────────

/**
 * Base for all exceptions representing child process nonzero exit, killed, or
 * cancellation.
 */
export abstract class Exception extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
		public readonly stderr: string,
	) {
		super(message);
		this.name = this.constructor.name;
	}
	abstract readonly aborted: boolean;
}

/** Exception for nonzero exit codes (not cancellation). */
export class NonZeroExitError extends Exception {
	static readonly MAX_TRACE = 32 * 1024;

	constructor(exitCode: number, stderr: string) {
		super(`Process exited with code ${exitCode}:\n${stderr}`, exitCode, stderr);
	}
	get aborted() {
		return false;
	}
}

/** Exception for explicit process abortion (via signal). */
export class AbortError extends Exception {
	constructor(
		public readonly reason: unknown,
		stderr: string,
	) {
		const msg = reason instanceof Error ? reason.message : String(reason ?? "aborted");
		super(`Operation cancelled: ${msg}`, -1, stderr);
	}
	get aborted() {
		return true;
	}
}

/** Exception for process timeout. */
export class TimeoutError extends AbortError {
	constructor(timeout: number, stderr: string) {
		super(new Error(`Timed out after ${Math.round(timeout / 1000)}s`), stderr);
	}
}

// ── Wait / Exec types ────────────────────────────────────────────────────────

/** Options for waiting for process exit and capturing output. */
export interface WaitOptions {
	allowNonZero?: boolean;
	allowAbort?: boolean;
	/** `full` requires upfront capture; `exec` enables it, while direct `spawn` callers pass `stderr: "full"`. */
	stderr?: "full" | "buffer";
}

/** Result from wait and exec. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	ok: boolean;
	exitError?: Exception;
}

// ── ChildProcess ─────────────────────────────────────────────────────────────

/**
 * ChildProcess wraps a managed subprocess, capturing stderr tail, providing
 * cross-platform kill/detach logic plus AbortSignal integration.
 *
 * Stdout is exposed directly from the underlying Bun subprocess; consumers
 * must read it (via text(), wait(), etc.) to prevent pipe deadlock.
 * Stderr is eagerly drained into an internal buffer.
 */
export class ChildProcess<In extends InMask = InMask> {
	#nothrow = false;
	#stderrTail = "";
	#stderrChunks?: Uint8Array[];
	#exitReason?: Exception;
	#exitReasonPending?: Exception;
	#stderrDone: Promise<void>;
	#exited: Promise<number>;
	#openPipeReaders = 1;
	// Set at the command deadline or on abort; otherwise commands keep complete
	// EOF-based capture. Active pipe readers are cancelled at cutoff so their
	// pending read() settles as done and partial output is kept.
	#cutoff = false;
	/** Readers of piped stdio; timeout and abort cancel them so pending reads settle. */
	#pipeReaders = new Set<{ cancel(reason?: unknown): Promise<void> }>();
	// Each registration reconciles its listener with root-exit and reader activity.
	// Keeping the registration after idle lets a later output read re-arm the signal.
	#abortRegistrations?: Set<() => void>;
	#timeoutTimer?: NodeJS.Timeout;
	#stderrStream?: ReadableStream<Uint8Array>;
	// Termination in flight after kill(); aborted exits await it before reporting.
	#terminating?: Promise<boolean | void>;
	// The one stop sequence of a subreaper-supervised command; a later hard
	// kill request ends its grace period, and any other later request is a no-op.
	#subreaperStop?: { escalate: () => void };
	#terminateGroup: boolean;
	#hardKillTree: boolean;
	// Windows has no process groups. Retaining the root's native handle pins
	// its PID after exit so killTree() can still enumerate its original children.
	#windowsRootProcess?: Process;
	constructor(
		readonly proc: PipedSubprocess<In>,
		readonly exposeStderr: boolean,
		retainFullStderr = exposeStderr,
		terminateGroup = false,
		hardKillTree = false,
	) {
		this.#terminateGroup = terminateGroup;
		this.#hardKillTree = hardKillTree;
		this.#windowsRootProcess = process.platform === "win32" ? (Process.fromPid(proc.pid) ?? undefined) : undefined;
		if (retainFullStderr) this.#stderrChunks = [];
		// Eagerly drain stderr into a truncated tail, retaining raw chunks only for explicit full capture.
		const dec = new TextDecoder();
		const trim = () => {
			if (this.#stderrTail.length > NonZeroExitError.MAX_TRACE)
				this.#stderrTail = this.#stderrTail.slice(-NonZeroExitError.MAX_TRACE);
		};
		let stderrStream = proc.stderr;
		if (exposeStderr) {
			const [teeStream, drainStream] = stderrStream.tee();
			this.#stderrStream = teeStream;
			stderrStream = drainStream;
		}
		// Normalize Bun's exited promise into our exitReason / exitedCleanly model.
		const { promise, resolve, reject } = Promise.withResolvers<number>();
		this.#exited = promise;

		this.#stderrDone = (async () => {
			const reader = stderrStream.getReader();
			this.#pipeReaders.add(reader);
			try {
				for (;;) {
					if (this.#cutoff) {
						await reader.cancel().catch(() => {});
						break;
					}
					const r = await reader.read();
					if (r.done) break;
					this.#stderrChunks?.push(r.value);
					this.#stderrTail += dec.decode(r.value, { stream: true });
					trim();
				}
			} catch {}
			this.#pipeReaders.delete(reader);
			this.#openPipeReaders--;
			this.#stderrTail += dec.decode();
			trim();
			this.#syncAbortListeners();
		})();

		proc.exited
			.catch(() => null)
			.then(async exitCode => {
				this.#syncAbortListeners();
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}
				if (exitCode === 0) {
					resolve(0);
					return;
				}

				await this.#stderrDone;
				if (this.#exitReasonPending) {
					this.#exitReason = this.#exitReasonPending;
					reject(this.#exitReasonPending);
					return;
				}

				if (exitCode !== null) {
					this.#exitReason = new NonZeroExitError(exitCode, this.#stderrTail);
					resolve(exitCode);
					return;
				}

				const ex = this.proc.killed
					? new AbortError(new Error("process killed"), this.#stderrTail)
					: new NonZeroExitError(-1, this.#stderrTail);
				this.#exitReason = ex;
				reject(ex);
			});
	}

	// ── Properties ───────────────────────────────────────────────────────

	get pid() {
		return this.proc.pid;
	}
	get exited() {
		return this.#exited;
	}
	get exitCode() {
		return this.proc.exitCode;
	}
	get exitReason() {
		return this.#exitReason;
	}
	get killed() {
		return this.proc.killed;
	}
	get stdin(): Bun.SpawnOptions.WritableToIO<In> {
		return this.proc.stdin;
	}

	/** Raw stdout stream. Must be consumed to prevent pipe deadlock. */
	get stdout() {
		return this.proc.stdout;
	}

	/** Optional stderr stream (only when requested in spawn options). */
	get stderr() {
		return this.#stderrStream;
	}

	get exitedCleanly(): Promise<number> {
		if (this.#nothrow) return this.#exited;
		return this.#exited.then(code => {
			if (code !== 0) throw new NonZeroExitError(code, this.#stderrTail);
			return code;
		});
	}

	/** Returns the truncated stderr tail (last 32KB). */
	peekStderr() {
		return this.#stderrTail;
	}

	nothrow(): this {
		this.#nothrow = true;
		return this;
	}

	kill(reason?: Exception, gracefulMs?: number) {
		// A kill makes the exit promise reject. Its caller may wait later or never,
		// as with a signal or a deadline, so that rejection is never left unhandled.
		this.#exited.catch(() => {});
		if (reason && !this.#exitReasonPending) {
			this.#exitReasonPending = reason;
			// The normalized exit promise may already have resolved from a dead
			// group leader; wait() still needs to report the later deadline.
			if (this.proc.exitCode !== null) this.#exitReason = reason;
		}
		// A command under the Linux subreaper is stopped without ever signalling
		// the subreaper politely: SIGTERM would end it, its orphaned descendants
		// would reparent to init, and the SIGKILL that follows would not find a
		// descendant that ignored SIGTERM. One stop sequence serves every kill
		// request; a hard request during its grace period ends the grace early.
		if (this.#subreaperStop) {
			if (gracefulMs !== undefined && gracefulMs < 0) this.#subreaperStop.escalate();
			return;
		}
		if (this.#hardKillTree && this.proc.exitCode === null && this.proc.signalCode === null) {
			let root: Process | null = null;
			try {
				root = Process.fromPid(this.proc.pid);
			} catch {
				// No usable native handle: the direct-signal fallback below still ends the subreaper.
			}
			if (root) {
				const { promise: escalated, resolve: escalate } = Promise.withResolvers<void>();
				const graceMs = gracefulMs === undefined ? 1000 : gracefulMs;
				if (graceMs < 0) escalate();
				// A stop that fails part-way (a native handle that cannot be used)
				// must not count as a finished termination: signal the subreaper directly.
				const stop = this.#stopSubreaperTree(root, graceMs, escalated).catch(() => this.#signalChild(graceMs));
				this.#subreaperStop = { escalate };
				this.#terminating = stop;
				return;
			}
		}
		if (
			this.proc.exitCode !== null &&
			this.#terminateGroup &&
			this.#openPipeReaders > 0 &&
			process.platform !== "win32"
		) {
			// Bun detached children are POSIX session/process-group leaders. If
			// the leader has exited, the native Process handle cannot rediscover
			// its PGID, but a pipe-holding descendant keeps that exact group alive.
			try {
				process.kill(-this.proc.pid, "SIGKILL");
			} catch {}
			this.#terminating = Promise.resolve();
			return;
		}
		if (this.proc.exitCode !== null && this.#windowsRootProcess && this.#openPipeReaders > 0) {
			// The retained handle keeps the dead root PID reserved, making the
			// Windows Toolhelp descendant walk identity-safe after root exit.
			// The root is dead: an unusable handle leaves nothing to signal.
			try {
				signalTree(this.#windowsRootProcess);
			} catch {}
			this.#terminating = Promise.resolve();
			return;
		}
		if (!this.proc.killed) {
			const options =
				gracefulMs === undefined
					? this.#terminateGroup
						? { group: true }
						: undefined
					: { gracefulMs, group: this.#terminateGroup };
			this.#terminating = this.#terminateTree(options);
		}
	}

	/**
	 * Native tree termination. A native handle that cannot be resolved or used
	 * — the PID left the process table, or a `bun test --isolate` realm whose
	 * napi classes another realm superseded ("Value is not an instance of class
	 * `Process`") — must not leave the child running, so signal it directly.
	 */
	#terminateTree(options: ProcessTerminateOptions | undefined): Promise<boolean | void> {
		const gracefulMs = options?.gracefulMs ?? 1000;
		try {
			const root = this.#windowsRootProcess ?? Process.fromPid(this.proc.pid);
			if (root) return root.terminate(options).catch(() => this.#signalChild(gracefulMs));
		} catch {}
		return this.#signalChild(gracefulMs);
	}

	/** SIGTERM the child (its group when it leads one), then SIGKILL if it outlives `gracefulMs`. */
	async #signalChild(gracefulMs: number): Promise<void> {
		const signal = (name: NodeJS.Signals) => {
			try {
				if (this.#terminateGroup && process.platform !== "win32") process.kill(-this.proc.pid, name);
				else this.proc.kill(name);
			} catch {}
		};
		if (gracefulMs >= 0) {
			signal("SIGTERM");
			await Promise.race([this.proc.exited, Bun.sleep(gracefulMs)]);
		}
		if (this.proc.exitCode === null && this.proc.signalCode === null) signal("SIGKILL");
	}

	/**
	 * Stop a subreaper-supervised command: SIGTERM to each of the subreaper's
	 * children and their trees (never the subreaper itself), then, after
	 * `gracefulMs`, the subreaper's own exit, or `escalated`, the hard sweep.
	 * A negative `gracefulMs` skips the SIGTERM; zero sends it and sweeps at once.
	 * The subreaper stays alive through the grace period, so a descendant
	 * orphaned in it is still the subreaper's child when the sweep runs.
	 *
	 * A subreaper with no child has not launched the command yet (or the
	 * command has ended). It is looked at again while frozen with SIGSTOP and,
	 * when still childless, killed, so a command cancelled before its launch
	 * never starts. The subreaper leads its own process group (see `subreaper`),
	 * so the native freeze and kill also signal that group. Linux delivers a
	 * group signal to the child of a fork in progress, and restarts that fork if
	 * the signal comes first, so the freeze and the kill reach a command the
	 * subreaper is launching even when another process resumes it between them.
	 * Signalling the subreaper alone would not: SIGSTOP does not end a fork in
	 * progress, and its child can appear after the read. The one escape is a
	 * command that leaves the group (setsid or setpgid, as coreutils `timeout`
	 * and job-control shells do) after its fork and before the kill, which needs
	 * another process to resume the frozen subreaper in that window.
	 * Freeze, kill and resume all go through `root`, the native handle pinned to
	 * the subreaper's identity, never through a pid this code holds: once the
	 * subreaper has been reaped and its pid reused, they signal nothing. The
	 * handle signals the group only while it sees the subreaper running, and
	 * the group is named by the subreaper's own pid, which a running process
	 * keeps. The resume runs on every way out of the frozen section, including
	 * a throw; it is a no-op on a killed subreaper. The grace timer is cleared
	 * as soon as the sequence moves on, so a finished stop never keeps the
	 * caller's process alive.
	 */
	async #stopSubreaperTree(root: Process, gracefulMs: number, escalated: Promise<void>): Promise<void> {
		// A walk that could not read every candidate (`undefined`) is no stop that failed: the
		// waves signalled what they read, and the hard sweep reads again at each pass.
		let children = childrenOf(root);
		if (children?.length === 0) {
			try {
				signalTree(root, os.constants.signals.SIGSTOP);
				children = childrenOf(root);
				if (children?.length === 0) {
					signalTree(root, 9);
					return;
				}
				// It launched the command just before the freeze: the first wave
				// goes to the snapshot taken while it cannot fork.
				for (const child of children ?? []) signalTree(child, gracefulMs < 0 ? 9 : 15);
			} finally {
				signalTree(root, os.constants.signals.SIGCONT);
			}
		} else {
			// The subreaper launches one command; once it has a child, no later launch can escape the snapshot.
			for (const child of children ?? []) signalTree(child, gracefulMs < 0 ? 9 : 15);
		}
		if (gracefulMs >= 0) {
			const { promise: graceOver, resolve: endGrace } = Promise.withResolvers<void>();
			const graceTimer = setTimeout(endGrace, gracefulMs);
			try {
				await Promise.race([this.proc.exited, graceOver, escalated]);
			} finally {
				clearTimeout(graceTimer);
			}
		}
		await this.#hardKillSubreaperTree(root);
	}

	async #hardKillSubreaperTree(root: Process): Promise<void> {
		try {
			const deadline = Date.now() + SUBREAPER_KILL_WINDOW_MS;
			let emptySweeps = 0;
			while (emptySweeps < 2 && Date.now() < deadline) {
				const children = childrenOf(root);
				// A sweep that could not read every child is no empty one: the next reads again.
				if (children?.length === 0) {
					emptySweeps++;
				} else {
					emptySweeps = 0;
					for (const child of children ?? []) signalTree(child, 9);
				}
				if (emptySweeps < 2) await Bun.sleep(SUBREAPER_KILL_POLL_MS);
			}
		} finally {
			signalTree(root, 9);
		}
	}

	// ── Output helpers ───────────────────────────────────────────────────

	async #throwIfAborted(): Promise<void> {
		// A kill() issued before Bun reports the root's exit only records the
		// reason as pending; output readers that do not wait for exit must still see it.
		const exitReason = this.#exitReason ?? this.#exitReasonPending;
		if (!exitReason?.aborted) return;
		if (this.#terminating) await this.#terminating;
		throw exitReason;
	}

	async text(): Promise<string> {
		const p = this.#readStream(this.proc.stdout);
		if (this.#nothrow) return p;
		const [text] = await Promise.all([p, this.exitedCleanly]);
		await this.#throwIfAborted();
		return text;
	}

	/**
	 * Read a pipe fully, stopping early only at an explicit command deadline or abort.
	 */
	async #readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stream.getReader();
		this.#openPipeReaders++;
		this.#pipeReaders.add(reader);
		this.#syncAbortListeners();
		const dec = new TextDecoder();
		let out = "";
		try {
			for (;;) {
				if (this.#cutoff) {
					await reader.cancel().catch(() => {});
					break;
				}
				const r = await reader.read();
				if (r.done) break;
				out += dec.decode(r.value, { stream: true });
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		}
		const tail = dec.decode();
		this.#pipeReaders.delete(reader);
		this.#openPipeReaders--;
		this.#syncAbortListeners();
		return out + tail;
	}

	async #readBytes(): Promise<Uint8Array<ArrayBuffer>> {
		const reader = this.proc.stdout.getReader();
		this.#openPipeReaders++;
		this.#pipeReaders.add(reader);
		this.#syncAbortListeners();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			for (;;) {
				if (this.#cutoff) {
					await reader.cancel().catch(() => {});
					break;
				}
				const r = await reader.read();
				if (r.done) break;
				chunks.push(r.value);
				length += r.value.byteLength;
			}
		} catch {
			// A cancelled or failed read keeps whatever was already collected.
		} finally {
			this.#pipeReaders.delete(reader);
			this.#openPipeReaders--;
			reader.releaseLock();
			this.#syncAbortListeners();
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}

	async #readOutputBytes(waitForCleanExit = false): Promise<Uint8Array<ArrayBuffer>> {
		const p = this.#readBytes();
		if (this.#nothrow) return p;
		const bytes = waitForCleanExit ? (await Promise.all([p, this.exitedCleanly]))[0] : await p;
		await this.#throwIfAborted();
		return bytes;
	}

	async blob(): Promise<Blob> {
		return new Blob([await this.#readOutputBytes(true)]);
	}

	async json(): Promise<unknown> {
		return JSON.parse(new TextDecoder().decode(await this.#readOutputBytes()));
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return (await this.#readOutputBytes()).buffer;
	}

	async bytes(): Promise<Uint8Array> {
		return this.#readOutputBytes();
	}

	// ── Wait ─────────────────────────────────────────────────────────────

	async wait(opts?: WaitOptions): Promise<ExecResult> {
		const { allowNonZero = false, allowAbort = false, stderr: stderrMode = "buffer" } = opts ?? {};
		const stderrChunks = this.#stderrChunks;
		if (stderrMode === "full" && !stderrChunks) {
			throw new Error('Full stderr capture must be requested when spawning the process (pass stderr: "full")');
		}

		const stdoutP = this.#readStream(this.proc.stdout);
		const stderrP =
			stderrMode === "full" && stderrChunks
				? this.#stderrDone.then(() => new TextDecoder().decode(Buffer.concat(stderrChunks)))
				: this.#stderrDone.then(() => this.#stderrTail);

		const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

		let exitError: Exception | undefined;
		try {
			await this.#exited;
		} catch (err) {
			if (err instanceof Exception) exitError = err;
			else throw err;
		}
		this.#clearTimeout();
		if (!exitError) exitError = this.exitReason;
		if (!exitError && this.exitCode !== null && this.exitCode !== 0) {
			exitError = new NonZeroExitError(this.exitCode, this.#stderrTail);
		}

		// On abort/timeout, hold the result until the tree is actually gone: the
		// native terminate() is graceful-first, and reporting before it finishes
		// would leave timed-out descendants alive past the caller's budget.
		if (exitError?.aborted && this.#terminating) await this.#terminating;

		const exitCode = this.exitCode ?? (exitError && !exitError.aborted ? exitError.exitCode : null);
		const ok = exitCode === 0;

		if (exitError) {
			if ((exitError.aborted && !allowAbort) || (!exitError.aborted && !allowNonZero)) throw exitError;
		}

		return { stdout, stderr, exitCode, ok, exitError };
	}

	// ── Signal / timeout ─────────────────────────────────────────────────

	attachSignal(signal: AbortSignal): void {
		this.#exited.catch(() => {});
		let attached = false;
		const onAbort = () => {
			// The { once: true } listener has removed itself at this point.
			attached = false;
			const rootRunning = this.proc.exitCode === null && this.proc.signalCode === null;
			if (rootRunning || this.#openPipeReaders > 0) {
				this.#abortRegistrations?.delete(sync);
			}
			this.kill(new AbortError(signal.reason, "<cancelled>"));
			this.#cutoffOutput();
		};
		const sync = () => {
			const rootRunning = this.proc.exitCode === null && this.proc.signalCode === null;
			const active = rootRunning || this.#openPipeReaders > 0;
			if (signal.aborted) {
				if (active) onAbort();
				return;
			}
			if (active === attached) return;
			if (active) signal.addEventListener("abort", onAbort, { once: true });
			else signal.removeEventListener("abort", onAbort);
			attached = active;
		};
		(this.#abortRegistrations ??= new Set()).add(sync);
		if (signal.aborted) onAbort();
		else sync();
	}

	#syncAbortListeners(): void {
		if (!this.#abortRegistrations) return;
		for (const sync of this.#abortRegistrations) sync();
	}

	#cutoffOutput(): void {
		this.#cutoff = true;
		for (const reader of this.#pipeReaders) reader.cancel().catch(() => {});
	}

	#clearTimeout(): void {
		if (!this.#timeoutTimer) return;
		clearTimeout(this.#timeoutTimer);
		this.#timeoutTimer = undefined;
	}

	attachTimeout(ms: number): void {
		// Not skipped for a root Bun already reports as exited (`proc.killed`): it can
		// exit before spawn() returns, while a descendant still holds its pipes.
		if (ms <= 0) return;
		this.#exited.catch(() => {});
		// One unref'd deadline controls both termination and pipe collection.
		// A clean command clears it in wait(), so fast invocations do not hold
		// the event loop for the unused remainder.
		const timer = setTimeout(() => {
			// A detached group can remain alive after its leader exits. Only use
			// the dead-leader fallback while an inherited pipe proves that exact
			// group still has a live member; this avoids stale-PGID reuse.
			if (
				this.proc.exitCode === null ||
				(this.#openPipeReaders > 0 && (this.#terminateGroup || this.#windowsRootProcess))
			) {
				this.kill(new TimeoutError(ms, this.#stderrTail), -1);
			}
			this.#cutoffOutput();
		}, ms);
		timer.unref?.();
		this.#timeoutTimer = timer;
	}

	[Symbol.dispose](): void {
		if (this.proc.exitCode !== null) return;
		this.kill(new AbortError("process disposed", this.#stderrTail));
	}
}

// ── Spawn / exec ─────────────────────────────────────────────────────────────

/** Options for child spawn. Always pipes stdout/stderr. */
type ChildSpawnOptions<In extends InMask = InMask> = Omit<
	Spawn.SpawnOptions<In, "pipe", "pipe">,
	"stdout" | "stderr" | "detached"
> & {
	signal?: AbortSignal;
	detached?: boolean;
	/**
	 * On Linux, supervise the command from a child subreaper so descendants
	 * remain reachable after changing session and reparenting. Other platforms
	 * ignore this option. macOS process groups cannot retain a daemonized
	 * descendant that creates a new session and reparents to launchd.
	 *
	 * On Linux, `subreaper` implies `detached`: the subreaper always leads its
	 * own process group and session. A stop signals that group, and Linux
	 * delivers a group signal to a child that a fork in progress adds, so a kill
	 * cannot miss a command the subreaper is launching. The new session has no
	 * controlling terminal, so the command cannot open `/dev/tty`, and terminal
	 * job control (Ctrl-C, Ctrl-Z) and a terminal hangup (SIGHUP) no longer reach
	 * it directly; stop it with `kill()`, `signal` or `timeout`. `detached:
	 * false` with `subreaper` contradicts this and is refused on every platform.
	 */
	subreaper?: boolean;
	/** Expose and retain complete stderr for a later `wait({ stderr: "full" })`. */
	stderr?: "full" | null;
};

function spawnInternal<In extends InMask = InMask>(
	cmd: string[],
	opts: ChildSpawnOptions<In> | undefined,
	retainFullStderr: boolean,
): ChildProcess<In> {
	const { timeout = -1, signal, stderr, detached, subreaper = false, ...rest } = opts ?? {};
	if (subreaper && detached === false) {
		throw new Error("subreaper implies detached: the subreaper leads its own process group (omit detached: false)");
	}
	const useSubreaper = subreaper && process.platform === "linux";
	// A subreaper leads its own group, so the stop's freeze and kill reach the
	// command it is forking (see `subreaper`).
	const leadsGroup = detached === true || useSubreaper;
	const commandEnv = rest.env ?? Bun.env;
	const child = Bun.spawn(useSubreaper ? [process.execPath, "-e", LINUX_SUBREAPER_SCRIPT] : cmd, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		detached: leadsGroup,
		...rest,
		env: useSubreaper
			? {
					...commandEnv,
					BUN_BE_BUN: "1",
					[LINUX_SUBREAPER_COMMAND_ENV]: JSON.stringify(cmd),
					[LINUX_SUBREAPER_BUN_BE_BUN_ENV]: commandEnv.BUN_BE_BUN,
				}
			: rest.env,
	});
	const cp = new ChildProcess(child, stderr === "full", retainFullStderr, leadsGroup, useSubreaper);
	if (signal) cp.attachSignal(signal);
	if (timeout > 0) cp.attachTimeout(timeout);
	return cp;
}

/** Spawn a child process with piped stdout/stderr. */
export function spawn<In extends InMask = InMask>(cmd: string[], opts?: ChildSpawnOptions<In>): ChildProcess<In> {
	return spawnInternal(cmd, opts, opts?.stderr === "full");
}

/** Options for exec. */
export interface ExecOptions extends Omit<ChildSpawnOptions, "stderr" | "stdin">, WaitOptions {
	input?: string | Buffer | Uint8Array;
	/**
	 * On Linux, run `cmd` as a tool process: with OOM adjustment 1000, which
	 * what it starts inherits, so the kernel kills it before this process
	 * when it picks one to kill for lack of memory; this process keeps its
	 * own value. A launcher, this build's runtime, sets the value and execs
	 * the program in its place: one runtime start per call. A program that
	 * cannot exec fails as its spawn fails without the option. Ignored
	 * elsewhere.
	 */
	toolOomScore?: boolean;
}

/** Spawn, wait, and return captured output. */
export async function exec(cmd: string[], opts?: ExecOptions): Promise<ExecResult> {
	const { toolOomScore, ...rest } = opts ?? {};
	if (toolOomScore && process.platform === "linux") return await execToolProcess(cmd, rest);
	const { input, stderr, allowAbort, allowNonZero, ...spawnOpts } = rest;
	const stdin = typeof input === "string" ? Buffer.from(input) : input;
	const resolved: ChildSpawnOptions = stdin === undefined ? spawnOpts : { ...spawnOpts, stdin };
	using child = spawnInternal(cmd, resolved, stderr === "full");
	return await child.wait({ stderr, allowAbort, allowNonZero });
}

/**
 * {@link exec} of `cmd` through the tool process launcher
 * ({@link TOOL_EXEC_SCRIPT}), which execs the file `Bun.spawn` would run.
 * Where there is no such file, or the launcher reports that its exec
 * failed, `cmd` is spawned itself, so the spawn fails with its own error.
 */
async function execToolProcess(cmd: string[], opts: ExecOptions): Promise<ExecResult> {
	const env = opts.env ?? Bun.env;
	const file = cmd[0] ? Bun.which(cmd[0], { PATH: env.PATH ?? "", cwd: opts.cwd }) : null;
	if (!file) return await exec(cmd, opts);
	const failed = `omp: tool exec failed ${crypto.randomUUID()}`;
	// This process's image, which `/proc/self/exe` then names in the launcher too.
	const launcher = [`/proc/${process.pid}/exe`, "-e", TOOL_EXEC_SCRIPT, "--", file, ...cmd];
	const launched = await exec(launcher, {
		...opts,
		env: {
			...env,
			BUN_BE_BUN: "1",
			[TOOL_EXEC_FAILED_ENV]: failed,
			[TOOL_EXEC_BUN_BE_BUN_ENV]: env.BUN_BE_BUN,
		},
	}).then(
		result => ({ result, stderr: result.stderr }),
		(error: unknown) => ({ error, stderr: error instanceof Exception ? error.stderr : "" }),
	);
	if (launched.stderr.includes(failed)) return await exec(cmd, opts);
	if ("error" in launched) throw launched.error;
	return launched.result;
}

// ── Signal combinators ───────────────────────────────────────────────────────

type SignalValue = AbortSignal | number | null | undefined;

/** Combine AbortSignals and timeout values into a single signal. */
export function combineSignals(...signals: SignalValue[]): AbortSignal | undefined {
	let timeout: number | undefined;

	let n = 0;
	for (let i = 0; i < signals.length; i++) {
		const s = signals[i];
		if (s instanceof AbortSignal) {
			if (s.aborted) return s;
			if (i !== n) signals[n] = s;
			n++;
		} else if (typeof s === "number" && s > 0) {
			timeout = timeout === undefined ? s : Math.min(timeout, s);
		}
	}
	if (timeout !== undefined) {
		signals[n] = AbortSignal.timeout(timeout);
		n++;
	}
	switch (n) {
		case 0:
			return undefined;
		case 1:
			return signals[0] as AbortSignal;
		default:
			return AbortSignal.any(signals.slice(0, n) as AbortSignal[]);
	}
}
