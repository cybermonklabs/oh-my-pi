/**
 * Let a release that a refused adoption started (`hook`, what the release hook the adoption called returned) go as far
 * as it can before the run's end goes on. A release that waits for that end would hold the run here, so the wait is
 * bounded (only such a release reaches the bound); a fake clock would also stop the lifecycle's own release deadline.
 */
export async function letRefusedReleaseRun(hook: Promise<void> | undefined): Promise<void> {
	if (hook) await Promise.race([hook, Bun.sleep(1000)]);
}
