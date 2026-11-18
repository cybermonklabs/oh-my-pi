/**
 * How a local Cargo build (`build-bindings.ts`) puts its addon in place with the record of the
 * Rust sources it compiled.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type RustSources, settleRustSources, writeAddonSourcesStamp } from "../native/workspace-sources.js";

/** Copy `src` to `dest` under a temporary name and rename it into place. */
export async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${process.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		// Atomic rename - works even if dest is loaded on Linux/macOS (old inode stays valid)
		await fs.rename(tempPath, dest);
	} catch {
		// On Windows, loaded DLLs cannot be overwritten via rename
		// Try delete-then-rename as fallback
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				const isWindows = process.platform === "win32";
				throw new Error(
					`Cannot replace ${path.basename(dest)}${isWindows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkErr as Error).message}`,
				);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

/**
 * Put the addon a build left at `builtAddonPath` in place at `addonPath`, with the record of
 * the sources it was built from: `sourcesBeforeBuild`, settled (`settleRustSources`) before
 * anything is installed, as `scripts/bazel-natives.ts` does. A settle that throws (a listed
 * file that cannot be opened) installs nothing, so the old addon keeps the record that names
 * it. `build` holds the settings, kept to explain the addon and never compared.
 */
export async function installBuiltAddon(options: {
	builtAddonPath: string;
	addonPath: string;
	repoRoot: string;
	sourcesBeforeBuild: RustSources;
	build: Record<string, unknown>;
}): Promise<void> {
	const sources = settleRustSources(options.repoRoot, options.sourcesBeforeBuild);
	if (options.builtAddonPath !== options.addonPath) await installBinary(options.builtAddonPath, options.addonPath);
	writeAddonSourcesStamp(options.addonPath, sources, options.build);
}
