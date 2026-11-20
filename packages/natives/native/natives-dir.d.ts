/**
 * The natives directory: the native addon's cached copies (`<dir>/<version>-<digest prefix>`
 * per compiled build and per Windows install's leaf package) and the
 * downloaded tree-sitter grammars (`<dir>/grammars`). Shared by the addon loader and
 * `@oh-my-pi/pi-utils`, and one answer per process: the first call resolves it, and every
 * later call in the process and its worker threads returns that answer, so a directory
 * variable set later (by a `.env` file, say) moves nothing. A child process that is omp takes
 * its parent's answer from a handoff ({@link NATIVES_DIR_HANDOFF_ENV_KEY}); any other child
 * resolves for itself. The first call reads
 * `PI_NATIVES_DIR`, then `<OMP_DOWNLOAD_ROOT>/natives`, then (Linux and macOS)
 * `$XDG_CACHE_HOME/omp/natives` when `$XDG_CACHE_HOME/omp` exists, then
 * `<OMP_CONFIG_ROOT or ~/<PI_CONFIG_DIR or .omp>>/natives`.
 */
export function getNativesDir(): string;

/**
 * Hidden variable by which omp hands its answer to a child process that is omp. A process takes
 * it only when its own values of the rule's inputs are the recorded ones and the recorded
 * parent is its parent or no longer runs (the child was re-parented; on Linux a zombie no
 * longer runs, elsewhere it counts as running); it then removes the variable from
 * `process.env`. An empty value is no handoff.
 */
export const NATIVES_DIR_HANDOFF_ENV_KEY: "__PI_NATIVES_DIR_HANDOFF";

/**
 * The handoff value for a child process whose environment is `env`: this process's answer, or
 * `dir`, for a process whose parent is `parent`.
 */
export function nativesDirHandoff(
	env: Record<string, string | undefined>,
	options: { parent: number; dir?: string },
): string;

/**
 * The directory a handoff value hands over, or undefined for a value this module did not
 * write (an empty one included). With `addressee`, also undefined unless the value was
 * written for a process whose environment is `env` and whose parent is, or was, the
 * recorded one.
 */
export function nativesDirHandoffDir(
	value: string | undefined,
	addressee?: { env: Record<string, string | undefined>; ppid: number },
): string | undefined;

/**
 * Whether this process was started with a natives-directory handoff, taken or not (an omp
 * worker, its launch broker, an omp daemon): its native shell and its spawns with no `env`
 * start from an environment that holds one, which a command must not carry.
 */
export function startedWithNativesDirHandoff(): boolean;

/** Forget this process's answer, so a test can resolve again from a changed environment. */
export function __resetNativesDirForTests(): void;
