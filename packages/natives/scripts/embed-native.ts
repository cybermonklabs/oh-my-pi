import * as fs from "node:fs/promises";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
	containsLegacyVersionSentinel,
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
} from "../native/version-sentinel.js";

const defaultNativeDir = path.join(import.meta.dir, "../native");

/**
 * zstd level for embedded addons. Each addon is its own frame with no
 * container header or timestamp, so identical addon bytes always embed
 * identically and consecutive binaries differ only where the addon did.
 */
export const EMBEDDED_ADDON_ZSTD_LEVEL = 19;

/** Platform/architecture pair whose addons a standalone binary embeds. */
export interface NativeEmbedTarget {
	readonly platform: string;
	readonly arch: string;
}

/** Inputs for {@link embeddedAddonFiles}. */
export interface EmbedOptions extends NativeEmbedTarget {
	/** Directory holding the built `pi_natives.*.node` addons; defaults to this package's `native/`. */
	readonly nativeDir?: string;
	/** Release every embedded addon must be stamped with; defaults to this package's version. */
	readonly version?: string;
}

/** One addon of a set {@link addonSetDigest} names. */
export interface AddonDigestEntry {
	readonly filename: string;
	/** SHA-256 of the addon's bytes, hex. */
	readonly sha256: string;
}

/**
 * The identity of a set of addons, computed when a binary or a native npm package
 * is built: SHA-256 over each `<filename>\0<sha256>\n`, in the order given, hex.
 * The loader names the directory it extracts or stages that set into
 * `<natives dir>/<version>-<first 12 hex digits>` and never computes it itself.
 */
export function addonSetDigest(files: readonly AddonDigestEntry[]): string {
	return new Bun.CryptoHasher("sha256")
		.update(files.map(({ filename, sha256 }) => `${filename}\0${sha256}\n`).join(""))
		.digest("hex");
}

/**
 * Build the in-memory `Bun.build({ files })` overrides that embed one target's
 * addons into a standalone binary: one `<addon>.node.zst` zstd frame per addon
 * variant and a replacement for the checked-in null `native/embedded-addon.js`
 * manifest that points at them. Output is a pure function of the addon bytes
 * (no timestamps, no container), which keeps release-to-release binary patches
 * small.
 *
 * The manifest carries each addon's SHA-256 and a `digest` of the whole set,
 * computed here so a start never hashes an addon it does not extract. The
 * loader extracts into `<natives dir>/<version>-<first 12 hex of digest>`, so
 * two builds of one release never share an extracted file.
 *
 * Nothing is written to disk. Bun.build shares the runtime's directory cache
 * and never re-reads it on a miss, so a process that imported pi-natives before
 * writing the frames cannot resolve them; in-memory files bypass that lookup.
 *
 * @throws when no addon exists for the target, or when an addon lacks the
 * `@oh-my-pi/pi-natives@<version>` version stamp and legacy sentinel.
 */
export async function embeddedAddonFiles({
	platform,
	arch,
	nativeDir = defaultNativeDir,
	version = packageJson.version,
}: EmbedOptions): Promise<Record<string, string | Uint8Array>> {
	const platformTag = `${platform}-${arch}`;
	const candidates =
		arch === "x64"
			? [
					{ variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
					{ variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
				]
			: [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];

	// Override keys must equal the bundler's symlink-resolved module paths.
	const dir = await fs.realpath(nativeDir);
	const present = new Set(await fs.readdir(dir));
	const available = await Promise.all(
		candidates
			.filter(candidate => present.has(candidate.filename))
			.map(async candidate => ({ ...candidate, bytes: await fs.readFile(path.join(dir, candidate.filename)) })),
	);
	if (available.length === 0) {
		const expected = candidates.map(candidate => `  - ${candidate.filename}`).join("\n");
		throw new Error(`No native addons found for ${platformTag}. Expected one of:\n${expected}`);
	}
	for (const { filename, bytes } of available) {
		// Pre-stamp addons (npm releases and main builds before the stamp slot)
		// identify their release by the legacy export, which the loader accepts.
		if (!containsVersionStamp(bytes, version) && !containsLegacyVersionSentinel(bytes, version)) {
			const addonPath = path.join(dir, filename);
			throw new Error(
				`Native addon ${addonPath} does not carry the @oh-my-pi/pi-natives@${version} version stamp ` +
					`\`${VERSION_STAMP_MAGIC}${version}\`. Rebuild it (installs stamp automatically), run ` +
					`\`bun scripts/stamp-native-version.ts ${addonPath}\`, or fetch @oh-my-pi/pi-natives-${platformTag}@${version} before embedding.`,
			);
		}
	}

	// Variants compress concurrently on Bun's thread pool.
	const frames = await Promise.all(
		available.map(({ bytes }) => Bun.zstdCompress(bytes, { level: EMBEDDED_ADDON_ZSTD_LEVEL })),
	);
	const sha256s = available.map(({ bytes }) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
	const imports = available.map(
		({ filename }, index) =>
			`import zstdPath${index} from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };`,
	);
	const files = available.map(
		({ variant, filename, bytes }, index) =>
			`{ variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${bytes.length}, sha256: ${JSON.stringify(sha256s[index])}, zstdPath: zstdPath${index} }`,
	);
	const digest = addonSetDigest(available.map(({ filename }, index) => ({ filename, sha256: sha256s[index] })));
	const manifest = `${imports.join("\n")}

export const embeddedAddon = {
	platformTag: ${JSON.stringify(platformTag)},
	version: ${JSON.stringify(version)},
	digest: ${JSON.stringify(digest)},
	files: [
		${files.join(",\n\t\t")},
	],
};
`;

	const overrides: Record<string, string | Uint8Array> = {};
	available.forEach(({ filename }, index) => {
		overrides[path.join(dir, `${filename}.zst`)] = frames[index];
	});
	overrides[path.join(dir, "embedded-addon.js")] = manifest;
	return overrides;
}
