/**
 * The natives directory: the native addon's cached copies (`<dir>/<version>-<digest prefix>`
 * per compiled build and per Windows install's leaf package) and the
 * downloaded tree-sitter grammars (`<dir>/grammars`). Shared by the addon loader and
 * `@oh-my-pi/pi-utils`, and one answer per process: the first call resolves it, and every
 * later call in the process and its worker threads returns that answer, so a directory
 * variable set later (by a `.env` file, say) moves nothing. A child process resolves for
 * itself; omp passes the answer as `PI_NATIVES_DIR` only to its children that are omp. The
 * first call reads
 * `PI_NATIVES_DIR`, then `<OMP_DOWNLOAD_ROOT>/natives`, then (Linux and macOS)
 * `$XDG_CACHE_HOME/omp/natives` when `$XDG_CACHE_HOME/omp` exists, then
 * `<OMP_CONFIG_ROOT or ~/<PI_CONFIG_DIR or .omp>>/natives`.
 */
export function getNativesDir(): string;

/** Forget this process's answer, so a test can resolve again from a changed environment. */
export function __resetNativesDirForTests(): void;
