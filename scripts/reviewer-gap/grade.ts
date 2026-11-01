#!/usr/bin/env bun
/**
 * Mechanical grader for the reviewer-gap eval.
 *
 * A run's report text is graded against the frozen findings in `cases.json`.
 * A finding counts as detected when, inside one sliding window of
 * `window_chars` characters, every mechanism group and every trigger group has
 * at least one matching pattern. No model is called: the trigger of every
 * finding in the corpus is concrete (a file, a syscall, an ordering), so the
 * patterns are literal.
 *
 * Usage:
 *   bun scripts/reviewer-gap/grade.ts --runs <dir> [--cases <cases.json>] [--json <out.json>]
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface Finding {
	id: string;
	head: string;
	severity: string;
	how_found_primary: string;
	title: string;
	/** AND of OR-groups. Each inner array is one group of alternative patterns. */
	mechanism: string[][];
	trigger: string[][];
}

export interface HeadCase {
	id: string;
	pr: number;
	round: number;
	head_sha: string;
	base_sha: string;
	checkout: string;
	diff: string;
	subject: string;
	packages: string[];
}

export interface CaseFile {
	frozen_at: string;
	window_chars: number;
	heads: HeadCase[];
	findings: Finding[];
}

/** What the box was doing when a run started or ended: `/proc/loadavg` and `/proc/stat`. */
export interface BoxLoad {
	load1: number;
	/** Runnable and blocked tasks, as `vmstat` reports `r` and `b`. */
	procsRunning: number;
	procsBlocked: number;
}

