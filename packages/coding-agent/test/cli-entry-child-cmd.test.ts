/**
 * The command omp uses to start the CLI as a child that gets its environment from its parent (a
 * detached `omp gc`, the bash tool's `git worktree add` helper), and the CLI entry's first import.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { resolveCliChildCmd } from "../src/subprocess/worker-client";

describe("the CLI started as a child of omp", () => {
	it("runs with Bun's own .env loading off, so it gets only the environment its parent gives it", () => {
		const command = resolveCliChildCmd();

		// Not a compiled binary here: the runtime, the flag, then the CLI's entry.
		expect(command).toHaveLength(3);
		expect(command[1]).toBe("--no-env-file");
		expect(path.isAbsolute(command[2]!)).toBe(true);
	});

	it("is what omp gc and the worktree helper start", async () => {
		// Each builds its command from this function and nothing else.
		const gc = await Bun.file(path.join(import.meta.dir, "../src/cli/gc-auto-compress.ts")).text();
		const bash = await Bun.file(path.join(import.meta.dir, "../src/tools/bash.ts")).text();

		expect(gc).toContain('[...resolveCliChildCmd(), "gc", "--compress"');
		expect(bash).toContain("rewriteGitWorktreeAdd(command, resolveCliChildCmd())");
		expect(gc + bash).not.toContain("resolveCliEntryCmd(");
	});
});

describe("the CLI entry", () => {
	it("imports the startup environment snapshot before anything else", async () => {
		// ESM evaluates a module's imports in order, so the first import is evaluated first: the
		// snapshot then sees `process.env` before any omp module changes it.
		const source = await Bun.file(path.join(import.meta.dir, "../src/cli.ts")).text();
		const firstImport = /^import\b[^;]*;/m.exec(source)?.[0];

		expect(firstImport).toBe('import "@oh-my-pi/pi-utils/startup-env";');
	});
});
