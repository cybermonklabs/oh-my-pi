#!/usr/bin/env bun
/**
 * Scoring for the brief lane (`brief-arms-freeze.json`). Reads the run
 * records and the judgements `judge.ts` recorded; calls no model.
 *
 * Per run:
 *   found     - recorded defects at the head that some claimed section is, by
 *               the judge panel's agreement (primary), by the frozen patterns
 *               (the earlier lanes' grader), or by either judge or pattern
 *               (an upper bound).
 *   claims    - every claimed section gets one truth value: real when the
 *               panel or a pattern ties it to a recorded defect, or the
 *               verifier found its group REAL; false when tied to a recorded
 *               decoy, or its group was found NOT-REAL; unknown otherwise
 *               (a disputed match, UNDETERMINED, or not verified).
 *
 * Per arm: recorded defects found per diff and as a pooled rate; real and
 * false claims per diff and precision (real / (real + false)), with the
 * unknown count beside it; model requests, output tokens and wall time per
 * diff; the box's load across the arm's runs. Intervals resample heads.
 *
 * Comparisons: each arm against `shipped`, paired over heads. The three brief
 * elements are a 2x2x2 factorial; each element's main effect is the mean,
 * over heads, of the four contrasts that differ only in that element.
 *
 * Usage:
 *   bun scripts/reviewer-gap/brief-lane.ts --runs <dir>[,<dir>...] --judgements <dir>
 *        [--cases cases-c.json] [--json <out.json>] [--md <out.md>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaimsCaseFile, mulberry32 } from "./claims.ts";
import { type HeadCase, type RunRecord, loadRuns, wilson } from "./grade.ts";
import {
	type Claim,
	type ClaimOutcome,
	claimsOf,
	latestClusters,
	outcomes,
	readJudgements,
	representatives,
	untied,
	verifyKey,
} from "./judge.ts";

export const FACTORS = ["loss", "rebreak", "repro"] as const;
/** Factorial cell name by which factors are on, in `FACTORS` order. */
export const CELLS: Record<string, string> = {
	"000": "shipped",
	"100": "loss",
	"010": "rebreak",
	"001": "repro",
	"110": "loss-rebreak",
	"101": "loss-repro",
	"011": "rebreak-repro",
	"111": "loss-rebreak-repro",
};

type Truth = "real" | "false" | "unknown";

export interface RunScore {
	runId: string;
	arm: string;
	head: string;
	trial: number;
	nFindings: number;
	nNew: number;
	/** Findings at the head that re-open a finding its kept re-break text names (`cases-brief.json` `reopens`). */
	nReopen: number;
	found: { panel: string[]; patterns: string[]; either: string[] };
	foundNew: string[];
	foundReopen: string[];
	decoys: string[];
	claims: { real: number; false: number; unknown: number };
	elapsedMs: number;
	calls: number | null;
	outputTokens: number | null;
	load1: number | null;
	running: number | null;
}

/** Truth of each claimed section, and which recorded cases it is. */
export function claimTruths(
	cases: ClaimsCaseFile,
	claims: Claim[],
	judgements: string,
	minutes: number,
): Map<Claim, { truth: Truth; outcome: ClaimOutcome }> {
	const o = outcomes(cases, claims, judgements);
	const findingIds = new Set(cases.findings.map(f => f.id));
	const verdicts = new Map(readJudgements(judgements).verify.map(v => [v.key, v]));
	// A verdict belongs to its own arm's claims in the group, never to another arm's.
	const groupVerdict = new Map<string, Truth>();
	for (const r of representatives(claims, judgements)) {
		const v = verdicts.get(verifyKey(r.head, r.rep.sha, r.rep.runId, minutes));
		const t: Truth = v?.verdict === "REAL" ? "real" : v?.verdict === "NOT-REAL" ? "false" : "unknown";
		for (const s of r.group) groupVerdict.set(`${r.head}:${r.arm}:${s}`, t);
	}
	const clusters = latestClusters(judgements);
	const out = new Map<Claim, { truth: Truth; outcome: ClaimOutcome }>();
	for (const c of claims) {
		const oc = o.get(c);
		if (oc === undefined) continue;
		const tied = [...oc.agreed, ...oc.patterns];
		let truth: Truth;
		if (tied.some(id => findingIds.has(id))) truth = "real";
		else if (tied.length > 0) truth = "false";
		else if (untied(oc) && clusters.get(c.head)?.claims.includes(c.sha))
			truth = groupVerdict.get(`${c.head}:${c.arm}:${c.sha}`) ?? "unknown";
		else truth = "unknown";
		out.set(c, { truth, outcome: oc });
	}
	return out;
}

