/**
 * How a native build (`build-bindings.ts`, `scripts/bazel-natives.ts`) puts its addons in place
 * with the record of the Rust sources it compiled.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { addonSourcesStampPath } from "../native/workspace-sources.js";
import { type RustSources, settleRustSources, writeAddonSourcesStamp } from "./rust-sources";

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
 * Put each addon a build left (`built`) in place at its `destination`, with the record of the
 * sources it was built from: `sourcesBeforeBuild`, settled (`settleRustSources`) once, before
 * anything is installed, so a settle that throws (a listed file that cannot be opened) installs
 * nothing and every old addon keeps the record that names it. `install` puts one addon in place
 * (by default `installBinary`, and nothing when the build left it at its destination); its
 * record is written right after. Without `sourcesBeforeBuild` (prebuilt addons, whose sources
 * are unknown) each destination's record is removed. `build` holds the settings, kept to explain
 * an addon and never compared. Returns what `install` returned for each addon, in order.
 */
export async function installBuiltAddon<T = void>(options: {
	addons: readonly { built: string; destination: string }[];
	repoRoot: string;
	sourcesBeforeBuild?: RustSources;
	build: Record<string, unknown>;
	install?: (built: string, destination: string) => Promise<T>;
}): Promise<T[]> {
	const install =
		options.install ??
		(async (built: string, destination: string) => {
			if (built !== destination) await installBinary(built, destination);
		});
	const sources = options.sourcesBeforeBuild && settleRustSources(options.repoRoot, options.sourcesBeforeBuild);
	const results: T[] = [];
	for (const { built, destination } of options.addons) {
		results.push((await install(built, destination)) as T);
		if (sources) writeAddonSourcesStamp(destination, sources, options.build);
		else await fs.rm(addonSourcesStampPath(destination), { force: true });
	}
	return results;
}
