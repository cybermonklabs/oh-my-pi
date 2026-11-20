const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * True when the process is an explicitly marked test child or Bun is running a test entrypoint.
 *
 * A process a test spawns, such as an omp CLI, has a production entrypoint, so only the
 * `PI_TEST_RUNTIME=1` marker it inherits makes it a test child. In this repository a
 * `bun test` started at the root or in a workspace with tests preloads
 * `scripts/test-preload.ts`, which puts that marker in the environment every child inherits.
 */
export function isBunTestRuntime(): boolean {
	return Bun.env.PI_TEST_RUNTIME === "1" || isBunTestProcess();
}

/**
 * True in the process `bun test` runs the test files in, as against a child a test starts: its
 * entrypoint is a test file. In this repository that process starts from the environment the
 * test preload (`scripts/test-preload.ts`) left, which the copy of the launch environment the
 * kernel keeps (`/proc/self/environ`) does not show.
 */
export function isBunTestProcess(): boolean {
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
}