export function scoreRuns(
	cases: ClaimsCaseFile & { prior_overlap?: string[] },
	runs: RunRecord[],
	judgements: string,
	minutes: number,
	reopens: Set<string> = new Set(),
): RunScore[] {
	const heads = new Set(cases.heads.map(h => h.id));
	const ok = runs.filter(r => r.error === undefined && heads.has(r.head));
	const claims = claimsOf(ok, heads);
	const truths = claimTruths(cases, claims, judgements, minutes);
	const prior = new Set(cases.prior_overlap ?? []);
	return ok.map(r => {
		const mine = claims.filter(c => c.runId === r.runId);
		const fids = new Set(cases.findings.filter(f => f.head === r.head).map(f => f.id));
		const dids = new Set(cases.decoys.filter(d => d.head === r.head).map(d => d.id));
		const judged = mine.flatMap(c => {
			const t = truths.get(c);
			return t === undefined ? [] : [t];
		});
		const collect = (pick: (o: ClaimOutcome) => string[]): string[] =>
			[...new Set(judged.flatMap(t => pick(t.outcome)))].sort();
		const panel = collect(o => o.agreed).filter(id => fids.has(id));
		const counts = { real: 0, false: 0, unknown: 0 };
		for (const t of judged) counts[t.truth]++;
		return {
			runId: r.runId,
			arm: r.arm,
			head: r.head,
			trial: r.trial,
			nFindings: fids.size,
			nNew: [...fids].filter(id => !prior.has(id)).length,
			nReopen: [...fids].filter(id => reopens.has(id)).length,
			found: {
				panel,
				patterns: collect(o => o.patterns).filter(id => fids.has(id)),
				either: collect(o => [...o.agreed, ...o.disputed, ...o.patterns]).filter(id => fids.has(id)),
			},
			foundNew: panel.filter(id => !prior.has(id)),
			foundReopen: panel.filter(id => reopens.has(id)),
			decoys: collect(o => o.agreed).filter(id => dids.has(id)),
			claims: counts,
			elapsedMs: r.elapsedMs,
			calls: r.usage?.calls ?? null,
			outputTokens: r.usage?.output ?? null,
			load1: r.box === undefined ? null : (r.box.start.load1 + r.box.end.load1) / 2,
			running: r.box === undefined ? null : (r.box.start.procsRunning + r.box.end.procsRunning) / 2,
		};
	});
}

interface Totals {
	runs: number;
	hits: number;
	opps: number;
	hitsNew: number;
	oppsNew: number;
	hitsPatterns: number;
	hitsEither: number;
	real: number;
	false: number;
	unknown: number;
	decoys: number;
}

function totals(scores: RunScore[], decoysAt: Map<string, number>): Totals & { decoyOpps: number } {
	const t = {
		runs: scores.length,
		hits: 0,
		opps: 0,
		hitsNew: 0,
		oppsNew: 0,
		hitsPatterns: 0,
		hitsEither: 0,
		real: 0,
		false: 0,
		unknown: 0,
		decoys: 0,
		decoyOpps: 0,
	};
	for (const s of scores) {
		t.hits += s.found.panel.length;
		t.opps += s.nFindings;
		t.hitsNew += s.foundNew.length;
		t.oppsNew += s.nNew;
		t.hitsPatterns += s.found.patterns.length;
		t.hitsEither += s.found.either.length;
		t.real += s.claims.real;
		t.false += s.claims.false;
		t.unknown += s.claims.unknown;
		t.decoys += s.decoys.length;
		t.decoyOpps += decoysAt.get(s.head) ?? 0;
	}
	return t;
}

