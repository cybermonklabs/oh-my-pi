import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * An absolute directory from an override variable (`~` expanded), or undefined for a
 * relative or empty value.
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function resolveAbsoluteDir(value) {
	let dir = value?.trim();
	if (!dir) return undefined;
	if (dir === "~") dir = os.homedir();
	else if (dir.startsWith("~/") || dir.startsWith("~\\")) dir = os.homedir() + dir.slice(1);
	return path.isAbsolute(dir) ? path.normalize(dir) : undefined;
}

/**
 * The natives directory: the native addon's per-version copies (`<dir>/<version>`) and the
 * tree-sitter grammars the agent downloads (`<dir>/grammars`). The addon loader and
 * `@oh-my-pi/pi-utils` both call this, so the grammars the agent installs are the ones the
 * addon loads.
 *
 * It is one directory per machine, never per profile: the loader fixes the addon's grammar
 * directory once, when the addon loads, and the profile can change later in the process.
 * Read on every call, in order:
 * 1. `PI_NATIVES_DIR`;
 * 2. `<OMP_DOWNLOAD_ROOT>/natives`;
 * 3. on Linux and macOS, `$XDG_CACHE_HOME/omp/natives` when `$XDG_CACHE_HOME/omp` exists;
 * 4. `<config root>/natives`, where the config root is `OMP_CONFIG_ROOT`, else
 *    `~/<PI_CONFIG_DIR>` (default `~/.omp`).
 * Each override is trimmed and `~`-expanded; an empty or relative value is ignored.
 * @returns {string}
 */
export function getNativesDir() {
	const override = resolveAbsoluteDir(process.env.PI_NATIVES_DIR);
	if (override) return override;
	const downloadRoot = resolveAbsoluteDir(process.env.OMP_DOWNLOAD_ROOT);
	if (downloadRoot) return path.join(downloadRoot, "natives");
	const xdgCacheHome = process.env.XDG_CACHE_HOME;
	if ((process.platform === "linux" || process.platform === "darwin") && xdgCacheHome) {
		const appRoot = path.join(xdgCacheHome, "omp");
		if (fs.existsSync(appRoot)) return path.join(appRoot, "natives");
	}
	const configRoot =
		resolveAbsoluteDir(process.env.OMP_CONFIG_ROOT) ?? path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp");
	return path.join(configRoot, "natives");
}
