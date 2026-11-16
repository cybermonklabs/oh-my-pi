import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { $ } from "bun";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

describe.skipIf(process.platform === "win32")("worktree add locks", () => {
	let root: string;
	let repo: string;
	let made = 0;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-lock-")));
		repo = path.join(root, "repo");
		await $`git init -q ${repo}`.quiet();
		await $`git -C ${repo} -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit --allow-empty -qm probe`.quiet();
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	/** The `locked` file of a linked worktree's registration, or `undefined` when it has none. */
	async function lockOf(worktree: string): Promise<Buffer | undefined> {
		const pointer = (await Bun.file(path.join(worktree, ".git")).text()).trim();
		const admin = pointer.replace(/^gitdir: /, "");
		return fs.readFile(path.join(admin, "locked")).catch(() => undefined);
	}

	/** What git itself writes for `git worktree add --detach <lockArgs> <path> HEAD`. */
	async function lockedByGit(lockArgs: readonly string[]): Promise<Buffer | undefined> {
		const worktree = path.join(root, `by-git-${made++}`);
		await $`git -C ${repo} worktree add -q --detach ${[...lockArgs]} ${worktree} HEAD`.quiet();
		return lockOf(worktree);
	}

	async function ompAdd(args: readonly string[]) {
		const worktree = path.join(root, `by-omp-${made++}`);
		const result = await $`bun ${cli} worktree add --detach ${[...args]} ${worktree} HEAD`
			.cwd(repo)
			.quiet()
			.nothrow();
		return { worktree, result };
	}

	it("the bash tool locks the worktree of a rewritten `git worktree add` as git --lock --reason does", async () => {
		// Not a reason any git wrapper on the test machine writes, so the lock
		// can only have come from the rewrite.
		const lockReason = "locked by the bash tool's worktree rewrite";
		const session: ToolSession = {
			cwd: repo,
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => "worktree-lock",
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"bash.direnv": "off",
				"worktree.clone": true,
				"worktree.lockReason": lockReason,
			}),
		};
		const worktree = path.join(root, "by-bash-tool");
		const result = await new BashTool(session).execute("worktree-lock", {
			command: `git worktree add --detach ${worktree} HEAD`,
		});

		expect(result.isError).toBeUndefined();
		const lock = await lockOf(worktree);
		expect(lock?.toString()).toBe(`${lockReason}\n`);
		expect(lock).toEqual(await lockedByGit(["--lock", "--reason", lockReason]));
	});

	it.each([
		{ name: "--lock", args: ["--lock"] },
		{ name: "--lock --reason ''", args: ["--lock", "--reason", ""] },
		{ name: "--lock --reason 'in use'", args: ["--lock", "--reason", "in use"] },
	])("`omp worktree add $name` writes the lock git writes", async ({ args }) => {
		const { worktree, result } = await ompAdd(args);

		expect(result.exitCode).toBe(0);
		const lock = await lockOf(worktree);
		expect(lock).toBeDefined();
		expect(lock).toEqual(await lockedByGit(args));
	});

	it("refuses --reason without --lock, as git does, and creates nothing", async () => {
		const { worktree, result } = await ompAdd(["--reason", "in use"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("the option '--reason' requires '--lock'");
		expect(await fs.exists(worktree)).toBe(false);
	});
});