const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	if (s.length === 0) return Number.NaN;
	const m = s.length >> 1;
	return s.length % 2 === 1 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** The pull request or lane a head belongs to: its rounds share code, briefs and loss sentences, so they are one sampling unit. */
export const laneOf = (head: string): string => head.replace(/-r\d+$/, "");

/**
 * Percentile interval of a statistic over heads, resampling whole clusters
 * of heads with replacement (`cluster` maps a head to its unit; the identity
 * resamples heads).
 */
function bootHeads(
	heads: string[],
	stat: (sample: string[]) => number,
	cluster: (head: string) => string = h => h,
	iterations = 10000,
	seed = 20261101,
): [number, number] {
	const units = [...new Set(heads.map(cluster))].sort();
	const members = new Map(units.map(u => [u, heads.filter(h => cluster(h) === u)]));
	const rand = mulberry32(seed);
	const vals: number[] = [];
	for (let i = 0; i < iterations; i++) {
		const sample = units.flatMap(() => members.get(units[Math.floor(rand() * units.length)] as string) ?? []);
		const v = stat(sample);
		if (Number.isFinite(v)) vals.push(v);
	}
	vals.sort((a, b) => a - b);
	return [vals[Math.floor(0.025 * vals.length)] ?? Number.NaN, vals[Math.floor(0.975 * vals.length)] ?? Number.NaN];
}

export interface ArmSummary {
	arm: string;
	runs: number;
	heads: number;
	/** Recorded defects found per run, and the pooled rate with intervals. */
	foundPerDiff: number;
	recall: { hits: number; opps: number; rate: number; wilson: [number, number]; boot: [number, number] };
	recallNew: { hits: number; opps: number; rate: number };
	recallPatterns: { hits: number; rate: number };
	recallEither: { hits: number; rate: number };
	claimsPerDiff: number;
	realPerDiff: number;
	falsePerDiff: number;
	unknownPerDiff: number;
	precision: { real: number; false: number; unknown: number; rate: number; boot: [number, number] };
	decoys: { asserted: number; opps: number };
	callsPerDiff: number | null;
	outputTokensPerDiff: number | null;
	wallMinutes: { median: number; mean: number };
	load1: { median: number; max: number } | null;
	running: { median: number; max: number } | null;
}

