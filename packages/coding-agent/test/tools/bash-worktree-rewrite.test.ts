import { describe, expect, it } from "bun:test";
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
		const lockReason = "agent session: locked on add (AGENTC-431)";
		expect(rewriteGitWorktreeAdd("git worktree add --detach ../wt HEAD", OMP, { lockReason })).toBe(
			"bun '/opt/omp cli.ts' worktree add --detach --lock '--reason=agent session: locked on add (AGENTC-431)' -- ../wt HEAD",
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
});
