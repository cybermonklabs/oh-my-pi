/**
 * A baseline below 1000 for tests of the OOM adjustment of tool processes: a tool process sets 1000, and
 * a test that a tool process of this build runs (a bash tool command) starts at 1000 already, so a child
 * that reads 1000 shows that its spawn set it only where this process holds less.
 */
const SCORE = "/proc/self/oom_score_adj";

/**
 * Whether this process can hold an OOM adjustment below 1000 (Linux): a child of it tries, so this
 * process keeps its own value. Not where a privileged writer set 1000 as its minimum, or `/proc` is not
 * writable; the tests that read a tool process's 1000 skip there.
 */
export const BELOW_TOOL_SCORE =
	process.platform === "linux" &&
	Bun.spawnSync([
		"/bin/sh",
		"-c",
		`{ read -r s < ${SCORE}; [ "$s" -lt 1000 ] || printf 999 > ${SCORE}; read -r s < ${SCORE}; [ "$s" -lt 1000 ]; } 2>/dev/null`,
	]).exitCode === 0;

/**
 * Run `test` with this process's OOM adjustment below 1000, passed as `baseline`, then restore the value
 * the process had: raising it back needs no privilege. Fails where the value stays at 1000.
 */
export async function withBelowToolScore<T>(test: (baseline: string) => Promise<T>): Promise<T> {
	const original = await Bun.file(SCORE).text();
	const lowered = original.trim() === "1000";
	if (lowered) await Bun.write(SCORE, "999");
	try {
		const baseline = await Bun.file(SCORE).text();
		if (baseline.trim() === "1000") throw new Error("this process's OOM adjustment stayed at 1000");
		return await test(baseline);
	} finally {
		if (lowered) await Bun.write(SCORE, original);
	}
}
