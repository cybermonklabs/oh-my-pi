#!/usr/bin/env bun
/**
 * Read-only head snapshots for the reviewer-gap eval, and the check that they
 * can still run.
 *
 * A snapshot is `git archive` of a full head sha with its dependencies linked
 * from a donor tree, so a reviewer can `bun test` inside it. Every head this
 * eval uses has the same `bun.lock`, so one donor serves them all. The first
 * two lanes linked each snapshot to a reviewer's own checkout, and two of those
 * checkouts were later deleted, which left every dependency of `pr17394-r7` and
 * `pr17394-r8` dangling. A snapshot therefore links only to a donor this eval
 * owns, and its `@oh-my-pi/*` workspace links point into the snapshot itself.
 *
 * Usage:
 *   bun scripts/reviewer-gap/snapshot.ts donor <source tree> <donor dir>
 *   bun scripts/reviewer-gap/snapshot.ts build <repo> <sha> <base> <out root> <donor dir>
 *   bun scripts/reviewer-gap/snapshot.ts relink <snapshot> <donor dir>
 *   bun scripts/reviewer-gap/snapshot.ts check <snapshot>...
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKSPACE_SCOPE = "@oh-my-pi";
const NATIVE_DIR = path.join("packages", "natives", "native");

function sh(cmd: string, args: string[], opts: { cwd?: string; stdout?: number } = {}): void {
	const r = spawnSync(cmd, args, { cwd: opts.cwd, stdio: ["ignore", opts.stdout ?? "inherit", "inherit"] });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

/**
 * Copy a donor's `node_modules` as hard links and its native addons as files,
 * so a later clean-up of the source tree cannot leave a snapshot dangling.
 * A hard link cannot cross a filesystem, so a source on another device is
 * copied in full instead.
 *
 * `natives` names the addons the donor carries instead of the source tree's,
 * as file name -> addon file: for a head whose Rust differs from every tree's
 * that has its dependencies, the addon must be one built from that head.
 */
export function makeDonor(source: string, donor: string, natives?: Record<string, string>): void {
	fs.mkdirSync(path.join(donor, "natives"), { recursive: true });
	const sameDevice = fs.statSync(source).dev === fs.statSync(donor).dev;
	if (!fs.existsSync(path.join(donor, "node_modules")))
		sh("cp", [sameDevice ? "-al" : "-a", path.join(source, "node_modules"), path.join(donor, "node_modules")]);
	const addons =
		natives ??
		Object.fromEntries(
			fs
				.readdirSync(path.join(source, NATIVE_DIR))
				.filter(name => name.endsWith(".node"))
				.map(name => [name, fs.realpathSync(path.join(source, NATIVE_DIR, name))]),
		);
	for (const [name, from] of Object.entries(addons)) {
		const to = path.join(donor, "natives", name);
		if (!fs.existsSync(to)) fs.copyFileSync(from, to);
	}
}

function replaceLink(target: string, at: string): void {
	fs.rmSync(at, { force: true, recursive: false });
	fs.symlinkSync(target, at);
}

/**
 * Point every dependency of `snapshot` at `donor`. Third-party entries link to
 * the donor's absolute paths. A donor entry that is itself a relative link is a
 * workspace package (`@oh-my-pi/*` -> `../../packages/<dir>`, `robomp-web` ->
 * `../python/robomp/web`): it is copied as the same relative link, so it
 * resolves inside the snapshot.
 */
export function linkDeps(snapshot: string, donor: string): void {
	const from = path.join(donor, "node_modules");
	const to = path.join(snapshot, "node_modules");
	fs.mkdirSync(to, { recursive: true });
	const relativeLink = (p: string): string | undefined => {
		if (!fs.lstatSync(p).isSymbolicLink()) return undefined;
		const target = fs.readlinkSync(p);
		return path.isAbsolute(target) ? undefined : target;
	};
	for (const entry of fs.readdirSync(from)) {
		const source = path.join(from, entry);
		const at = path.join(to, entry);
		const own = relativeLink(source);
		if (own !== undefined) {
			replaceLink(own, at);
			continue;
		}
		const children = entry.startsWith("@") ? fs.readdirSync(source) : [];
		if (children.some(c => relativeLink(path.join(source, c)) !== undefined)) {
			if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) fs.rmSync(at);
			fs.mkdirSync(at, { recursive: true });
			for (const c of children) {
				const rel = relativeLink(path.join(source, c));
				replaceLink(rel ?? path.join(source, c), path.join(at, c));
			}
			continue;
		}
		replaceLink(source, at);
	}
	const natives = path.join(snapshot, NATIVE_DIR);
	for (const name of fs.readdirSync(path.join(donor, "natives")))
		replaceLink(path.join(donor, "natives", name), path.join(natives, name));
}

