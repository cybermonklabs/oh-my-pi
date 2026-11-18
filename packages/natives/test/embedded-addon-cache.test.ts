/**
 * The extracted-addon cache of a compiled binary, under `<nativesDir>`.
 *
 * Every build of one release carries the same version, and a size can match by
 * chance or on purpose, so neither may decide whether a cached addon is this
 * build's. Each build extracts into `<version>-<digest>`, named by the digest of
 * the addons it embeds (computed when the binary is built), so a build only ever
 * reads the files it wrote itself, and two builds run in turn keep one copy each.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__setAddonFileIoForTests,
	cleanupStaleNativeVersions,
	type EmbeddedAddon,
	type EmbeddedAddonFile,
	extractEmbeddedAddons,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddonFiles } from "../scripts/embed-native";
import { durableWriteCalls, recordingFs } from "./recording-fs";

const version = packageJson.version;
const tag = `${process.platform}-${process.arch}`;
const addonFilenames =
	process.arch === "x64"
		? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`]
		: [`pi_natives.${tag}.node`];
const loaderDir = path.join(import.meta.dir, "../native");
const repoRoot = path.resolve(import.meta.dir, "../../..");
const DAY_MS = 24 * 60 * 60_000;

function sha256(bytes: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface Build {
	readonly binary: string;
	readonly manifest: EmbeddedAddon;
	/** Addon bytes by filename. */
	readonly addons: ReadonlyMap<string, string>;
}

/**
 * Compile a probe binary embedding fake addons, as a release build embeds the real ones.
 * Builds "A" and "B" embed addons of the same size and version stamp, different bytes.
 */
async function compileBuild(root: string, name: "A" | "B"): Promise<Build> {
	const dir = path.join(root, name);
	const nativeDir = path.join(dir, "native");
	const addons = new Map(
		addonFilenames.map(filename => [filename, `build ${name} ${filename} PI_NATIVES_VERSION_STAMP:${version}\0`]),
	);
	for (const [filename, bytes] of addons) await Bun.write(path.join(nativeDir, filename), bytes);
	const embedded = await embeddedAddonFiles({ platform: process.platform, arch: process.arch, nativeDir, version });

	// The manifest the binary carries, read back from a copy of the generated files; dynamic
	// because it is generated into this test's temp dir.
	const manifestDir = path.join(dir, "manifest");
	for (const file in embedded) await Bun.write(path.join(manifestDir, path.basename(file)), embedded[file]);
	const { embeddedAddon: manifest }: { embeddedAddon: EmbeddedAddon } = await import(
		path.join(manifestDir, "embedded-addon.js")
	);

	const files: Record<string, string | Uint8Array> = {};
	for (const file in embedded) files[path.join(loaderDir, path.basename(file))] = embedded[file];
	const entry = path.join(dir, "entry.ts");
	await Bun.write(
		entry,
		`import { loadNative } from ${JSON.stringify(path.join(loaderDir, "loader-state.js"))};\n` +
			`try { loadNative(); console.log("loaded"); } catch (err) { console.log(err instanceof Error ? err.message : String(err)); }\n`,
	);
	const binary = path.join(dir, process.platform === "win32" ? "probe.exe" : "probe");
	const build = await Bun.build({
		entrypoints: [entry],
		root: repoRoot,
		target: "bun",
		format: "esm",
		files,
		compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
	});
	expect(build.success).toBe(true);
	return { binary, manifest, addons };
}

/** Start a build once against `nativesDir`; returns the addon path its loader tried first. */
async function start(build: Build, nativesDir: string): Promise<string> {
	const env: Record<string, string | undefined> = { ...process.env, PI_NATIVES_DIR: nativesDir };
	delete env.__PI_NATIVE_VARIANT_CACHE;
	if (process.arch === "x64") env.PI_NATIVE_VARIANT = "modern";
	const child = Bun.spawn([build.binary], { env, stdout: "pipe", stderr: "ignore" });
	const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	expect(exitCode).toBe(0);
	// The fake addons never load, so the loader reports every path it tried, in order.
	const tried = output.split("\n").find(line => line.startsWith("- "));
	if (!tried) throw new Error(`the loader reported no tried path:\n${output}`);
	return tried.slice(2, tried.indexOf(".node: ") + ".node".length);
}

