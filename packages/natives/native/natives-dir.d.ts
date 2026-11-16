/**
 * The natives directory: the native addon's per-version copies (`<dir>/<version>`) and the
 * downloaded tree-sitter grammars (`<dir>/grammars`). One directory per machine, shared by
 * the addon loader and `@oh-my-pi/pi-utils`: `PI_NATIVES_DIR`, then
 * `<OMP_DOWNLOAD_ROOT>/natives`, then (Linux and macOS) `$XDG_CACHE_HOME/omp/natives` when
 * `$XDG_CACHE_HOME/omp` exists, then `<OMP_CONFIG_ROOT or ~/<PI_CONFIG_DIR or .omp>>/natives`.
 */
export function getNativesDir(): string;
