#!/usr/bin/env bun
/**
 * `bun run lint:py` and `bun run fix:py`: ruff over `python/` and `sdk/python/`
 * with the ruff that python/robomp's `dev` extra pins, run as `python3 -m ruff`.
 *
 * The pin is read from python/robomp/pyproject.toml (`"ruff==<version>"`). A
 * `python3` whose ruff is another version, or that has none, is refused before
 * ruff runs, so the lane's result does not depend on the ruff a machine has
 * installed; `bun run robomp:install` installs the pinned one.
 *
 * Usage: bun scripts/ruff.ts check|fix
 */
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const PYPROJECT = "python/robomp/pyproject.toml";
const TARGETS = ["python", "sdk/python"];

const mode = process.argv[2];
if (mode !== "check" && mode !== "fix") {
	console.error("usage: bun scripts/ruff.ts check|fix");
	process.exit(2);
}
const lane = mode === "check" ? "lint:py" : "fix:py";

const pyproject = await Bun.file(path.join(repoRoot, PYPROJECT)).text();
const pin = pyproject.match(/"ruff==([^"]+)"/)?.[1];
if (!pin) {
	console.error(`${lane}: ${PYPROJECT} pins no ruff ("ruff==<version>" in the dev extra)`);
	process.exit(1);
}

const probe = Bun.spawnSync(["python3", "-m", "ruff", "--version"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
const found = probe.exitCode === 0 ? probe.stdout.toString("utf-8").trim() : null;
if (found !== `ruff ${pin}`) {
	console.error(
		`${lane} needs ruff ${pin} (the dev extra of ${PYPROJECT}), but ${found ? `python3 -m ruff runs ${found}` : "python3 has no ruff module"}. ` +
			"Install it with `bun run robomp:install`.",
	);
	process.exit(1);
}

const steps =
	mode === "check"
		? [
				["check", ...TARGETS],
				["format", "--check", ...TARGETS],
			]
		: [
				["check", "--fix", ...TARGETS],
				["format", ...TARGETS],
			];
for (const args of steps) {
	const run = Bun.spawnSync(["python3", "-m", "ruff", ...args], {
		cwd: repoRoot,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (run.exitCode !== 0) process.exit(run.exitCode || 1);
}