/** Every file under `dir` with the identity a rewrite would change. */
async function snapshot(dir: string): Promise<Record<string, { ino: number; mtimeMs: number; size: number }>> {
	const files: Record<string, { ino: number; mtimeMs: number; size: number }> = {};
	for (const entry of await fs.readdir(dir, { recursive: true })) {
		const stat = await fs.stat(path.join(dir, entry));
		if (stat.isFile()) files[entry] = { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
	}
	return files;
}

function buildDir(nativesDir: string, build: Build): string {
	return path.join(nativesDir, `${version}-${build.manifest.digest.slice(0, 12)}`);
}

describe("compiled binaries sharing one natives directory", () => {
	let root = "";
	let buildA: Build;
	let buildB: Build;

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-builds-"));
		[buildA, buildB] = await Promise.all([compileBuild(root, "A"), compileBuild(root, "B")]);
		for (const filename of addonFilenames) {
			expect(buildA.addons.get(filename)?.length).toBe(buildB.addons.get(filename)?.length);
		}
		expect(buildA.manifest.digest).not.toBe(buildB.manifest.digest);
	}, 300_000);

	afterAll(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	it("never loads a same-size addon another build left", async () => {
		const nativesDir = path.join(root, "natives-defect");
		await start(buildA, nativesDir);

		const tried = await start(buildB, nativesDir);

		expect(await Bun.file(tried).text()).toBe(buildB.addons.get(addonFilenames[0])!);
		expect(path.dirname(tried)).toBe(buildDir(nativesDir, buildB));
		for (const filename of addonFilenames) {
			expect(await Bun.file(path.join(buildDir(nativesDir, buildA), filename)).text()).toBe(
				buildA.addons.get(filename)!,
			);
		}
	}, 120_000);

	it("extracts each build's addons once when the builds run in turn", async () => {
		const nativesDir = path.join(root, "natives-alternate");
		await start(buildA, nativesDir);
		await start(buildB, nativesDir);
		const afterBothExtracted = await snapshot(nativesDir);

		const tried = await start(buildA, nativesDir);

		expect(await snapshot(nativesDir)).toEqual(afterBothExtracted);
		expect(path.dirname(tried)).toBe(buildDir(nativesDir, buildA));
		expect(Object.keys(afterBothExtracted).sort()).toEqual(
			[buildA, buildB]
				.flatMap(build =>
					addonFilenames.map(filename => path.join(path.basename(buildDir(nativesDir, build)), filename)),
				)
				.sort(),
		);
		for (const build of [buildA, buildB]) {
			for (const filename of addonFilenames) {
				expect(await Bun.file(path.join(buildDir(nativesDir, build), filename)).text()).toBe(
					build.addons.get(filename)!,
				);
			}
		}
	}, 120_000);
});

