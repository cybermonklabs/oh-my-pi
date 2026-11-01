#!/usr/bin/env bun
/**
 * Builds what the verdict lane's heads (`cases-verdict.json`) point at, and
 * checks it.
 *
 *   setup - for every head: the read-only snapshot and patch (`snapshot.ts
 *           build`), its donor when the claim needs the code to run, and every
 *           material and working directory the head names, each from the
 *           source this file pins. Nothing that exists is rebuilt.
 *   check - `preflight` from run.ts over every head: what a run checks before
 *           it starts.
 *
 * Every source outside git is pinned by sha256 and refused when it differs: a
 * case is only as good as the bytes its run is shown.
 *
 * Usage:
 *   bun scripts/reviewer-gap/verdict-build.ts setup|check [--cases cases-verdict.json]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BATCH, REPO, ROOT } from "./claims-build.ts";
import { preflight } from "./run.ts";
import { build, makeDonor } from "./snapshot.ts";
import type { VerdictCaseFile } from "./verdict.ts";

const ADDON = "pi_natives.linux-x64-modern.node";

/** A file outside git, as the batch left it. */
interface Pinned {
	from: string;
	sha256: string;
}

/**
 * How one material or working directory is made: a file at a revision, a whole
 * tree at a revision (`git archive`), or a pinned file copied with some of its
 * lines removed (1-based, inclusive ranges). A removal is kept only when the
 * lines answer the question the case asks, and the reason is written here.
 */
export type Source =
	| { kind: "blob"; rev: string; file: string }
	| { kind: "tree"; rev: string }
	| (Pinned & { kind: "copy"; drop?: { lines: [number, number][]; why: string } });

/**
 * Line 1 of each doctest log (`TREE=head SET=brief|script PWD=...`) names the
 * run after the exclusion set it used, and lines 3-12 print the head's own
 * exclusion list: each says which command is the script's, which is the
 * question the case asks. The command line and cargo's output stay.
 */
const DOCTEST_DROP = "the run's name and the head's exclusion list, printed by the lane's script";

const V = `${ROOT}/verdict`;

/** Every material and working directory of `cases-verdict.json`, by path. */
export const SOURCES: Record<string, Source> = {
	[`${V}/pr17646-r3/description.md`]: {
		kind: "copy",
		from: `${BATCH}/funcnest-r2/pr-body-readback.md`,
		sha256: "134d13db6d7d9788c938889e1a2d56c537fc679997c055af83113a9b5ad6224e",
	},
	[`${V}/pr17394-r36/7efd7721937-CHANGELOG.md`]: {
		kind: "blob",
		rev: "7efd77219374ca4e8767979809835e4aa90666ba",
		file: "packages/coding-agent/CHANGELOG.md",
	},
	[`${V}/pr17394-r36/7f4fbe679f8-CHANGELOG.md`]: {
		kind: "blob",
		rev: "7f4fbe679f8ddf35d7dce7f708831424e722a1ba",
		file: "packages/coding-agent/CHANGELOG.md",
	},
	[`${V}/pr17665-r1/description.md`]: {
		kind: "copy",
		from: `${BATCH}/fix17665r2/body-before.md`,
		sha256: "9dac9ff0fe85a4a46b2411b480d2d82283d79ba7d2fe58ac667f210e2022e7cc",
	},
	// The working copy the original reviewer started in, at the revision it read.
	[`${V}/pr17665-r1/oh-my-pi`]: { kind: "tree", rev: "acf943d3c8dc1ed135b42aa33fef4d9d2ff61c9a" },
	// The fix lane's two doctest runs at the head, on the build machine.
	[`${V}/pr17665-r1/doctest/1.log`]: {
		kind: "copy",
		from: `${BATCH}/fix17665r2/evidence/b31f2fb8/doc-head-brief.log`,
		sha256: "1f093f86c6d15a7f7b5fcd6e3de3f10d2d59ab5945328a5a8716c329f258e6db",
		drop: {
			lines: [
				[1, 1],
				[3, 12],
			],
			why: DOCTEST_DROP,
		},
	},
	[`${V}/pr17665-r1/doctest/2.log`]: {
		kind: "copy",
		from: `${BATCH}/fix17665r2/evidence/b31f2fb8/doc-head-script.log`,
		sha256: "513e3c6420b6b1685bad7cffc88cf6098740ed617bf4c8f51fbb8bd61cd30d21",
		drop: {
			lines: [
				[1, 1],
				[3, 12],
			],
			why: DOCTEST_DROP,
		},
	},
};

/**
 * A head whose claim is tested by running the change needs its dependencies
 * and an addon built from that head: no tree here shares #17646's Rust, and
 * no reviewer can build Rust on this machine. The addon is the one the
 * clearing reviewer built and tested (`/data/cr17646r3/addon-new.node` on the
 * gate VM, MANIFEST "Build provenance"); `node_modules` comes from a tree
 * whose `bun.lock` is byte-identical to the head's.
 */
