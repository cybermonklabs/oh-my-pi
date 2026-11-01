#!/usr/bin/env bun
/**
 * Scoring for the verdict lane (`cases-verdict.json`).
 *
 * Every earlier lane scores defects: a finding is found when its patterns fire
 * in a report, and the claims lane adds decoys, false defects a report asserts.
 * Neither scores a verdict. A reviewer that tests a claim, gets a real result
 * and then answers a question its result did not ask scores, on the claims
 * lane, the same as one that never looked: a missed finding. Its clearance is
 * not recorded, and a clearance is what a merge is taken on.
 *
 * Here a case is one claim about a pinned change, with the verdict it
 * deserves and the observation that decides it. The run is asked to verify the
 * claim and to end its report with `VERDICT: HOLDS` or `VERDICT: DOES NOT
 * HOLD`. Each run gets one of four outcomes:
 *
 *   wrong-clear  the claim does not hold and the run says it does;
 *   wrong-fail   the claim holds and the run says it does not;
 *   supported    the verdict is right and the deciding observation is in the
 *                report (`detects` from grade.ts, unchanged);
 *   unsupported  the verdict is right and the deciding observation is not:
 *                right for a reason the case cannot see, or by a guess.
 *
 * A run with no verdict line is excluded from n and counted, as an errored run
 * is: a zero would charge the arm for a format slip.
 *
 * Each case also names the coordinate its original reviewer got wrong: the
 * object (a file read from a revision other than the one under review), the
 * quantity (an output that answers a nearby question), or the domain (the
 * inputs tried cover less than the claim does).
 *
 * Usage:
 *   bun scripts/reviewer-gap/verdict.ts --runs <dir>[,<dir>...] [--cases cases-verdict.json] [--json <out.json>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { markdownLines } from "./claims.ts";
import { type HeadCase, type Interval, type RunRecord, clusterBootstrap, detects, loadRuns, wilson } from "./grade.ts";

export const VERDICTS = ["holds", "does-not-hold"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const COORDINATES = ["object", "quantity", "domain"] as const;
export type Coordinate = (typeof COORDINATES)[number];

export const OUTCOMES = ["supported", "unsupported", "wrong-clear", "wrong-fail"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** A file or directory the run is given besides the snapshot and the patch. */
export interface Material {
	path: string;
	/** What it is, as the prompt states it. */
	note: string;
}

/** A head of the verdict lane: the change, the claim about it, and what the session starts in. */
export interface VerdictHead extends HeadCase {
	/** The claim, verbatim from where it was stated. */
	claim: string;
	/** Where the claim was stated. Recorded, never shown to the run. */
	claim_source: string;
	materials: Material[];
	/**
	 * The session's working directory when it is not the run's scratch: the
	 * other tree the original reviewer started in. Null for the scratch.
	 */
	cwd: string | null;
}

/** The verdict a head's claim deserves and the observation that decides it. */
export interface VerdictCase {
	id: string;
	head: string;
	title: string;
	expected: Verdict;
	coordinate: Coordinate;
	/** AND of OR-groups, as a finding's: the deciding observation. */
	mechanism: string[][];
	trigger: string[][];
}

export interface VerdictCaseFile {
	frozen_at: string;
	window_chars: number;
	report_format: "verdict";
	heads: VerdictHead[];
	verdicts: VerdictCase[];
}