export function summarise(scores: RunScore[], decoysAt: Map<string, number>): ArmSummary[] {
	const arms = [...new Set(scores.map(s => s.arm))].sort();
	return arms.map(arm => {
		const mine = scores.filter(s => s.arm === arm);
		const heads = [...new Set(mine.map(s => s.head))].sort();
		const t = totals(mine, decoysAt);
		const byHead = (sample: string[], f: (t: Totals) => number): number =>
			f(
				totals(
					sample.flatMap(h => mine.filter(s => s.head === h)),
					decoysAt,
				),
			);
		const per = (n: number): number => n / Math.max(1, mine.length);
		const calls = mine.map(s => s.calls).filter((x): x is number => x !== null);
		const out = mine.map(s => s.outputTokens).filter((x): x is number => x !== null);
		const loads = mine.map(s => s.load1).filter((x): x is number => x !== null);
		const running = mine.map(s => s.running).filter((x): x is number => x !== null);
		const w = wilson(t.hits, t.opps);
		return {
			arm,
			runs: mine.length,
			heads: heads.length,
			foundPerDiff: per(t.hits),
			recall: {
				hits: t.hits,
				opps: t.opps,
				rate: t.hits / Math.max(1, t.opps),
				wilson: [w.lo, w.hi],
				boot: bootHeads(heads, s => byHead(s, x => x.hits / Math.max(1, x.opps)), laneOf),
			},
			recallNew: { hits: t.hitsNew, opps: t.oppsNew, rate: t.hitsNew / Math.max(1, t.oppsNew) },
			recallPatterns: { hits: t.hitsPatterns, rate: t.hitsPatterns / Math.max(1, t.opps) },
			recallEither: { hits: t.hitsEither, rate: t.hitsEither / Math.max(1, t.opps) },
			claimsPerDiff: per(t.real + t.false + t.unknown),
			realPerDiff: per(t.real),
			falsePerDiff: per(t.false),
			unknownPerDiff: per(t.unknown),
			precision: {
				real: t.real,
				false: t.false,
				unknown: t.unknown,
				rate: t.real / Math.max(1, t.real + t.false),
				boot: bootHeads(heads, s => byHead(s, x => x.real / Math.max(1, x.real + x.false)), laneOf),
			},
			decoys: { asserted: t.decoys, opps: t.decoyOpps },
			callsPerDiff:
				calls.length === mine.length && calls.length > 0 ? calls.reduce((a, b) => a + b, 0) / calls.length : null,
			outputTokensPerDiff:
				out.length === mine.length && out.length > 0 ? out.reduce((a, b) => a + b, 0) / out.length : null,
			wallMinutes: {
				median: median(mine.map(s => s.elapsedMs / 60000)),
				mean: mine.reduce((a, s) => a + s.elapsedMs, 0) / Math.max(1, mine.length) / 60000,
			},
			load1: loads.length === 0 ? null : { median: median(loads), max: Math.max(...loads) },
			running: running.length === 0 ? null : { median: median(running), max: Math.max(...running) },
		};
	});
}

/**
 * One arm at one head, or the difference of two: recall over trials (all
 * findings, findings not in the earlier round, findings that re-open a named
 * earlier finding, and the rest), real and false claims per run.
 */
interface Rates {
	recall: number;
	recallNew: number;
	recallReopen: number;
	recallOther: number;
	real: number;
	falses: number;
}

const RATE_KEYS = ["recall", "recallNew", "recallReopen", "recallOther", "real", "falses"] as const;

const minus = (x: Rates, y: Rates): Rates => ({
	recall: x.recall - y.recall,
	recallNew: x.recallNew - y.recallNew,
	recallReopen: x.recallReopen - y.recallReopen,
	recallOther: x.recallOther - y.recallOther,
	real: x.real - y.real,
	falses: x.falses - y.falses,
});

/** Per head, an arm's recall over its trials, and its real and false claims per run. */
function headRates(scores: RunScore[], arm: string, head: string): Rates | null {
	const s = scores.filter(x => x.arm === arm && x.head === head);
	if (s.length === 0) return null;
	const sum = (f: (x: RunScore) => number): number => s.reduce((a, x) => a + f(x), 0);
	const ratio = (hits: number, n: number): number => (n === 0 ? Number.NaN : hits / n);
	return {
		recall: ratio(
			sum(x => x.found.panel.length),
			sum(x => x.nFindings),
		),
		recallNew: ratio(
			sum(x => x.foundNew.length),
			sum(x => x.nNew),
		),
		recallReopen: ratio(
			sum(x => x.foundReopen.length),
			sum(x => x.nReopen),
		),
		recallOther: ratio(
			sum(x => x.found.panel.length - x.foundReopen.length),
			sum(x => x.nFindings - x.nReopen),
		),
		real: sum(x => x.claims.real) / s.length,
		falses: sum(x => x.claims.false) / s.length,
	};
}

export interface Contrast {
	name: string;
	heads: number;
	/** Defect-weighted mean over heads, in recall (fractions) and in claims per run. */
	recall: number;
	/** 95% interval resampling pull requests (the primary interval), and resampling heads (optimistic). */
	recallCi: [number, number];
	recallCiHeads: [number, number];
	recallNew: number;
	recallNewCi: [number, number];
	recallReopen: number;
	recallOther: number;
	recallOtherCi: [number, number];
	realPerDiff: number;
	falsePerDiff: number;
	falsePerDiffCi: [number, number];
}

