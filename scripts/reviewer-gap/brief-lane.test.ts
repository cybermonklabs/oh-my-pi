import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type RunScore, mainEffects } from "./brief-lane.ts";
import type { HeadCase } from "./grade.ts";
import { type Bundle, type LabelFile, checkLabels } from "./how-found.ts";
import { type Claim, representatives } from "./judge.ts";
import { type BriefFile, armBrief, pruneScratch, userPrompt } from "./run.ts";

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