/** `VERDICT: HOLDS`, `**VERDICT: DOES NOT HOLD**`, `## VERDICT: HOLDS.` on a line of its own. */
const VERDICT_LINE =
	/^ {0,3}(?:#{1,6}[ \t]+)?[*_`]*[ \t]*verdict[ \t]*[*_`]*[ \t]*:[ \t]*[*_`]*[ \t]*(holds|does not hold)[ \t]*[*_`.!]*[ \t]*$/i;

/**
 * The run's verdict: the last verdict line outside fenced output and block
 * quotes, so a report that revises its verdict is read by its final one and a
 * quoted line is never the reviewer's. Null when there is none.
 */
export function parseVerdict(report: string): Verdict | null {
	let last: Verdict | null = null;
	for (const line of markdownLines(report)) {
		if (line.fenced || /^ {0,3}>/.test(line.text)) continue;
		const m = VERDICT_LINE.exec(line.text);
		if (m !== null) last = (m[1] as string).toLowerCase() === "holds" ? "holds" : "does-not-hold";
	}
	return last;
}

export function outcomeOf(expected: Verdict, verdict: Verdict, evidence: boolean): Outcome {
	if (verdict !== expected) return expected === "holds" ? "wrong-fail" : "wrong-clear";
	return evidence ? "supported" : "unsupported";
}

export interface VerdictScore {
	runId: string;
	arm: string;
	head: string;
	trial: number;
	case: string;
	coordinate: Coordinate;
	expected: Verdict;
	verdict: Verdict;
	evidence: boolean;
	outcome: Outcome;
}

/** Null when the run gives no verdict, or sits on a head with no case. */
export function scoreVerdictRun(cases: VerdictCaseFile, run: RunRecord): VerdictScore | null {
	const c = cases.verdicts.find(v => v.head === run.head);
	const verdict = parseVerdict(run.report);
	if (c === undefined || verdict === null) return null;
	const evidence = detects(run.report, { ...c, severity: "", how_found_primary: "" }, cases.window_chars);
	return {
		runId: run.runId,
		arm: run.arm,
		head: run.head,
		trial: run.trial,
		case: c.id,
		coordinate: c.coordinate,
		expected: c.expected,
		verdict,
		evidence,
		outcome: outcomeOf(c.expected, verdict, evidence),
	};
}

export interface Rate {
	n: number;
	hits: number;
	rate: number;
	/** Over runs. */
	wilson: Interval;
	/** Resampling cases, each with all its runs: what changes when the cases change. */
	bootstrap: Interval;
}

function rate(scores: VerdictScore[], hit: (s: VerdictScore) => boolean): Rate {
	const byCase = new Map<string, { successes: number; n: number }>();
	for (const s of scores) {
		const c = byCase.get(s.case) ?? { successes: 0, n: 0 };
		c.n++;
		if (hit(s)) c.successes++;
		byCase.set(s.case, c);
	}
	const n = scores.length;
	const hits = scores.filter(hit).length;
	return {
		n,
		hits,
		rate: n === 0 ? 0 : hits / n,
		wilson: wilson(hits, n),
		bootstrap: clusterBootstrap([...byCase.values()]),
	};
}

export interface VerdictArmResult {
	arm: string;
	model: string;
	runs: number;
	erroredRuns: number;
	/** Runs with a report and no verdict line. Excluded from n. */
	noVerdictRuns: number;
	/** wrong-clear or wrong-fail, over every scored run. */
	wrong: Rate;
	/** Over runs on a claim that does not hold. */
	wrongClear: Rate;
	/** Over runs on a claim that holds. */
	wrongFail: Rate;
	supported: Rate;
	byCoordinate: Record<string, { n: number; wrong: number; supported: number }>;
	perCase: Record<string, Record<Outcome, number>>;
	costUsd: number;
	scores: VerdictScore[];
}

export function gradeVerdicts(cases: VerdictCaseFile, runs: RunRecord[]): VerdictArmResult[] {
	const heads = new Set(cases.verdicts.map(v => v.head));
	const arms = new Map<string, RunRecord[]>();
	for (const r of runs) if (heads.has(r.head)) arms.set(r.arm, [...(arms.get(r.arm) ?? []), r]);
	const out: VerdictArmResult[] = [];
	for (const [arm, armRuns] of arms) {
		// A run that errored is not a score, as in grade.ts: excluded and counted.
		const ok = armRuns.filter(r => r.error === undefined && r.report.trim().length > 0);
		const scores = ok.map(r => scoreVerdictRun(cases, r)).filter((s): s is VerdictScore => s !== null);
		const isWrong = (s: VerdictScore): boolean => s.outcome === "wrong-clear" || s.outcome === "wrong-fail";
		const byCoordinate: VerdictArmResult["byCoordinate"] = {};
		const perCase: VerdictArmResult["perCase"] = {};
		for (const s of scores) {
			const bc = (byCoordinate[s.coordinate] ??= { n: 0, wrong: 0, supported: 0 });
			bc.n++;
			if (isWrong(s)) bc.wrong++;
			if (s.outcome === "supported") bc.supported++;
			const pc = (perCase[s.case] ??= { supported: 0, unsupported: 0, "wrong-clear": 0, "wrong-fail": 0 });
			pc[s.outcome]++;
		}
		out.push({
			arm,
			model: ok[0]?.model ?? armRuns[0]?.model ?? "",
			runs: scores.length,
			erroredRuns: armRuns.length - ok.length,
			noVerdictRuns: ok.length - scores.length,
			wrong: rate(scores, isWrong),
			wrongClear: rate(
				scores.filter(s => s.expected === "does-not-hold"),
				s => s.outcome === "wrong-clear",
			),
			wrongFail: rate(
				scores.filter(s => s.expected === "holds"),
				s => s.outcome === "wrong-fail",
			),
			supported: rate(scores, s => s.outcome === "supported"),
			byCoordinate,
			perCase,
			costUsd: armRuns.reduce((a, r) => a + r.costUsd, 0),
			scores,
		});
	}
	out.sort((a, b) => a.arm.localeCompare(b.arm));
	return out;
}

function pct(x: number): string {
	return `${(100 * x).toFixed(1)}%`;
}

function cell(r: Rate): string {
	return `${r.hits} / ${r.n} = ${pct(r.rate)} (Wilson over runs ${pct(r.wilson.lo)}–${pct(r.wilson.hi)}; resampling cases ${pct(r.bootstrap.lo)}–${pct(r.bootstrap.hi)})`;
}

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runsArg = get("--runs");
	if (runsArg === undefined) {
		console.error("usage: verdict.ts --runs <dir>[,<dir>...] [--cases cases-verdict.json] [--json out.json]");
		process.exit(2);
	}
	const casesPath = get("--cases") ?? path.join(import.meta.dir, "cases-verdict.json");
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as VerdictCaseFile;
	const runs = runsArg
		.split(",")
		.filter(s => s.length > 0)
		.flatMap(d => loadRuns(d))
		.sort((x, y) => x.runId.localeCompare(y.runId));
	const results = gradeVerdicts(cases, runs);
	const jsonOut = get("--json");
	if (jsonOut !== undefined)
		fs.writeFileSync(
			jsonOut,
			`${JSON.stringify({ cases: casesPath, frozen_at: cases.frozen_at, results }, null, 2)}\n`,
		);

	console.log(
		`cases frozen at ${cases.frozen_at}; ${cases.verdicts.length} claims; ${runs.filter(r => !cases.verdicts.some(v => v.head === r.head)).length} of ${runs.length} runs are on heads outside the case file and are not scored\n`,
	);
	for (const r of results) {
		console.log(`## ${r.arm} (${r.model})`);
		console.log(`- runs scored ${r.runs}; errored ${r.erroredRuns}; no verdict line ${r.noVerdictRuns}`);
		console.log(`- wrong verdicts: ${cell(r.wrong)}`);
		console.log(`  - cleared a claim that does not hold: ${cell(r.wrongClear)}`);
		console.log(`  - failed a claim that holds: ${cell(r.wrongFail)}`);
		console.log(`- right verdict with its deciding observation: ${cell(r.supported)}`);
		for (const [k, v] of Object.entries(r.byCoordinate).sort())
			console.log(`  - ${k}: wrong ${v.wrong} / ${v.n}, supported ${v.supported} / ${v.n}`);
		console.log("\n| case | supported | unsupported | wrong-clear | wrong-fail |\n|---|---|---|---|---|");
		for (const [id, v] of Object.entries(r.perCase).sort())
			console.log(`| ${id} | ${v.supported} | ${v.unsupported} | ${v["wrong-clear"]} | ${v["wrong-fail"]} |`);
		console.log("");
	}
}

if (import.meta.main) main();