/**
 * A per-head difference averaged over heads, each head weighted by its number
 * of recorded findings, so a one-finding head (whose recall can only be 0 or
 * 1) does not weigh as much as a ten-finding one. Claim rates are weighted
 * the same way, so every figure of a contrast is over the same heads.
 */
function contrast(
	name: string,
	heads: string[],
	diff: (h: string) => Rates | null,
	weight: (h: string) => number,
): Contrast {
	const usable = heads.filter(h => diff(h) !== null);
	const mean = (hs: string[], k: (typeof RATE_KEYS)[number]): number => {
		let num = 0;
		let den = 0;
		for (const h of hs) {
			const d = diff(h);
			if (d === null || !Number.isFinite(d[k])) continue;
			num += weight(h) * d[k];
			den += weight(h);
		}
		return den === 0 ? Number.NaN : num / den;
	};
	return {
		name,
		heads: usable.length,
		recall: mean(usable, "recall"),
		recallCi: bootHeads(usable, s => mean(s, "recall"), laneOf),
		recallCiHeads: bootHeads(usable, s => mean(s, "recall")),
		recallNew: mean(usable, "recallNew"),
		recallNewCi: bootHeads(usable, s => mean(s, "recallNew"), laneOf),
		recallReopen: mean(usable, "recallReopen"),
		recallOther: mean(usable, "recallOther"),
		recallOtherCi: bootHeads(usable, s => mean(s, "recallOther"), laneOf),
		realPerDiff: mean(usable, "real"),
		falsePerDiff: mean(usable, "falses"),
		falsePerDiffCi: bootHeads(usable, s => mean(s, "falses"), laneOf),
	};
}

function findingsAt(scores: RunScore[]): (h: string) => number {
	const n = new Map(scores.map(s => [s.head, s.nFindings]));
	return h => n.get(h) ?? 0;
}

export function versusShipped(scores: RunScore[], arms: string[], control = "shipped"): Contrast[] {
	const heads = [...new Set(scores.map(s => s.head))].sort();
	return arms
		.filter(a => a !== control)
		.map(a =>
			contrast(
				`${a} - ${control}`,
				heads,
				h => {
					const x = headRates(scores, a, h);
					const y = headRates(scores, control, h);
					return x === null || y === null ? null : minus(x, y);
				},
				findingsAt(scores),
			),
		);
}

/**
 * A factor's effect at one head: the mean of the four factorial contrasts
 * that change only that factor. Null when any of the head's eight cells has
 * no scored run (every run of the cell errored): that head is left out.
 */
function factorEffectAt(scores: RunScore[], f: number, h: string): Rates | null {
	const ds: Rates[] = [];
	for (const [bits, arm] of Object.entries(CELLS)) {
		if (bits[f] !== "1") continue;
		const offArm = CELLS[`${bits.slice(0, f)}0${bits.slice(f + 1)}`];
		const on = headRates(scores, arm, h);
		const off = offArm === undefined ? null : headRates(scores, offArm, h);
		if (on === null || off === null) return null;
		ds.push(minus(on, off));
	}
	const avg = (k: keyof Rates): number => ds.reduce((a, d) => a + d[k], 0) / ds.length;
	return {
		recall: avg("recall"),
		recallNew: avg("recallNew"),
		recallReopen: avg("recallReopen"),
		recallOther: avg("recallOther"),
		real: avg("real"),
		falses: avg("falses"),
	};
}

/** Main effect of each factor, defect-weighted over heads. */
export function mainEffects(scores: RunScore[]): Contrast[] {
	const heads = [...new Set(scores.map(s => s.head))].sort();
	return FACTORS.map((name, f) =>
		contrast(`${name} (main effect)`, heads, h => factorEffectAt(scores, f, h), findingsAt(scores)),
	);
}