describe("a compiled binary whose cache directory cleanup claims during the start", () => {
	// The real addon this checkout built: the load must succeed for the start to count.
	const realAddon = addonFilenames.find(filename => nodeFs.existsSync(path.join(loaderDir, filename)));
	let root = "";
	let binary = "";
	let digest = "";

	beforeAll(async () => {
		if (!realAddon) throw new Error(`no built addon in ${loaderDir}; run \`bun run build:native\``);
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-claimed-"));
		const nativeDir = path.join(root, "native");
		await fs.mkdir(nativeDir);
		await fs.copyFile(path.join(loaderDir, realAddon), path.join(nativeDir, realAddon));
		const embedded = await embeddedAddonFiles({ platform: process.platform, arch: process.arch, nativeDir, version });
		const files: Record<string, string | Uint8Array> = {};
		for (const file in embedded) files[path.join(loaderDir, path.basename(file))] = embedded[file];
		digest = /digest: "([0-9a-f]{64})"/.exec(String(files[path.join(loaderDir, "embedded-addon.js")]))?.[1] ?? "";
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		const entry = path.join(root, "entry.ts");
		// With PROBE_CLAIM set, cleanup in another process claims the cache directory (renames
		// it to its private name) right after the loader's check found the addon there. With
		// PROBE_CLAIM=putback, cleanup then renames it back (a start had marked it used) before
		// the loader next asks whether the file is there.
		await Bun.write(
			entry,
			[
				`import * as fs from "node:fs";`,
				`import * as path from "node:path";`,
				`import { __setAddonFileIoForTests, loadNative } from ${JSON.stringify(path.join(loaderDir, "loader-state.js"))};`,
				`let claimed = null;`,
				`let dir = null;`,
				`let putBack = false;`,
				`const io = { ...fs, statSync(target, ...rest) {`,
				`	const stat = fs.statSync(target, ...rest);`,
				`	if (process.env.PROBE_CLAIM && !claimed && String(target).endsWith(".node") && stat.isFile()) {`,
				`		dir = path.dirname(String(target));`,
				`		claimed = path.join(path.dirname(dir), "." + path.basename(dir) + ".removing.1." + crypto.randomUUID());`,
				`		fs.renameSync(dir, claimed);`,
				`	}`,
				`	return stat;`,
				`}, existsSync(target) {`,
				`	if (process.env.PROBE_CLAIM === "putback" && claimed && !putBack && String(target).endsWith(".node")) {`,
				`		putBack = true;`,
				`		fs.renameSync(claimed, dir);`,
				`	}`,
				`	return fs.existsSync(target);`,
				`} };`,
				`__setAddonFileIoForTests(io);`,
				`try { loadNative(); console.log(JSON.stringify({ loaded: true, claimed, putBack })); }`,
				`catch (err) { console.log(JSON.stringify({ loaded: false, claimed, error: String(err?.message ?? err).split("\\n").slice(0, 4).join(" | ") })); }`,
			].join("\n"),
		);
		binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
		const build = await Bun.build({
			entrypoints: [entry],
			root: repoRoot,
			target: "bun",
			format: "esm",
			files,
			compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
		});
		expect(build.success).toBe(true);
	}, 600_000);

	afterAll(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	async function probe(nativesDir: string, claim: "" | "stay" | "putback") {
		const env: Record<string, string | undefined> = { ...process.env, PI_NATIVES_DIR: nativesDir };
		delete env.__PI_NATIVE_VARIANT_CACHE;
		if (process.arch === "x64") env.PI_NATIVE_VARIANT = realAddon?.includes("-baseline") ? "baseline" : "modern";
		if (claim) env.PROBE_CLAIM = claim;
		else delete env.PROBE_CLAIM;
		const child = Bun.spawn([binary], { env, stdout: "pipe", stderr: "ignore" });
		const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(exitCode).toBe(0);
		return JSON.parse(output.trim().split("\n").at(-1)!) as {
			loaded: boolean;
			claimed: string | null;
			putBack?: boolean;
			error?: string;
		};
	}

	it("extracts the addon again and loads it when the directory stays away", async () => {
		const nativesDir = path.join(root, "natives-stay");
		expect(await probe(nativesDir, "")).toMatchObject({ loaded: true, claimed: null });

		const claimedStart = await probe(nativesDir, "stay");

		expect(claimedStart.claimed).toBeString();
		expect(claimedStart).toEqual({ loaded: true, claimed: claimedStart.claimed, putBack: false });
		const ownDir = path.join(nativesDir, `${version}-${digest.slice(0, 12)}`);
		expect(nodeFs.existsSync(path.join(ownDir, realAddon!))).toBe(true);
	}, 300_000);

	it("loads the addon again when cleanup put the directory back, extracting nothing", async () => {
		const nativesDir = path.join(root, "natives-putback");
		expect(await probe(nativesDir, "")).toMatchObject({ loaded: true, claimed: null });
		const ownAddon = path.join(nativesDir, `${version}-${digest.slice(0, 12)}`, realAddon!);
		const { ino } = await fs.stat(ownAddon);

		const claimedStart = await probe(nativesDir, "putback");

		expect(claimedStart).toEqual({ loaded: true, claimed: claimedStart.claimed, putBack: true });
		expect((await fs.stat(ownAddon)).ino).toBe(ino);
	}, 300_000);
});

describe("embedded addon extraction", () => {
	let root = "";

	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-extract-"));
	});

	afterAll(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	async function manifestFile(
		name: string,
		frameBytes: string,
		declaredBytes = frameBytes,
	): Promise<EmbeddedAddonFile> {
		const zstdPath = path.join(root, `${name}.node.zst`);
		await Bun.write(zstdPath, Bun.zstdCompressSync(Buffer.from(frameBytes)));
		return {
			variant: "default",
			filename: `${name}.node`,
			size: Buffer.byteLength(declaredBytes),
			sha256: sha256(declaredBytes),
			zstdPath,
		};
	}

	it("replaces a truncated cached addon", async () => {
		const targetDir = path.join(root, "truncated");
		const file = await manifestFile("truncated", "complete addon bytes");
		await Bun.write(path.join(targetDir, file.filename), "complete addon");

		expect(extractEmbeddedAddons({ files: [file], targetDir })).toEqual([path.join(targetDir, file.filename)]);
		expect(await Bun.file(path.join(targetDir, file.filename)).text()).toBe("complete addon bytes");
	});

	it("never writes an addon whose bytes do not match the manifest's digest", async () => {
		const targetDir = path.join(root, "corrupt");
		await fs.mkdir(targetDir);
		// Same size as the declared addon, other bytes: a corrupt frame passes a size check.
		const file = await manifestFile("corrupt", "addon bytes, version 2", "addon bytes, version 1");

		expect(() => extractEmbeddedAddons({ files: [file], targetDir })).toThrow(
			`Embedded addon digest mismatch for corrupt.node: expected sha256 ${sha256("addon bytes, version 1")}, got ${sha256("addon bytes, version 2")}`,
		);
		expect(await fs.readdir(targetDir)).toEqual([]);
	});

	it("syncs an extracted addon before renaming it into place, and its directory after", async () => {
		const targetDir = path.join(root, "durable");
		await fs.mkdir(targetDir);
		const file = await manifestFile("durable", "durable addon bytes");
		const { io, calls } = recordingFs();

		__setAddonFileIoForTests(io);
		try {
			extractEmbeddedAddons({ files: [file], targetDir });
		} finally {
			__setAddonFileIoForTests(undefined);
		}

		expect(calls).toEqual(durableWriteCalls(path.join(targetDir, file.filename), targetDir));
	});

	it("writes again into its directory when cleanup claimed it during the start", async () => {
		const targetDir = path.join(root, "claimed");
		await fs.mkdir(targetDir);
		const file = await manifestFile("claimed", "claimed addon bytes");
		let claimed = false;
		// Cleanup renames a directory away just after the start marked it used (it renames it
		// back, or a later start makes it again); the first write meets no directory.
		const io = {
			...nodeFs,
			openSync(target: nodeFs.PathLike, flags: nodeFs.OpenMode, mode?: nodeFs.Mode | null) {
				if (!claimed) {
					claimed = true;
					nodeFs.rmSync(targetDir, { recursive: true, force: true });
				}
				return nodeFs.openSync(target, flags, mode);
			},
		};

		__setAddonFileIoForTests(io);
		try {
			expect(extractEmbeddedAddons({ files: [file], targetDir })).toEqual([path.join(targetDir, file.filename)]);
		} finally {
			__setAddonFileIoForTests(undefined);
		}
		expect(await Bun.file(path.join(targetDir, file.filename)).text()).toBe("claimed addon bytes");
	});
});

