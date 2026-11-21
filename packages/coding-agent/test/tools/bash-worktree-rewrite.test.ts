import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { rewriteGitWorktreeAdd } from "@oh-my-pi/pi-coding-agent/tools/bash-worktree-rewrite";

const OMP = ["bun", "/opt/omp cli.ts"] as const;

describe("rewriteGitWorktreeAdd", () => {
	it("routes supported branch creation through omp with an option terminator", () => {
		expect(rewriteGitWorktreeAdd("git worktree add -b feat ../wt origin/main", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add -b feat -- ../wt origin/main",
		);
	});

	it("preserves surrounding shell structure while rewriting a -C segment", () => {
		expect(rewriteGitWorktreeAdd("cd x && git -C repo worktree add ../wt && ls", OMP)).toBe(
			"cd x && bun '/opt/omp cli.ts' worktree add -C repo -- ../wt && ls",
		);
	});

	it("leaves unsupported or unsafe commands unchanged", () => {
		const commands = [
			"git worktree add --orphan ../wt",
			"git worktree add --reason busy ../wt",
			'git worktree add "$HOME/wt"',
			"FOO=1 git worktree add ../wt",
			"git worktree list",
			"printf x | git worktree add ../wt",
			"git worktree add ../wt | cat",
		];
		for (const command of commands) expect(rewriteGitWorktreeAdd(command, OMP)).toBe(command);
	});

	it("carries git's --lock and --reason through", () => {
		expect(rewriteGitWorktreeAdd("git worktree add --lock ../wt", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add --lock -- ../wt",
		);
		expect(rewriteGitWorktreeAdd("git worktree add --lock --reason 'in use' -b feat ../wt", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add -b feat --lock '--reason=in use' -- ../wt",
		);
		expect(rewriteGitWorktreeAdd("git worktree add --reason= --lock ../wt", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add --lock --reason= -- ../wt",
		);
		// An empty quoted value stays the option's, not the next argument's.
		expect(rewriteGitWorktreeAdd("git worktree add --lock --reason '' ../wt HEAD", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add --lock --reason= -- ../wt HEAD",
		);
		// A reason that starts with `-` stays the option's value.
		expect(rewriteGitWorktreeAdd("git worktree add --lock --reason=-busy ../wt HEAD", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add --lock --reason=-busy -- ../wt HEAD",
		);
	});

	it("locks a rewritten add with the configured reason, as a git wrapper that locks every add would", () => {
		const lockReason = "agent session: locked on add (prune guard)";
		expect(rewriteGitWorktreeAdd("git worktree add --detach ../wt HEAD", OMP, { lockReason })).toBe(
			"bun '/opt/omp cli.ts' worktree add --detach --lock '--reason=agent session: locked on add (prune guard)' -- ../wt HEAD",
		);
		// An explicit lock is the caller's own and keeps git's default reason.
		expect(rewriteGitWorktreeAdd("git worktree add --lock ../wt", OMP, { lockReason })).toBe(
			"bun '/opt/omp cli.ts' worktree add --lock -- ../wt",
		);
	});

	it("quotes rewritten argv containing spaces", () => {
		expect(rewriteGitWorktreeAdd("git worktree add 'path with spaces'", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add -- 'path with spaces'",
		);
	});

	it("leaves -b or -B with --detach to git, which refuses the pair and creates nothing", () => {
		for (const command of [
			"git worktree add --lock -b feature --detach ../wt HEAD",
			"git worktree add -B feature --detach ../wt HEAD",
		]) {
			expect(rewriteGitWorktreeAdd(command, OMP, { lockReason: "busy" })).toBe(command);
		}
	});

	it("leaves a command holding a backslash-newline to git", () => {
		const command = 'git worktree add --detach --lock --reason "busy\\\nnow" ../wt HEAD';
		expect(rewriteGitWorktreeAdd(command, OMP)).toBe(command);
	});
});

/**
 * The rewrite against bash itself: for each command, the argv bash gives `git`
 * and the argv bash gives omp for the rewritten command must carry the same
 * reason and paths. A stub on PATH stands in for both and prints its argv.
 */
describe.skipIf(process.platform === "win32")("rewriteGitWorktreeAdd against bash", () => {
	let dir: string;
	let stub: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rewrite-bash-"));
		stub = path.join(dir, "git");
		fs.writeFileSync(stub, "#!/bin/sh\nprintf '%s\\0' \"$@\"\n", { mode: 0o755 });
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** The argv bash passes to the stub when it runs `command`. */
	function argvFromBash(command: string): string[] {
		const result = Bun.spawnSync(["bash", "-c", command], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
		});
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().split("\0").slice(0, -1);
	}

	/** The reason and the positionals an argv of `worktree add` carries. */
	function reasonAndPaths(argv: readonly string[]): { reason?: string; paths: string[] } {
		const paths: string[] = [];
		let reason: string | undefined;
		for (let i = 2; i < argv.length; i++) {
			const word = argv[i];
			if (word === "--reason") reason = argv[++i];
			else if (word.startsWith("--reason=")) reason = word.slice("--reason=".length);
			else if (word === "-b" || word === "-B" || word === "-C") i++;
			else if (!word.startsWith("-")) paths.push(word);
		}
		return { reason, paths };
	}

	const cases: { command: string; rewritten: boolean }[] = [
		{ command: 'git worktree add --lock --reason "say \\"hi\\"" ../wt HEAD', rewritten: true },
		{ command: 'git worktree add --lock --reason "back\\\\slash" ../wt HEAD', rewritten: true },
		{ command: 'git worktree add --lock --reason "kept \\t and \\n" ../wt HEAD', rewritten: true },
		{ command: "git worktree add --lock --reason 'single \\ quoted' ../wt HEAD", rewritten: true },
		{ command: "git worktree add --lock --reason two\\ words ../wt HEAD", rewritten: true },
		{ command: 'git worktree add --lock --reason "two\nlines" ../wt HEAD', rewritten: true },
		{ command: 'git worktree add --lock --reason "" "../with space" HEAD', rewritten: true },
		{ command: 'git worktree add --lock --reason "busy\\\nnow" ../wt HEAD', rewritten: false },
	];

	for (const { command, rewritten } of cases) {
		it(`gives omp what bash gives git: ${JSON.stringify(command)}`, () => {
			const result = rewriteGitWorktreeAdd(command, [stub]);
			expect(result !== command).toBe(rewritten);
			if (!rewritten) return;
			const toGit = reasonAndPaths(argvFromBash(command));
			const toOmp = reasonAndPaths(argvFromBash(result));
			expect(toGit.reason).toBeDefined();
			expect(Buffer.from(toOmp.reason ?? "")).toEqual(Buffer.from(toGit.reason ?? ""));
			expect(toOmp.paths).toEqual(toGit.paths);
		});
	}
});