/**
 * Pairwise differences of the three main effects (loss - rebreak, loss -
 * repro, rebreak - repro): the comparison that says which behaviour carries
 * more of the effect, not only whether each carries any.
 */
export function effectDifferences(scores: RunScore[]): Contrast[] {
	const heads = [...new Set(scores.map(s => s.head))].sort();
	const pairs: [number, number][] = [
		[0, 1],
		[0, 2],
		[1, 2],
	];
	return pairs.map(([a, b]) =>
		contrast(
			`${FACTORS[a]} - ${FACTORS[b]} (difference of main effects)`,
			heads,
			h => {
				const x = factorEffectAt(scores, a, h);
				const y = factorEffectAt(scores, b, h);
				return x === null || y === null ? null : minus(x, y);
			},
			findingsAt(scores),
		),
	);
}

const pct = (x: number): string => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "n/a");
const pp = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)} pp` : "n/a");
const num = (x: number | null, d = 2): string => (x === null || !Number.isFinite(x) ? "n/a" : x.toFixed(d));

export function markdown(
	arms: ArmSummary[],
	vs: Contrast[],
	effects: Contrast[],
	differences: Contrast[] = [],
): string {
	const lines: string[] = [];
	lines.push(
		"| arm | runs | recorded defects found per diff | recall (pooled) | 95% Wilson | 95% over pull requests | recall, not in earlier round | frozen patterns | either judge or pattern |",
	);
	lines.push("|---|---|---|---|---|---|---|---|---|");
	for (const a of arms)
		lines.push(
			`| ${a.arm} | ${a.runs} | ${num(a.foundPerDiff)} | ${a.recall.hits} / ${a.recall.opps} = ${pct(a.recall.rate)} | ${pct(a.recall.wilson[0])}–${pct(a.recall.wilson[1])} | ${pct(a.recall.boot[0])}–${pct(a.recall.boot[1])} | ${a.recallNew.hits} / ${a.recallNew.opps} = ${pct(a.recallNew.rate)} | ${a.recallPatterns.hits} = ${pct(a.recallPatterns.rate)} | ${a.recallEither.hits} = ${pct(a.recallEither.rate)} |`,
		);
	lines.push("");
	lines.push(
		"| arm | claims per diff | real per diff | false per diff | unknown per diff | precision (real / real+false) | 95% over pull requests | decoys asserted | model requests per diff | output tokens per diff | wall minutes median / mean | load1 median / max | runnable median / max |",
	);
	lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
	for (const a of arms)
		lines.push(
			`| ${a.arm} | ${num(a.claimsPerDiff)} | ${num(a.realPerDiff)} | ${num(a.falsePerDiff)} | ${num(a.unknownPerDiff)} | ${a.precision.real} / ${a.precision.real + a.precision.false} = ${pct(a.precision.rate)} | ${pct(a.precision.boot[0])}–${pct(a.precision.boot[1])} | ${a.decoys.asserted} / ${a.decoys.opps} | ${num(a.callsPerDiff, 1)} | ${num(a.outputTokensPerDiff, 0)} | ${num(a.wallMinutes.median, 1)} / ${num(a.wallMinutes.mean, 1)} | ${a.load1 === null ? "n/a" : `${num(a.load1.median, 0)} / ${num(a.load1.max, 0)}`} | ${a.running === null ? "n/a" : `${num(a.running.median, 0)} / ${num(a.running.max, 0)}`} |`,
		);
	const table = (title: string, cs: Contrast[]): void => {
		lines.push("");
		lines.push(
			`| ${title} | heads | recall change (defect-weighted) | 95% over pull requests | 95% over heads | not in earlier round | 95% over pull requests | re-opened named findings | other findings | 95% over pull requests | real claims per diff change | false claims per diff change | 95% over pull requests |`,
		);
		lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
		for (const c of cs)
			lines.push(
				`| ${c.name} | ${c.heads} | ${pp(c.recall)} | ${pp(c.recallCi[0])} to ${pp(c.recallCi[1])} | ${pp(c.recallCiHeads[0])} to ${pp(c.recallCiHeads[1])} | ${pp(c.recallNew)} | ${pp(c.recallNewCi[0])} to ${pp(c.recallNewCi[1])} | ${pp(c.recallReopen)} | ${pp(c.recallOther)} | ${pp(c.recallOtherCi[0])} to ${pp(c.recallOtherCi[1])} | ${num(c.realPerDiff)} | ${num(c.falsePerDiff)} | ${num(c.falsePerDiffCi[0])} to ${num(c.falsePerDiffCi[1])} |`,
			);
	};
	table("paired against shipped", vs);
	if (effects.length > 0) table("factorial main effect", effects);
	if (differences.length > 0) table("which behaviour carries more", differences);
	return `${lines.join("\n")}\n`;
}

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runDirs = (get("--runs") ?? "").split(",").filter(Boolean);
	const judgements = get("--judgements");
	if (runDirs.length === 0 || judgements === undefined) {
		console.error(
			"usage: brief-lane.ts --runs <dir>[,<dir>...] --judgements <dir> [--cases cases-c.json] [--briefs cases-brief.json] [--heads a,b] [--minutes 10] [--json out] [--md out]",
		);
		process.exit(2);
	}
	const all = JSON.parse(
		fs.readFileSync(get("--cases") ?? path.join(import.meta.dir, "cases-c.json"), "utf8"),
	) as ClaimsCaseFile & { heads: HeadCase[]; prior_overlap?: string[] };
	// `--heads` restricts scoring to the heads a run was frozen on; cases at other heads are left out entirely.
	const keep = get("--heads")?.split(",");
	const cases =
		keep === undefined
			? all
			: {
					...all,
					heads: all.heads.filter(h => keep.includes(h.id)),
					findings: all.findings.filter(f => keep.includes(f.head)),
					decoys: all.decoys.filter(d => keep.includes(d.head)),
				};
	const briefsPath = get("--briefs") ?? path.join(import.meta.dir, "cases-brief.json");
	const reopens = new Set<string>(
		fs.existsSync(briefsPath)
			? Object.values(
					(
						JSON.parse(fs.readFileSync(briefsPath, "utf8")) as {
							heads: Record<string, { reopens?: Record<string, string[]> }>;
						}
					).heads,
				).flatMap(h => Object.keys(h.reopens ?? {}))
			: [],
	);
	const runs = runDirs.flatMap(d => loadRuns(d));
	const scores = scoreRuns(cases, runs, judgements, Number(get("--minutes") ?? "10"), reopens);
	const decoysAt = new Map<string, number>();
	for (const d of cases.decoys) decoysAt.set(d.head, (decoysAt.get(d.head) ?? 0) + 1);
	const arms = summarise(scores, decoysAt);
	const armNames = arms.map(a => a.arm);
	const vs = armNames.includes("shipped") ? versusShipped(scores, armNames) : [];
	const factorial = Object.values(CELLS).every(c => armNames.includes(c));
	const effects = factorial ? mainEffects(scores) : [];
	const differences = factorial ? effectDifferences(scores) : [];
	const md = markdown(arms, vs, effects, differences);
	console.log(md);
	const errored = runs.filter(r => r.error !== undefined).map(r => r.runId);
	console.log(`errored runs, excluded: ${errored.length}${errored.length > 0 ? ` (${errored.join(", ")})` : ""}`);
	const jsonOut = get("--json");
	if (jsonOut !== undefined)
		fs.writeFileSync(
			jsonOut,
			`${JSON.stringify({ runDirs, judgements, arms, versusShipped: vs, mainEffects: effects, effectDifferences: differences, errored, scores }, null, 2)}\n`,
		);
	const mdOut = get("--md");
	if (mdOut !== undefined) fs.writeFileSync(mdOut, md);
}

if (import.meta.main) main();