/** Every symlink under `root` whose target does not exist. Never follows a link. */
export function danglingLinks(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isSymbolicLink()) {
				if (!fs.existsSync(full)) out.push(`${path.relative(root, full)} -> ${fs.readlinkSync(full)}`);
			} else if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
	return out.sort();
}

/** Workspace links that leave the snapshot: a test would import another tree's source. */
export function foreignWorkspaceLinks(snapshot: string): string[] {
	const scope = path.join(snapshot, "node_modules", WORKSPACE_SCOPE);
	if (!fs.existsSync(scope)) return [];
	const root = fs.realpathSync(snapshot);
	return fs
		.readdirSync(scope)
		.filter(pkg => {
			const link = path.join(scope, pkg);
			const resolved = path.resolve(scope, fs.readlinkSync(link));
			return !resolved.startsWith(`${root}${path.sep}`) && !resolved.startsWith(`${snapshot}${path.sep}`);
		})
		.sort();
}

function setWritable(dirs: string[], writable: boolean): void {
	for (const d of dirs) if (fs.existsSync(d)) fs.chmodSync(d, writable ? 0o755 : 0o555);
}

export function relink(snapshot: string, donor: string): void {
	const dirs = [
		snapshot,
		path.join(snapshot, "node_modules"),
		path.join(snapshot, "node_modules", WORKSPACE_SCOPE),
		path.join(snapshot, NATIVE_DIR),
	];
	setWritable(dirs, true);
	try {
		linkDeps(snapshot, donor);
	} finally {
		setWritable(dirs, false);
	}
}

/**
 * `donor` null builds a tree with no `node_modules`: for a case whose claim is
 * checked by reading and by tools outside the repository, where a dependency
 * tree would only be another place for a link to dangle.
 */
export function build(repo: string, sha: string, base: string, outRoot: string, donor: string | null): void {
	const snapshot = path.join(outRoot, "heads", sha);
	const diff = path.join(outRoot, "diffs", `${sha}.diff`);
	fs.mkdirSync(snapshot, { recursive: true });
	fs.mkdirSync(path.dirname(diff), { recursive: true });
	const archive = path.join(outRoot, `${sha}.tar`);
	sh("git", ["-C", repo, "archive", "--format=tar", "-o", archive, sha]);
	try {
		sh("tar", ["-xf", archive, "-C", snapshot]);
	} finally {
		fs.rmSync(archive, { force: true });
	}
	if (donor !== null) linkDeps(snapshot, donor);
	const fd = fs.openSync(diff, "w");
	try {
		sh("git", ["-C", repo, "diff", `${base}..${sha}`], { stdout: fd });
	} finally {
		fs.closeSync(fd);
	}
	sh("chmod", ["-R", "a-w", snapshot]);
}

function main(): void {
	const [mode, ...rest] = process.argv.slice(2);
	if (mode === "donor" && rest.length === 2) return makeDonor(rest[0] as string, rest[1] as string);
	if (mode === "build" && rest.length === 5) {
		const [repo, sha, base, outRoot, donor] = rest as [string, string, string, string, string];
		return build(repo, sha, base, outRoot, donor);
	}
	if (mode === "relink" && rest.length === 2) return relink(rest[0] as string, rest[1] as string);
	if (mode === "check" && rest.length > 0) {
		let bad = 0;
		for (const snapshot of rest) {
			const dangling = danglingLinks(snapshot);
			const foreign = foreignWorkspaceLinks(snapshot);
			bad += dangling.length + foreign.length;
			console.log(`${snapshot}: ${dangling.length} dangling, ${foreign.length} workspace links outside it`);
			for (const d of dangling.slice(0, 5)) console.log(`  dangling ${d}`);
			for (const f of foreign) console.log(`  foreign ${f}`);
		}
		process.exit(bad === 0 ? 0 : 1);
	}
	console.error("usage: snapshot.ts donor|build|relink|check ... (see the file header)");
	process.exit(2);
}

if (import.meta.main) main();