export interface RunRecord {
	runId: string;
	arm: string;
	head: string;
	trial: number;
	model: string;
	report: string;
	costUsd: number;
	elapsedMs: number;
	exitCode: number;
	error?: string;
	/** The session's stderr tail when it exited non-zero, e.g. `--max-time` ending a background-job wait. Absent on runs recorded before the brief lane's 2026-11-01 stage-1 relaunch. */
	stderr?: string;
	/** Model requests (assistant messages), tool calls by tool, and tokens. Absent on runs before 2026-11-01. */
	usage?: {
		calls: number;
		toolCalls: Record<string, number>;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	box?: { start: BoxLoad; end: BoxLoad };
	/** The brief the run's user prompt carried: which elements had text at this head, and its length. */
	brief?: { elements: string[]; chars: number };
	/** What the session's scratch kept after pruning, what pruning removed, and kept files over 8 MiB (`run.ts` `pruneScratch`). */
	scratch?: { keptBytes: number; removedBytes: number; removed: string[]; large: string[] };
}

/** Lowercased text and the per-group match offsets of one pattern set. */
function groupOffsets(haystack: string, groups: string[][]): number[][] | null {
	const out: number[][] = [];
	for (const group of groups) {
		const hits: number[] = [];
		for (const pattern of group) {
			const re = new RegExp(pattern, "gi");
			for (;;) {
				const m = re.exec(haystack);
				if (m === null) break;
				hits.push(m.index);
				if (re.lastIndex === m.index) re.lastIndex++;
			}
		}
		if (hits.length === 0) return null;
		hits.sort((a, b) => a - b);
		out.push(hits);
	}
	return out;
}

/**
 * True when every group has a hit inside one window of `windowChars`.
 * Sweeps each hit of the first group as a window anchor; windows are centred on
 * the anchor so a group matching slightly before it still counts.
 */
export function detects(report: string, finding: Finding, windowChars: number): boolean {
	const groups = [...finding.mechanism, ...finding.trigger];
	if (groups.length === 0) return false;
	const offsets = groupOffsets(report, groups);
	if (offsets === null) return false;
	const anchors = offsets[0] ?? [];
	for (const anchor of anchors) {
		const lo = anchor - windowChars / 2;
		const hi = anchor + windowChars / 2;
		let all = true;
		for (const hits of offsets) {
			if (!hits.some(h => h >= lo && h <= hi)) {
				all = false;
				break;
			}
		}
		if (all) return true;
	}
	return false;
}

/**
 * Diagnostic only, never a score: how many groups the report satisfies anywhere
 * in its text, ignoring the window. A finding whose mechanism groups all match
 * but whose trigger groups do not is a reviewer that named the code and not the
 * way to reproduce it; a count of those says whether the window or the trigger
 * requirement is what the frozen rule rejects.
 */
export function satisfiedGroups(
	report: string,
	finding: Finding,
): { mechanism: number; mechanismTotal: number; trigger: number; triggerTotal: number } {
	const count = (groups: string[][]): number =>
		groups.filter(group => group.some(pattern => new RegExp(pattern, "i").test(report))).length;
	return {
		mechanism: count(finding.mechanism),
		mechanismTotal: finding.mechanism.length,
		trigger: count(finding.trigger),
		triggerTotal: finding.trigger.length,
	};
}

export interface Interval {
	lo: number;
	hi: number;
}

/** Wilson score interval for a binomial proportion, 95%. */
export function wilson(successes: number, n: number): Interval {
	if (n === 0) return { lo: 0, hi: 1 };
	const z = 1.959963984540054;
	const p = successes / n;
	const d = 1 + (z * z) / n;
	const centre = p + (z * z) / (2 * n);
	const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}

/** Deterministic 32-bit PRNG so a reported interval can be reproduced. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Cluster bootstrap over runs: findings inside one run are not independent, so
 * the resampling unit is the run, not the finding.
 */
export function clusterBootstrap(
	clusters: { successes: number; n: number }[],
	iterations = 10000,
	seed = 20261030,
): Interval {
	if (clusters.length === 0) return { lo: 0, hi: 1 };
	const rand = mulberry32(seed);
	const means: number[] = [];
	for (let i = 0; i < iterations; i++) {
		let s = 0;
		let n = 0;
		for (let k = 0; k < clusters.length; k++) {
			const c = clusters[Math.floor(rand() * clusters.length)];
			if (c === undefined) continue;
			s += c.successes;
			n += c.n;
		}
		if (n > 0) means.push(s / n);
	}
	if (means.length === 0) return { lo: 0, hi: 1 };
	means.sort((a, b) => a - b);
	const at = (q: number): number =>
		means[Math.min(means.length - 1, Math.max(0, Math.round(q * (means.length - 1))))] ?? 0;
	return { lo: at(0.025), hi: at(0.975) };
}

export interface ArmResult {
	arm: string;
	model: string;
	runs: number;
	n: number;
	detected: number;
	rate: number;
	wilson: Interval;
	bootstrap: Interval;
	byHowFound: Record<string, { n: number; detected: number }>;
	bySeverity: Record<string, { n: number; detected: number }>;
	perFinding: Record<string, { n: number; detected: number }>;
	costUsd: number;
	failedRuns: number;
}

export function gradeRuns(cases: CaseFile, runs: RunRecord[]): ArmResult[] {
	const byFinding = new Map<string, Finding[]>();
	for (const f of cases.findings) {
		const list = byFinding.get(f.head) ?? [];
		list.push(f);
		byFinding.set(f.head, list);
	}
	const arms = new Map<string, RunRecord[]>();
	for (const r of runs) {
		const list = arms.get(r.arm) ?? [];
		list.push(r);
		arms.set(r.arm, list);
	}
	const out: ArmResult[] = [];
	for (const [arm, armRuns] of arms) {
		// A run that errored is not a score: it is excluded and counted separately.
		const usable = armRuns.filter(r => r.error === undefined && r.report.trim().length > 0);
		const clusters: { successes: number; n: number }[] = [];
		const byHowFound: Record<string, { n: number; detected: number }> = {};
		const bySeverity: Record<string, { n: number; detected: number }> = {};
		const perFinding: Record<string, { n: number; detected: number }> = {};
		let detected = 0;
		let n = 0;
		for (const run of usable) {
			const findings = byFinding.get(run.head) ?? [];
			let hits = 0;
			for (const f of findings) {
				const hit = detects(run.report, f, cases.window_chars);
				if (hit) hits++;
				const hf = (byHowFound[f.how_found_primary] ??= { n: 0, detected: 0 });
				hf.n++;
				if (hit) hf.detected++;
				const sv = (bySeverity[f.severity] ??= { n: 0, detected: 0 });
				sv.n++;
				if (hit) sv.detected++;
				const pf = (perFinding[f.id] ??= { n: 0, detected: 0 });
				pf.n++;
				if (hit) pf.detected++;
			}
			clusters.push({ successes: hits, n: findings.length });
			detected += hits;
			n += findings.length;
		}
		out.push({
			arm,
			model: usable[0]?.model ?? armRuns[0]?.model ?? "",
			runs: usable.length,
			n,
			detected,
			rate: n === 0 ? 0 : detected / n,
			wilson: wilson(detected, n),
			bootstrap: clusterBootstrap(clusters),
			byHowFound,
			bySeverity,
			perFinding,
			costUsd: armRuns.reduce((a, r) => a + r.costUsd, 0),
			failedRuns: armRuns.length - usable.length,
		});
	}
	out.sort((a, b) => a.arm.localeCompare(b.arm));
	return out;
}

/**
 * Records in run-id order. The cluster bootstrap resamples cluster indices from
 * a seeded PRNG, so the order clusters are built in decides the interval: a
 * readdir order would make a published interval depend on the filesystem.
 */
export function loadRuns(dir: string): RunRecord[] {
	const out: RunRecord[] = [];
	for (const entry of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
		if (!entry.endsWith(".json")) continue;
		if (entry === "results.json" || entry === "plan.json") continue;
		const raw = fs.readFileSync(path.join(dir, entry), "utf8");
		out.push(JSON.parse(raw) as RunRecord);
	}
	return out;
}

function pct(x: number): string {
	return `${(100 * x).toFixed(1)}%`;
}

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runsDir = get("--runs");
	if (runsDir === undefined) {
		console.error("usage: grade.ts --runs <dir> [--cases <cases.json>] [--json <out.json>]");
		process.exit(2);
	}
	const casesPath = get("--cases") ?? path.join(import.meta.dir, "cases.json");
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as CaseFile;
	const runs = loadRuns(runsDir);
	const results = gradeRuns(cases, runs);
	const jsonOut = get("--json");
	if (jsonOut !== undefined)
		fs.writeFileSync(
			jsonOut,
			`${JSON.stringify({ cases: casesPath, frozen_at: cases.frozen_at, results }, null, 2)}\n`,
		);

	console.log(
		`cases frozen at ${cases.frozen_at}; ${cases.findings.length} findings over ${cases.heads.length} heads\n`,
	);
	console.log(
		"| arm | model | runs | n | detected | rate | 95% Wilson | 95% cluster bootstrap | cost USD | errored runs |",
	);
	console.log("|---|---|---|---|---|---|---|---|---|---|");
	for (const r of results) {
		console.log(
			`| ${r.arm} | ${r.model} | ${r.runs} | ${r.n} | ${r.detected} | ${pct(r.rate)} | ${pct(r.wilson.lo)}–${pct(r.wilson.hi)} | ${pct(r.bootstrap.lo)}–${pct(r.bootstrap.hi)} | ${r.costUsd.toFixed(2)} | ${r.failedRuns} |`,
		);
	}
	console.log("\n| arm | how_found_primary | detected / n |");
	console.log("|---|---|---|");
	for (const r of results) {
		for (const [k, v] of Object.entries(r.byHowFound).sort()) {
			console.log(`| ${r.arm} | ${k} | ${v.detected} / ${v.n} |`);
		}
	}
}

if (import.meta.main) main();