export const DONORS: Record<string, { dir: string; source: string; addon: Pinned }> = {
	"pr17646-r3": {
		dir: `${ROOT}/donor-6b1e9890-4ef2e3be03ab`,
		source: "/mnt/nvme/sami/omp-worktrees/17400-base",
		addon: {
			from: `${ROOT}/addons/pi_natives-4ef2e3be03ab-cr17646r3.node`,
			sha256: "3ccfefcfdb672c6fe042e8f54cfd3f309b52175c4d3c36db86dcf2673b683941",
		},
	},
};

function run(cmd: string, args: string[], stdout?: number): void {
	const r = spawnSync(cmd, args, { stdio: ["ignore", stdout ?? "inherit", "inherit"] });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

/** The pinned file's bytes; throws when they are not the pinned ones. */
function pinned(p: Pinned): Buffer {
	const bytes = fs.readFileSync(p.from);
	const got = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (got !== p.sha256) throw new Error(`${p.from}: sha256 ${got}, pinned ${p.sha256}`);
	return bytes;
}

export function makeMaterial(at: string, source: Source): void {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	if (source.kind === "blob") {
		const fd = fs.openSync(at, "w");
		try {
			run("git", ["-C", REPO, "cat-file", "blob", `${source.rev}:${source.file}`], fd);
		} finally {
			fs.closeSync(fd);
		}
	} else if (source.kind === "tree") {
		fs.mkdirSync(at);
		const archive = `${at}.tar`;
		run("git", ["-C", REPO, "archive", "--format=tar", "-o", archive, source.rev]);
		try {
			run("tar", ["-xf", archive, "-C", at]);
		} finally {
			fs.rmSync(archive, { force: true });
		}
	} else {
		const drop = source.drop?.lines ?? [];
		const lines = pinned(source)
			.toString("utf8")
			.split("\n")
			.filter((_, i) => !drop.some(([from, to]) => i + 1 >= from && i + 1 <= to));
		fs.writeFileSync(at, lines.join("\n"));
	}
	run("chmod", ["-R", "a-w", at]);
}

/**
 * The sources that make one material or working directory: its own, or, for a
 * directory, those of every file under it. Empty for a path this file does not
 * make (an addon inside the snapshot, a system binary).
 */
export function sourcesFor(at: string): [string, Source][] {
	return Object.entries(SOURCES).filter(([p]) => p === at || p.startsWith(`${at}/`));
}

function setup(cases: VerdictCaseFile): void {
	for (const head of cases.heads) {
		const donor = DONORS[head.id];
		if (donor !== undefined && !fs.existsSync(path.join(donor.dir, "node_modules"))) {
			const lock = spawnSync("git", ["-C", REPO, "show", `${head.head_sha}:bun.lock`]).stdout;
			if (!lock.equals(fs.readFileSync(path.join(donor.source, "bun.lock"))))
				throw new Error(`${head.id}: ${donor.source}/bun.lock differs from the head's`);
			pinned(donor.addon);
			fs.mkdirSync(donor.dir, { recursive: true });
			makeDonor(donor.source, donor.dir, { [ADDON]: donor.addon.from });
			pinned({ from: path.join(donor.dir, "natives", ADDON), sha256: donor.addon.sha256 });
		}
		if (!fs.existsSync(head.checkout)) build(REPO, head.head_sha, head.base_sha, ROOT, donor?.dir ?? null);
		for (const at of [...head.materials.map(m => m.path), ...(head.cwd === null ? [] : [head.cwd])]) {
			if (fs.existsSync(at)) continue;
			const sources = sourcesFor(at);
			if (sources.length === 0) throw new Error(`${head.id}: no source for ${at}`);
			for (const [p, source] of sources) makeMaterial(p, source);
			run("chmod", ["-R", "a-w", at]);
		}
		console.log(`${head.id}: ready`);
	}
}

function main(): void {
	const argv = process.argv.slice(2);
	const i = argv.indexOf("--cases");
	const casesPath = i >= 0 ? (argv[i + 1] as string) : path.join(import.meta.dir, "cases-verdict.json");
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as VerdictCaseFile;
	const mode = argv[0];
	if (mode === "setup") setup(cases);
	else if (mode !== "check") {
		console.error("usage: verdict-build.ts setup|check [--cases cases-verdict.json]");
		process.exit(2);
	}
	const problems = cases.heads.flatMap(preflight);
	for (const p of problems) console.error(`preflight: ${p}`);
	console.log(`preflight: ${problems.length} problem(s) over ${cases.heads.length} heads`);
	process.exit(problems.length === 0 ? 0 : 1);
}

if (import.meta.main) main();
