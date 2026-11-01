import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RunScore, mainEffects } from "./brief-lane.ts";
import type { HeadCase, RunRecord } from "./grade.ts";
import { type Bundle, type LabelFile, checkLabels } from "./how-found.ts";
import { type Claim, childEnv, representatives } from "./judge.ts";
import { type BriefFile, armBrief, diskStop, pruneScratch, treeBytes, userPrompt } from "./run.ts";

const head: HeadCase = {
	id: "h1",
	pr: 1,
	round: 2,
	head_sha: "a".repeat(40),
	base_sha: "b".repeat(40),
	checkout: "/nonexistent/snapshot",
	diff: "/nonexistent/patch.diff",
	subject: "s",
	packages: ["packages/x"],
};

const briefs: BriefFile = {
	frozen_at: "t",
	repro: "REPRO TEXT",
	heads: { h1: { source_agent: "A", loss: "LOSS TEXT", rebreak: "", full: "FULL TEXT" } },
};

describe("armBrief", () => {
	test("an element with no text at the head is left out, and rotation changes which element comes first", () => {
		const arm = { brief: ["loss", "rebreak", "repro"] as ("loss" | "rebreak" | "repro")[] };
		expect(armBrief(arm, "h1", briefs, 0)).toEqual({ text: "LOSS TEXT\n\nREPRO TEXT", elements: ["loss", "repro"] });
		expect(armBrief(arm, "h1", briefs, 1)).toEqual({ text: "REPRO TEXT\n\nLOSS TEXT", elements: ["repro", "loss"] });
	});

	test("shipped carries no brief", () => {
		expect(armBrief({ brief: [] }, "h1", briefs, 3)).toBeNull();
	});
});

describe("userPrompt on the brief lane", () => {
	const lane = userPrompt(head, "/scratch", 20, false, "claims", "/prior", { brief: null });
	const earlier = userPrompt(head, "/scratch", 20, false, "claims", "/prior");

	test("shipped still gets the brief heading, so the heading is no treatment", () => {
		expect(lane).toContain("Brief for this round, from the coordinator who assigned it:\n\n(none for this round)");
	});

	test("the instructions the arms test are not in the shared prompt, and earlier lanes keep theirs", () => {
		expect(lane).not.toContain("say for each earlier finding whether it is closed");
		expect(lane).not.toContain("any output you measured");
		expect(earlier).toContain("say for each earlier finding whether it is closed at this head.");
		expect(earlier).toContain("and any\n  output you measured.");
	});

	test("every brief-lane arm is told its scratch directory may be written and run, against the shipped read-only rule", () => {
		expect(lane).toContain("Writing and running files in your scratch directory is allowed.");
		expect(earlier).not.toContain("Writing and running files in your scratch directory is allowed.");
	});
});

