import { expect, it } from "bun:test";
import * as path from "node:path";

/**
 * A child of this process that is not dumpable, and so owns none of its `/proc` files, calls
 * `setToolOomScore`: whether its own write of its value was refused, its value before, and after.
 */
function refusedWrite(): { refused: boolean; before: string; after: string } | null {
	if (process.platform !== "linux") return null;
	const script = [
		'import { dlopen, FFIType } from "bun:ffi";',
		'import * as fs from "node:fs";',
		`import { setToolOomScore } from ${JSON.stringify(path.join(import.meta.dir, "../src/oom-score.ts"))};`,
		'const { symbols } = dlopen("libc.so.6", {',
		"\tprctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },",
		"});",
		"// PR_SET_DUMPABLE",
		"symbols.prctl(4, 0, 0, 0, 0);",
		'const score = "/proc/self/oom_score_adj";',
		'const before = fs.readFileSync(score, "utf8").trim();',
		"let refused = false;",
		"try {",
		"\tfs.writeFileSync(score, before);",
		"} catch {",
		"\trefused = true;",
		"}",
		"setToolOomScore();",
		'console.log(JSON.stringify({ refused, before, after: fs.readFileSync(score, "utf8").trim() }));',
	].join("\n");
	const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`the probe child failed: ${child.stderr.toString()}`);
	return JSON.parse(child.stdout.toString());
}

const probe = refusedWrite();

// Failure mode: a tool process whose OOM adjustment the kernel refuses to change fails to start, where it
// should run with the value it has. Skips where a process that is not dumpable still writes its own value.
it.skipIf(!probe?.refused)("leaves the value and goes on where the kernel refuses the write", () => {
	expect(probe?.after).toBe(probe?.before);
});