describe("addon cache cleanup", () => {
	it("keeps this build's directory and every build's used within a day, and removes the rest", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-cleanup-"));
		const hourAgo = new Date(Date.now() - 60 * 60_000);
		const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
		const current = `${version}-aaaaaaaaaaaa`;
		const dirs: Record<string, { usedAt: Date; kept: boolean }> = {
			// This process's directory stays however old its timestamp.
			[current]: { usedAt: twoDaysAgo, kept: true },
			// Another build of this release, started an hour ago: a build run in turn with this one.
			[`${version}-bbbbbbbbbbbb`]: { usedAt: hourAgo, kept: true },
			// Another build of this release nobody started for two days.
			[`${version}-cccccccccccc`]: { usedAt: twoDaysAgo, kept: false },
			// The layout before build digests, for this release.
			[version]: { usedAt: twoDaysAgo, kept: false },
			// Older releases: one still started, one not.
			"15.10.12": { usedAt: hourAgo, kept: true },
			"15.10.11-dddddddddddd": { usedAt: twoDaysAgo, kept: false },
			// Names that are no addon cache.
			grammars: { usedAt: twoDaysAgo, kept: true },
			"not-a-version": { usedAt: twoDaysAgo, kept: true },
			"19.0.0-beta.1": { usedAt: twoDaysAgo, kept: true },
			[`${version}-not-a-digest`]: { usedAt: twoDaysAgo, kept: true },
		};
		try {
			for (const [name, { usedAt }] of Object.entries(dirs)) {
				await fs.mkdir(path.join(nativesDir, name));
				await fs.utimes(path.join(nativesDir, name), usedAt, usedAt);
			}
			await Bun.write(path.join(nativesDir, "README.txt"), "not a directory");
			await fs.utimes(path.join(nativesDir, "README.txt"), twoDaysAgo, twoDaysAgo);

			const removed = cleanupStaleNativeVersions({ nativesDir, currentDir: path.join(nativesDir, current) });

			const expectRemoved = Object.keys(dirs).filter(name => !dirs[name].kept);
			expect(removed.map(dir => path.basename(dir)).sort()).toEqual(expectRemoved.sort());
			expect((await fs.readdir(nativesDir)).sort()).toEqual(
				[...Object.keys(dirs).filter(name => dirs[name].kept), "README.txt"].sort(),
			);
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});

	it("keeps a directory a start marks used while cleanup is checking it", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-cleanup-race-"));
		const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
		const used = path.join(nativesDir, `${version}-bbbbbbbbbbbb`);
		try {
			await Bun.write(path.join(used, "pi_natives.node"), "another build's addon");
			await fs.utimes(used, twoDaysAgo, twoDaysAgo);
			let marked = false;
			// A start marks the directory used (`prepareNativeVersionDir`) right after cleanup
			// first read its time.
			const io = {
				...nodeFs,
				statSync(target: nodeFs.PathLike) {
					const stat = nodeFs.statSync(target);
					if (!marked && String(target) === used) {
						marked = true;
						nodeFs.utimesSync(used, new Date(), new Date());
					}
					return stat;
				},
			} as typeof nodeFs;

			__setAddonFileIoForTests(io);
			let removed: string[];
			try {
				removed = cleanupStaleNativeVersions({ nativesDir, currentDir: path.join(nativesDir, "none") });
			} finally {
				__setAddonFileIoForTests(undefined);
			}

			expect(marked).toBe(true);
			expect(removed).toEqual([]);
			expect(await fs.readdir(nativesDir)).toEqual([path.basename(used)]);
			expect(await Bun.file(path.join(used, "pi_natives.node")).text()).toBe("another build's addon");
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});

	it("removes what a stopped cleanup left once it is a day old", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-cleanup-left-"));
		const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS);
		const old = `.${version}-cccccccccccc.removing.4242.${crypto.randomUUID()}`;
		const recent = `.${version}-dddddddddddd.removing.4242.${crypto.randomUUID()}`;
		try {
			await fs.mkdir(path.join(nativesDir, old));
			await fs.utimes(path.join(nativesDir, old), twoDaysAgo, twoDaysAgo);
			await fs.mkdir(path.join(nativesDir, recent));

			cleanupStaleNativeVersions({ nativesDir, currentDir: path.join(nativesDir, "none") });

			expect(await fs.readdir(nativesDir)).toEqual([recent]);
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});
});
