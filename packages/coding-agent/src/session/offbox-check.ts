/**
 * The off-box check (`session.sql.offboxCheck`): a configured command that
 * says whether one session's transcripts may leave this machine for the SQL
 * session database. {@link OffboxSessionStorage} runs it once per session
 * (and once per subagent transcript) before that session's first database
 * write; this module only runs the command and reads its verdict.
 *
 * The command runs without a shell. Each argument has `{cwd}`, `{sessionId}`
 * and `{sessionFile}` replaced, a leading `~` in the program path is the home
 * directory, the working directory is the session's, and the environment
 * carries `OMP_SESSION_ID`, `OMP_SESSION_CWD` and `OMP_SESSION_FILE`. Exit 0
 * lets the session go; any other exit, a signal, a command that cannot start,
 * or one still running at the timeout refuses it (fail closed).
 */
import { toError } from "@oh-my-pi/pi-utils";
import { expandTilde } from "../tools/path-utils";

/** Most bytes kept of each output stream: the verdict needs only the first line. */
const OUTPUT_LIMIT_BYTES = 64 * 1024;

/**
 * How long a finished check's output may stay open: a background process the
 * check left behind can hold its pipes after it exits, and the verdict must
 * not wait for that process.
 */
const OUTPUT_GRACE_MS = 1000;

const PLACEHOLDER_RE = /\{(cwd|sessionId|sessionFile)\}/g;

export interface OffboxCheck {
	/** Program and arguments, before substitution. Never empty. */
	readonly argv: readonly string[];
	/** Milliseconds the command may run before it is killed and the session refused. */
	readonly timeoutMs: number;
}

/** The session a check is about. */
export interface OffboxSubject {
	/** The working directory the session's header records. */
	readonly cwd: string;
	readonly sessionId: string;
	/** The session's local transcript path. */
	readonly sessionFile: string;
}

export interface OffboxVerdict {
	readonly allowed: boolean;
	/** Why a refused session was refused: the outcome and the command's first output line. */
	readonly reason?: string;
}

/** `argv` with every placeholder replaced; the program path's leading `~` expanded. */
export function offboxCheckCommand(argv: readonly string[], subject: OffboxSubject): string[] {
	const values: Record<string, string> = {
		cwd: subject.cwd,
		sessionId: subject.sessionId,
		sessionFile: subject.sessionFile,
	};
	return argv.map((arg, index) => {
		const substituted = arg.replace(PLACEHOLDER_RE, (_match, name: string) => values[name] ?? "");
		return index === 0 ? expandTilde(substituted) : substituted;
	});
}

interface OutputCollector {
	/** Settles when the stream ends, or once {@link OutputCollector.stop} cancels it. */
	readonly done: Promise<void>;
	stop(): void;
	text(): string;
}

/** Collect up to {@link OUTPUT_LIMIT_BYTES} of `stream`. */
function collectOutput(stream: ReadableStream<Uint8Array>): OutputCollector {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	const done = (async () => {
		try {
			for (;;) {
				const read = await reader.read();
				if (read.done) return;
				if (size >= OUTPUT_LIMIT_BYTES) continue;
				const kept = read.value.subarray(0, OUTPUT_LIMIT_BYTES - size);
				chunks.push(kept);
				size += kept.length;
			}
		} catch {
			// Cancelled by stop(), or the pipe broke: keep what was read.
		}
	})();
	return {
		done,
		stop: () => {
			void reader.cancel().catch(() => {});
		},
		text: () => Buffer.concat(chunks).toString("utf-8"),
	};
}

function firstLine(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function withOutput(outcome: string, stderr: string, stdout: string): string {
	const line = firstLine(stderr) ?? firstLine(stdout);
	return line ? `${outcome}: ${line}` : outcome;
}

/** Run `check` for `subject` and read its verdict. Never throws: every failure is a refusal. */
export async function runOffboxCheck(check: OffboxCheck, subject: OffboxSubject): Promise<OffboxVerdict> {
	const command = offboxCheckCommand(check.argv, subject);
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn(command, {
			cwd: subject.cwd,
			env: {
				...process.env,
				OMP_SESSION_ID: subject.sessionId,
				OMP_SESSION_CWD: subject.cwd,
				OMP_SESSION_FILE: subject.sessionFile,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		return { allowed: false, reason: `the check could not start: ${toError(err).message}` };
	}
	const stdout = collectOutput(child.stdout);
	const stderr = collectOutput(child.stderr);
	const { promise: timedOut, resolve: timeUp } = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => timeUp("timeout"), check.timeoutMs);
	let outcome: number | "timeout" | Error;
	try {
		outcome = await Promise.race([child.exited, timedOut]);
	} catch (err) {
		outcome = toError(err);
	} finally {
		clearTimeout(timer);
	}
	if (outcome === "timeout") child.kill("SIGKILL");
	const { promise: grace, resolve: graceOver } = Promise.withResolvers<void>();
	const graceTimer = setTimeout(graceOver, OUTPUT_GRACE_MS);
	await Promise.race([Promise.all([stdout.done, stderr.done]), grace]);
	clearTimeout(graceTimer);
	stdout.stop();
	stderr.stop();
	const out = stdout.text();
	const err = stderr.text();
	if (outcome === "timeout") {
		return { allowed: false, reason: withOutput(`the check ran past ${check.timeoutMs} ms`, err, out) };
	}
	if (outcome instanceof Error) {
		return { allowed: false, reason: withOutput(`the check failed: ${outcome.message}`, err, out) };
	}
	if (child.signalCode) {
		return { allowed: false, reason: withOutput(`the check was killed by ${child.signalCode}`, err, out) };
	}
	if (outcome !== 0) return { allowed: false, reason: withOutput(`the check exited ${outcome}`, err, out) };
	return { allowed: true };
}
