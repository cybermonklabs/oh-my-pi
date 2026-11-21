import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");
const FILES = 6000;

/** Entries below `dir`, 0 when it is missing. */
async function countEntries(dir: string): Promise<number> {
	const entries = await fs.readdir(dir, { recursive: true }).catch(() => []);
	return entries.length;
}

describe.skipIf(process.platform === "win32")("omp worktree add after an add that was killed", () => {
	let root: string;
	let repo: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-kill-")));
		repo = path.join(root, "repo");
		await $`git init -q ${repo}`.quiet();
		// Enough tracked files that the add can be stopped midway, on the clone
		// path and on the ordinary checkout alike.
		for (let dir = 0; dir < FILES / 10; dir++) {
			const dirPath = path.join(repo, "files", `d${dir}`);
			await fs.mkdir(dirPath, { recursive: true });
			await Promise.all(
				Array.from({ length: 10 }, (_, file) => Bun.write(path.join(dirPath, `f${file}`), `${dir} ${file}\n`)),
			);
		}
		// No background `git gc --auto` packs the loose objects under a running add.
		await $`git -C ${repo} config gc.auto 0`.quiet();
		await $`git -C ${repo} add .`.quiet();
		await $`git -C ${repo} -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit -qm probe`.quiet();
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("adds the same path again: the killed add's partial tree and registration are removed first", async () => {
		const worktree = path.join(root, "wt");
		const killed = Bun.spawn(["bun", cli, "worktree", "add", "--detach", worktree, "HEAD"], {
			cwd: repo,
			stdout: "ignore",
			stderr: "ignore",
		});
		// Stop it once it has written part of the tree; an add that finishes
		// first fails the test, as the fixture would then be too small.
		let exited = false;
		killed.exited.then(() => {
			exited = true;
		});
		// Each poll awaits a directory read, which yields to the event loop;
		// the verdict counts entries, not time.
		while ((await countEntries(worktree)) < 30) {
			expect(exited).toBe(false);
		}
		killed.kill("SIGKILL");
		expect(await killed.exited).not.toBe(0);
		expect(killed.signalCode).toBe("SIGKILL");
		const partial = await countEntries(worktree);
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(FILES);

		const again = await $`bun ${cli} worktree add --detach ${worktree} HEAD`.cwd(repo).quiet().nothrow();
		expect(again.stderr.toString()).not.toContain("already exists");
		expect(again.exitCode).toBe(0);
		expect(await countEntries(path.join(worktree, "files"))).toBe(FILES + FILES / 10);
		const listed = (await $`git -C ${repo} worktree list --porcelain`.quiet()).stdout.toString();
		const blocks = listed.split("\n\n").filter(block => block.startsWith(`worktree ${worktree}\n`));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).not.toContain("locked");
		const registrations = await fs.readdir(path.join(repo, ".git", "worktrees"));
		expect(registrations).toHaveLength(1);
	});
});