describe("pruneScratch", () => {
	test("removes caches by directory name and keeps every other file, naming the large ones", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
		try {
			fs.mkdirSync(path.join(dir, "bun-cache", "x"), { recursive: true });
			fs.writeFileSync(path.join(dir, "bun-cache", "x", "pkg"), "c".repeat(1000));
			fs.mkdirSync(path.join(dir, "probe", "node_modules"), { recursive: true });
			fs.writeFileSync(path.join(dir, "probe", "node_modules", "m.js"), "m");
			fs.writeFileSync(path.join(dir, "probe", "probe.test.ts"), "test");
			fs.writeFileSync(path.join(dir, "strace.out"), Buffer.alloc(9 * 2 ** 20));
			const r = pruneScratch(dir);
			expect(r.removed.sort()).toEqual(["bun-cache/", "probe/node_modules/"]);
			expect(fs.existsSync(path.join(dir, "strace.out"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "probe", "probe.test.ts"))).toBe(true);
			expect(r.large).toEqual(["strace.out (9.0 MiB)"]);
			expect(r.removedBytes).toBe(1001);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("treeBytes", () => {
	test("does not abort the measurement when a scratch entry disappears during disk accounting", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-bytes-"));
		const kept = path.join(dir, "kept");
		const vanished = path.join(dir, "vanished");
		fs.writeFileSync(kept, "keep");
		fs.writeFileSync(vanished, "gone");
		const originalLstat = fs.lstatSync;
		const lstat = spyOn(fs, "lstatSync").mockImplementation((entry, options) => {
			if (entry === vanished) fs.rmSync(vanished);
			return originalLstat(entry, options);
		});
		try {
			expect(treeBytes(dir)).toBe(4);
		} finally {
			lstat.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("diskStop", () => {
	test("a guard that cannot measure lets the run go on and says so in the log", () => {
		const missing = path.join(os.tmpdir(), `disk-stop-${process.pid}-${Date.now()}`, "run");
		const logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(diskStop(missing, 40, 45)).toBeNull();
			expect(logged).toHaveBeenCalledTimes(1);
			const line = String(logged.mock.calls[0]?.[0]);
			expect(line).toContain("could not measure");
			expect(line).toContain("ENOENT");
		} finally {
			logged.mockRestore();
		}
	});
});

// The rule the box's `omp` wrapper applies (dotfiles scripts/agent-session): an
// inherited AGENT_SESSION_SCRATCH that exists becomes the session's TMPDIR.
const AGENT_SESSION_TMPDIR_RULE =
	'if [ -n "${AGENT_SESSION_SCRATCH:-}" ] && [ -d "$AGENT_SESSION_SCRATCH" ]; then TMPDIR="$AGENT_SESSION_SCRATCH"; fi';

describe("run resume", () => {
	test("preserves a completed paid session and redoes an incomplete session instead of corrupting the estimate", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-resume-"));
		try {
			const out = path.join(dir, "out");
			const checkout = path.join(dir, "checkout");
			const diff = path.join(dir, "change.diff");
			const cases = path.join(dir, "cases.json");
			const bin = path.join(dir, "bin");
			const counter = path.join(dir, "omp-calls");
			fs.mkdirSync(out);
			fs.mkdirSync(checkout);
			fs.mkdirSync(bin);
			fs.writeFileSync(diff, "");
			fs.writeFileSync(
				cases,
				JSON.stringify({
					frozen_at: "test",
					heads: ["complete", "partial"].map(id => ({
						id,
						pr: 1,
						round: 1,
						head_sha: "a".repeat(40),
						base_sha: "b".repeat(40),
						checkout,
						diff,
						subject: id,
						packages: [],
					})),
					findings: [],
				}),
			);
			const complete: RunRecord = {
				runId: "shipped__complete__t1",
				arm: "shipped",
				head: "complete",
				trial: 1,
				model: "anthropic/claude-opus-5-5",
				report: "carried output",
				costUsd: 1,
				elapsedMs: 1,
				exitCode: 0,
			};
			fs.writeFileSync(path.join(out, `${complete.runId}.json`), JSON.stringify(complete));
			// What a killed runner leaves for a session it had started: a truncated
			// record, an empty claim and the session's scratch.
			fs.writeFileSync(
				path.join(out, "shipped__partial__t1.json"),
				JSON.stringify({ runId: "shipped__partial__t1" }),
			);
			fs.writeFileSync(path.join(out, "shipped__partial__t1.json.claim"), "");
			const leftover = path.join(out, "scratch", "shipped__partial__t1", "dead-session-probe.txt");
			fs.mkdirSync(path.dirname(leftover), { recursive: true });
			fs.writeFileSync(leftover, "from the dead session");
			const omp = path.join(bin, "omp");
			fs.writeFileSync(
				omp,
				`#!/bin/sh
printf x >> "$RUN_COUNTER"
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"new output"}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}'
`,
			);
			fs.chmodSync(omp, 0o755);
			const runner = Bun.spawnSync(
				[
					process.execPath,
					path.join(import.meta.dir, "run.ts"),
					"--out",
					out,
					"--cases",
					cases,
					"--arms",
					"shipped",
					"--trials",
					"1",
					"--concurrency",
					"1",
					"--no-repo-gate",
				],
				{ env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RUN_COUNTER: counter } },
			);
			expect(runner.exitCode).toBe(0);
			expect(fs.readFileSync(counter, "utf8")).toBe("x");
			expect(
				(JSON.parse(fs.readFileSync(path.join(out, `${complete.runId}.json`), "utf8")) as RunRecord).report,
			).toBe("carried output");
			expect(
				(JSON.parse(fs.readFileSync(path.join(out, "shipped__partial__t1.json"), "utf8")) as RunRecord).report,
			).toBe("new output");
			expect(fs.existsSync(leftover)).toBe(false);
			expect(fs.existsSync(path.join(out, "shipped__partial__t1.json.claim"))).toBe(false);
			expect(runner.stdout.toString()).toContain("2 of 2 sessions recorded complete");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a reviewer's TMPDIR is its own scratch even through a wrapper that takes it from AGENT_SESSION_SCRATCH", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tmpdir-"));
		try {
			const out = path.join(dir, "out");
			const checkout = path.join(dir, "checkout");
			const diff = path.join(dir, "change.diff");
			const cases = path.join(dir, "cases.json");
			const bin = path.join(dir, "bin");
			const launcherScratch = path.join(dir, "launcher-session");
			const seen = path.join(dir, "seen-tmpdir");
			for (const d of [out, checkout, bin, launcherScratch]) fs.mkdirSync(d);
			fs.writeFileSync(diff, "");
			fs.writeFileSync(
				cases,
				JSON.stringify({
					frozen_at: "test",
					heads: [
						{
							id: "h",
							pr: 1,
							round: 1,
							head_sha: "a".repeat(40),
							base_sha: "b".repeat(40),
							checkout,
							diff,
							subject: "h",
							packages: [],
						},
					],
					findings: [],
				}),
			);
			const omp = path.join(bin, "omp");
			fs.writeFileSync(
				omp,
				`#!/bin/sh
${AGENT_SESSION_TMPDIR_RULE}
printf '%s' "$TMPDIR" > "$SEEN_TMPDIR"
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"report"}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}'
`,
			);
			fs.chmodSync(omp, 0o755);
			const runner = Bun.spawnSync(
				[
					process.execPath,
					path.join(import.meta.dir, "run.ts"),
					"--out",
					out,
					"--cases",
					cases,
					"--arms",
					"shipped",
					"--trials",
					"1",
					"--concurrency",
					"1",
					"--no-repo-gate",
				],
				{
					env: {
						...process.env,
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						AGENT_SESSION_SCRATCH: launcherScratch,
						TMPDIR: launcherScratch,
						SEEN_TMPDIR: seen,
					},
				},
			);
			expect(runner.exitCode).toBe(0);
			expect(fs.readFileSync(seen, "utf8")).toBe(path.join(out, "scratch", "shipped__h__t1"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("redoes a session that failed before its first model call, but keeps an errored review that made calls", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-never-started-"));
		try {
			const out = path.join(dir, "out");
			const checkout = path.join(dir, "checkout");
			const diff = path.join(dir, "change.diff");
			const cases = path.join(dir, "cases.json");
			const bin = path.join(dir, "bin");
			const counter = path.join(dir, "omp-calls");
			for (const d of [out, checkout, bin]) fs.mkdirSync(d);
			fs.writeFileSync(diff, "");
			fs.writeFileSync(
				cases,
				JSON.stringify({
					frozen_at: "test",
					heads: ["nocall", "errored"].map(id => ({
						id,
						pr: 1,
						round: 1,
						head_sha: "a".repeat(40),
						base_sha: "b".repeat(40),
						checkout,
						diff,
						subject: id,
						packages: [],
					})),
					findings: [],
				}),
			);
			const failed = (head: string, calls: number): RunRecord => ({
				runId: `shipped__${head}__t1`,
				arm: "shipped",
				head,
				trial: 1,
				model: "anthropic/claude-opus-5-5",
				report: "",
				costUsd: 0,
				elapsedMs: 3000,
				exitCode: 1,
				error: "empty report; exit 1",
				usage: { calls, toolCalls: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			// What a missing credential leaves: exit 1 before any model call.
			fs.writeFileSync(path.join(out, "shipped__nocall__t1.json"), JSON.stringify(failed("nocall", 0)));
			// An errored review that did work, such as one cut at --max-time: a result, excluded from n, never redone.
			fs.writeFileSync(path.join(out, "shipped__errored__t1.json"), JSON.stringify(failed("errored", 12)));
			const omp = path.join(bin, "omp");
			fs.writeFileSync(
				omp,
				`#!/bin/sh
printf x >> "$RUN_COUNTER"
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"new output"}],"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0}}}}'
`,
			);
			fs.chmodSync(omp, 0o755);
			const runner = Bun.spawnSync(
				[
					process.execPath,
					path.join(import.meta.dir, "run.ts"),
					"--out",
					out,
					"--cases",
					cases,
					"--arms",
					"shipped",
					"--trials",
					"1",
					"--concurrency",
					"1",
					"--no-repo-gate",
				],
				{ env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RUN_COUNTER: counter } },
			);
			expect(runner.exitCode).toBe(0);
			expect(fs.readFileSync(counter, "utf8")).toBe("x");
			const read = (head: string) =>
				JSON.parse(fs.readFileSync(path.join(out, `shipped__${head}__t1.json`), "utf8")) as RunRecord;
			expect(read("nocall").report).toBe("new output");
			expect(read("errored").usage?.calls).toBe(12);
			expect(runner.stdout.toString()).toContain("2 of 2 sessions recorded complete");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("childEnv", () => {
	test("a judge's or verifier's TMPDIR is its own scratch even through a wrapper that takes it from AGENT_SESSION_SCRATCH", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-tmpdir-"));
		try {
			const launcherScratch = path.join(dir, "launcher-session");
			const scratch = path.join(dir, "verify-scratch");
			fs.mkdirSync(launcherScratch);
			fs.mkdirSync(scratch);
			const env = childEnv(scratch, {
				PATH: process.env.PATH,
				AGENT_SESSION_SCRATCH: launcherScratch,
				TMPDIR: launcherScratch,
			});
			const seen = Bun.spawnSync(["sh", "-c", `${AGENT_SESSION_TMPDIR_RULE}; printf '%s' "$TMPDIR"`], { env });
			expect(seen.stdout.toString()).toBe(scratch);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("checkLabels", () => {
	const bundle: Bundle = {
		head: "h1",
		pr: 1,
		round: 2,
		head_sha: "a",
		subject_hint: "",
		briefs: [
			{
				agent: "A",
				arm: "astra",
				model: "m",
				started_at: "t",
				sha256: "s",
				text: "Re-run your five reproductions unchanged. Attack the hold.",
			},
		],
		defects: [{ id: "D1", title: "t", found_by: { astra: "found" }, finder_sections: [] }],
		decoys: [],
	};
	const good: LabelFile = {
		head: "h1",
		labeler: "x",
		briefs: [
			{
				agent: "A",
				sha256: "s",
				spans: [
					{
						id: "s1",
						element: "rebreak",
						text: "Re-run your five reproductions unchanged.",
						adapted: "Re-run the earlier round's five reproductions unchanged.",
					},
					{ id: "s2", element: "attack", text: "Attack the hold.", adapted: "Attack the hold." },
				],
			},
		],
		defects: [{ id: "D1", by_brief: { A: { pointer: ["area"], spans: ["s2"], why: "w" } } }],
		decoys: [],
	};

	test("a complete, verbatim, deletion-only labelling passes", () => {
		expect(checkLabels(bundle, good)).toEqual([]);
	});

	test("an adaptation that adds words, and a brief left uncovered, are both refused", () => {
		const bad: LabelFile = {
			...good,
			briefs: [
				{
					agent: "A",
					sha256: "s",
					spans: [
						{
							id: "s1",
							element: "rebreak",
							text: "Re-run your five reproductions unchanged.",
							adapted: "Re-run all five probes exactly as written.",
						},
					],
				},
			],
			defects: [{ id: "D1", by_brief: { A: { pointer: [], spans: [], why: "w" } } }],
		};
		const problems = checkLabels(bundle, bad);
		expect(problems.some(p => p.includes("adapted adds"))).toBe(true);
		expect(problems.some(p => p.includes("uncovered"))).toBe(true);
	});
});

describe("representatives", () => {
	test("each arm of a group is verified on its own longest claim, never another arm's", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reps-"));
		try {
			fs.writeFileSync(
				path.join(dir, "cluster.jsonl"),
				`${JSON.stringify({ key: "k", head: "h1", claims: ["s1", "s2", "s3"], groups: [[1, 2, 3]] })}\n`,
			);
			const claim = (runId: string, arm: string, sha: string, text: string): Claim => ({
				runId,
				arm,
				head: "h1",
				index: 0,
				text,
				sha,
			});
			const reps = representatives(
				[
					claim("r1", "shipped", "s1", "short"),
					claim("r2", "repro", "s2", "a much longer claim with a probe"),
					claim("r3", "shipped", "s3", "a longer shipped claim"),
				],
				dir,
			);
			expect(reps.map(r => [r.arm, r.rep.runId])).toEqual([
				["repro", "r2"],
				["shipped", "r3"],
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("mainEffects", () => {
	test("a factor that alone raises recall gets the whole effect, the others none", () => {
		const cells = [
			"shipped",
			"loss",
			"rebreak",
			"repro",
			"loss-rebreak",
			"loss-repro",
			"rebreak-repro",
			"loss-rebreak-repro",
		];
		const scores: RunScore[] = [];
		for (const h of ["pr1-r1", "pr2-r1"])
			for (const arm of cells) {
				const found = arm.includes("loss") ? ["D1", "D2"] : [];
				scores.push({
					runId: `${arm}__${h}`,
					arm,
					head: h,
					trial: 1,
					nFindings: 4,
					nNew: 4,
					nReopen: 0,
					found: { panel: found, patterns: [], either: found },
					foundNew: found,
					foundReopen: [],
					decoys: [],
					claims: { real: found.length, false: 0, unknown: 0 },
					elapsedMs: 1,
					calls: 1,
					outputTokens: 1,
					load1: null,
					running: null,
				});
			}
		const e = mainEffects(scores);
		expect(e.map(c => [c.name, c.recall])).toEqual([
			["loss (main effect)", 0.5],
			["rebreak (main effect)", 0],
			["repro (main effect)", 0],
		]);
	});
});
