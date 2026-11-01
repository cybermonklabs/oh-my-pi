#!/usr/bin/env bun
/**
 * Scoring for the claims lane (`claims-freeze.json`, `cases-c.json`).
 *
 * The first three lanes scored recall only: a finding counted when its patterns
 * matched anywhere in the report. That cannot see a reviewer that asserts a
 * defect which is not there, and it credits a report that names a real defect
 * only to clear it. This lane's cases carry both kinds, at real heads of the
 * batch's pull requests:
 *
 *   findings - real defects at the head, each with the original review's labels
 *              of which arm found it and which missed it;
 *   decoys   - claims a reviewer of this batch asserted at the head and that a
 *              measurement or a code fact then showed were not defects of the
 *              change: a probe or harness fault, an assertion the fix had
 *              deliberately changed, the environment, a misread.
 *
 * Detection is `detects` from grade.ts, unchanged. What changes is where it
 * looks: a report in the `claims` format (run.ts) puts each asserted defect
 * under a `## DEFECT:` heading and everything it cleared under
 * `## NOT A DEFECT`, and only the `## DEFECT:` sections are claims. A finding
 * is found, and a decoy is asserted, when its patterns fire inside one claimed
 * section. The whole-report rule of the earlier lanes is kept as a diagnostic
 * (`mentioned`): a decoy no arm ever mentions measures nothing.
 *
 * Usage:
 *   bun scripts/reviewer-gap/claims.ts --runs <dir>[,<dir>...] [--cases cases-c.json]
 *        [--compare a:b[,a:b...]] [--json <out.json>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type CaseFile,
	type Finding,
	type Interval,
	type RunRecord,
	clusterBootstrap,
	detects,
	loadRuns,
	wilson,
} from "./grade.ts";

/**
 * The report shape the runner asks for. `prose` (the default, and every lane
 * before this one) is one section per defect; `claims` is the shape this file
 * scores; `verdict` is one claim's verdict, which `verdict.ts` scores.
 */
export type ReportFormat = "prose" | "claims" | "verdict";

export const DECOY_CLASSES = [
	"probe-defect",
	"obsolete-assertion",
	"harness-invented",
	"environment",
	"misread-code",
	"other",
] as const;
export type DecoyClass = (typeof DECOY_CLASSES)[number];

export const ARM_LABELS = ["found", "missed", "not-run"] as const;
export type ArmLabel = (typeof ARM_LABELS)[number];

/** A real defect at a head, with the original review's per-arm labels. */
export interface ClaimFinding extends Finding {
	found_by: { astra: ArmLabel; claude: ArmLabel };
}

/** A claim that looks like a defect at a head and is not one. */
export interface Decoy {
	id: string;
	head: string;
	title: string;
	decoy_class: DecoyClass;
	/** How it was refuted: measurement, code-fact, self-withdrawn, deliberate-change. */
	refuted_by: string;
	/** Whether the original reviewer asserted it, or raised it and withdrew it in the same report. */
	origin?: "asserted" | "withdrawn";
	mechanism: string[][];
	trigger: string[][];
}

export interface ClaimsCaseFile extends CaseFile {
	report_format: "claims";
	findings: ClaimFinding[];
	decoys: Decoy[];
	/** Case ids the earlier round given to the run already states; claimable by repeating it. */
	prior_overlap?: string[];
}

/** A decoy in the shape `detects` takes; detection reads only the patterns. */
export function asPatterns(d: Decoy): Finding {
	return {
		id: d.id,
		head: d.head,
		severity: "decoy",
		how_found_primary: "decoy",
		title: d.title,
		mechanism: d.mechanism,
		trigger: d.trigger,
	};
}

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** `DEFECT:`, `DEFECT 2:`, `**Defect** -`; never `DEFECTS`, `Defect status` or `NOT A DEFECT`. */
const DEFECT_HEADING = /^[\W_]*defect\b[\W_]*\d*[\W_]*?\s*[:.\-–—]/i;
const CLEARED_HEADING = /^[\W_]*(not\s+(a\s+)?defects?|non-?defects?)\b/i;
const NO_DEFECTS = /^[ \t]*[*_`]*[ \t]*no defects( found)?[ \t]*[*_`.!]*[ \t]*$/i;

export function isDefectHeading(text: string): boolean {
	return DEFECT_HEADING.test(text) && !/^[\W_]*defects\b/i.test(text);
}

interface MarkdownLine {
	text: string;
	/** Inside a fenced block, or one of its fence lines: quoted output, never structure. */
	fenced: boolean;
	heading?: { level: number; text: string };
}

/**
 * The lines of a report with the structure CommonMark gives them: fenced
 * blocks close only on a fence of the same character at least as long as the
 * opening one, and a setext underline (`===` or `---` under a text line) makes
 * the line above it a heading of level 1 or 2.
 */
export function markdownLines(report: string): MarkdownLine[] {
	const raw = report.split("\n");
	const out: MarkdownLine[] = [];
	let fence: { char: string; length: number } | null = null;
	for (let i = 0; i < raw.length; i++) {
		const text = raw[i] as string;
		if (fence !== null) {
			const close = FENCE_CLOSE.exec(text)?.[1];
			if (close !== undefined && close[0] === fence.char && close.length >= fence.length) fence = null;
			out.push({ text, fenced: true });
			continue;
		}
		const open = FENCE_OPEN.exec(text)?.[1];
		// A backtick fence's info string cannot hold a backtick; such a line is inline code.
		if (open !== undefined && !(open[0] === "`" && text.trimStart().slice(open.length).includes("`"))) {
			fence = { char: open[0] as string, length: open.length };
			out.push({ text, fenced: true });
			continue;
		}
		const atx = ATX.exec(text);
		if (atx !== null) {
			out.push({ text, fenced: false, heading: { level: (atx[1] as string).length, text: atx[2] as string } });
			continue;
		}
		const next = raw[i + 1];
		if (next !== undefined && text.trim() !== "" && !/^ {0,3}>/.test(text) && SETEXT_UNDERLINE.test(next)) {
			out.push({ text, fenced: false, heading: { level: next.trim().startsWith("=") ? 1 : 2, text: text.trim() } });
			out.push({ text: next, fenced: false });
			i++;
			continue;
		}
		out.push({ text, fenced: false });
	}
	return out;
}

/**
 * The claimed sections of a report: each runs from a `DEFECT` heading to the
 * next heading of the same or a higher level, or to a `NOT A DEFECT` heading
 * at any level, since what follows that heading is what the reviewer cleared.
 */
export function claimedSections(report: string): string[] {
	const out: string[] = [];
	let current: { level: number; lines: string[] } | null = null;
	for (const line of markdownLines(report)) {
		const h = line.heading;
		if (h !== undefined) {
			if (current !== null && (h.level <= current.level || CLEARED_HEADING.test(h.text))) {
				out.push(current.lines.join("\n"));
				current = null;
			}
			if (current === null && isDefectHeading(h.text)) {
				current = { level: h.level, lines: [line.text] };
				continue;
			}
		}
		if (current !== null) current.lines.push(line.text);
	}
	if (current !== null) out.push(current.lines.join("\n"));
	return out;
}

/**
 * A report follows the claims format when it claims something, or says on a
 * line of its own, outside quoted output and block quotes, that it claims
 * nothing.
 */
export function isFormatted(report: string): boolean {
	if (claimedSections(report).length > 0) return true;
	return markdownLines(report).some(l => !l.fenced && !/^ {0,3}>/.test(l.text) && NO_DEFECTS.test(l.text));
}

export interface RunScore {
	runId: string;
	arm: string;
	head: string;
	trial: number;
	claims: number;
	/** Finding ids whose patterns fire inside one claimed section. */
	found: string[];
	/** Decoy ids whose patterns fire inside one claimed section. */
	asserted: string[];
	/** Claimed sections that match no finding and no decoy of the head. */
	unmatchedClaims: number;
	/** Whole-report rule of the earlier lanes; diagnostic only. */
	mentionedFindings: string[];
	mentionedDecoys: string[];
}

function byHead<T extends { head: string }>(items: T[]): Map<string, T[]> {
	const m = new Map<string, T[]>();
	for (const it of items) m.set(it.head, [...(m.get(it.head) ?? []), it]);
	return m;
}

export function scoreRun(cases: ClaimsCaseFile, run: RunRecord): RunScore {
	const findings = cases.findings.filter(f => f.head === run.head);
	const decoys = cases.decoys.filter(d => d.head === run.head).map(asPatterns);
	const sections = claimedSections(run.report);
	const w = cases.window_chars;
	const hits = (pats: Finding[]): string[] => pats.filter(p => sections.some(s => detects(s, p, w))).map(p => p.id);
	let unmatched = 0;
	for (const s of sections) {
		if (!findings.some(f => detects(s, f, w)) && !decoys.some(d => detects(s, d, w))) unmatched++;
	}
	return {
		runId: run.runId,
		arm: run.arm,
		head: run.head,
		trial: run.trial,
		claims: sections.length,
		found: hits(findings),
		asserted: hits(decoys),
		unmatchedClaims: unmatched,
		mentionedFindings: findings.filter(f => detects(run.report, f, w)).map(f => f.id),
		mentionedDecoys: decoys.filter(d => detects(run.report, d, w)).map(d => d.id),
	};
}

export interface Rate {
	n: number;
	hits: number;
	rate: number;
	wilson: Interval;
	bootstrap: Interval;
}

function rate(clusters: { successes: number; n: number }[]): Rate {
	const n = clusters.reduce((a, c) => a + c.n, 0);
	const hits = clusters.reduce((a, c) => a + c.successes, 0);
	return { n, hits, rate: n === 0 ? 0 : hits / n, wilson: wilson(hits, n), bootstrap: clusterBootstrap(clusters) };
}

export interface ClaimsArmResult {
	arm: string;
	model: string;
	runs: number;
	erroredRuns: number;
	/** Runs with a report that neither claims anything nor says `NO DEFECTS`. Excluded from n. */
	unformattedRuns: number;
	findings: Rate;
	decoys: Rate;
	/** Findings the original review's astra arm missed, and those its Claude arm missed. */
	findingsAstraMissed: Rate;
	findingsClaudeMissed: Rate;
	/** Leaving out the cases the earlier round given to the run already states. */
	findingsNotInPrior: Rate;
	decoysNotInPrior: Rate;
	decoysOriginallyAsserted: Rate;
	decoysOriginallyWithdrawn: Rate;
	decoysByClass: Record<string, { n: number; hits: number }>;
	claims: number;
	unmatchedClaims: number;
	mentionedFindings: Rate;
	mentionedDecoys: Rate;
	perCase: Record<string, { kind: "finding" | "decoy"; n: number; hits: number; mentioned: number }>;
	costUsd: number;
	scores: RunScore[];
}

export function gradeClaims(cases: ClaimsCaseFile, runs: RunRecord[]): ClaimsArmResult[] {
	const findingsAt = byHead(cases.findings);
	const decoysAt = byHead(cases.decoys);
	const arms = new Map<string, RunRecord[]>();
	// A run on a head the case file does not hold has nothing to be scored against; the
	// caller can see how many were left out from the runs it passed.
	const heads = new Set(cases.heads.map(h => h.id));
	for (const r of runs) if (heads.has(r.head)) arms.set(r.arm, [...(arms.get(r.arm) ?? []), r]);
	const out: ClaimsArmResult[] = [];
	for (const [arm, armRuns] of arms) {
		// A run that errored is not a score, as in grade.ts: excluded and counted.
		const ok = armRuns.filter(r => r.error === undefined && r.report.trim().length > 0);
		const formatted = ok.filter(r => isFormatted(r.report));
		const scores = formatted.map(r => scoreRun(cases, r));
		const perCase: ClaimsArmResult["perCase"] = {};
		const decoysByClass: Record<string, { n: number; hits: number }> = {};
		const cl = {
			findings: [] as { successes: number; n: number }[],
			decoys: [] as { successes: number; n: number }[],
			astraMissed: [] as { successes: number; n: number }[],
			claudeMissed: [] as { successes: number; n: number }[],
			findingsNew: [] as { successes: number; n: number }[],
			decoysNew: [] as { successes: number; n: number }[],
			decoysAsserted: [] as { successes: number; n: number }[],
			decoysWithdrawn: [] as { successes: number; n: number }[],
			mentionedFindings: [] as { successes: number; n: number }[],
			mentionedDecoys: [] as { successes: number; n: number }[],
		};
		const overlap = new Set(cases.prior_overlap ?? []);
		for (const s of scores) {
			const fs_ = findingsAt.get(s.head) ?? [];
			const ds = decoysAt.get(s.head) ?? [];
			const share = (ids: string[], pool: { id: string }[]): { successes: number; n: number } => ({
				successes: pool.filter(p => ids.includes(p.id)).length,
				n: pool.length,
			});
			cl.findings.push(share(s.found, fs_));
			cl.decoys.push(share(s.asserted, ds));
			cl.astraMissed.push(
				share(
					s.found,
					fs_.filter(f => f.found_by.astra === "missed"),
				),
			);
			cl.claudeMissed.push(
				share(
					s.found,
					fs_.filter(f => f.found_by.claude === "missed"),
				),
			);
			cl.findingsNew.push(
				share(
					s.found,
					fs_.filter(f => !overlap.has(f.id)),
				),
			);
			cl.decoysNew.push(
				share(
					s.asserted,
					ds.filter(d => !overlap.has(d.id)),
				),
			);
			cl.decoysAsserted.push(
				share(
					s.asserted,
					ds.filter(d => d.origin === "asserted"),
				),
			);
			cl.decoysWithdrawn.push(
				share(
					s.asserted,
					ds.filter(d => d.origin === "withdrawn"),
				),
			);
			cl.mentionedFindings.push(share(s.mentionedFindings, fs_));
			cl.mentionedDecoys.push(share(s.mentionedDecoys, ds));
			for (const f of fs_) {
				const pc = (perCase[f.id] ??= { kind: "finding", n: 0, hits: 0, mentioned: 0 });
				pc.n++;
				if (s.found.includes(f.id)) pc.hits++;
				if (s.mentionedFindings.includes(f.id)) pc.mentioned++;
			}
			for (const d of ds) {
				const pc = (perCase[d.id] ??= { kind: "decoy", n: 0, hits: 0, mentioned: 0 });
				pc.n++;
				const hit = s.asserted.includes(d.id);
				if (hit) pc.hits++;
				if (s.mentionedDecoys.includes(d.id)) pc.mentioned++;
				const bc = (decoysByClass[d.decoy_class] ??= { n: 0, hits: 0 });
				bc.n++;
				if (hit) bc.hits++;
			}
		}
		out.push({
			arm,
			model: ok[0]?.model ?? armRuns[0]?.model ?? "",
			runs: scores.length,
			erroredRuns: armRuns.length - ok.length,
			unformattedRuns: ok.length - formatted.length,
			findings: rate(cl.findings),
			decoys: rate(cl.decoys),
			findingsAstraMissed: rate(cl.astraMissed),
			findingsClaudeMissed: rate(cl.claudeMissed),
			findingsNotInPrior: rate(cl.findingsNew),
			decoysNotInPrior: rate(cl.decoysNew),
			decoysOriginallyAsserted: rate(cl.decoysAsserted),
			decoysOriginallyWithdrawn: rate(cl.decoysWithdrawn),
			decoysByClass,
			claims: scores.reduce((a, s) => a + s.claims, 0),
			unmatchedClaims: scores.reduce((a, s) => a + s.unmatchedClaims, 0),
			mentionedFindings: rate(cl.mentionedFindings),
			mentionedDecoys: rate(cl.mentionedDecoys),
			perCase,
			costUsd: armRuns.reduce((a, r) => a + r.costUsd, 0),
			scores,
		});
	}
	out.sort((a, b) => a.arm.localeCompare(b.arm));
	return out;
}

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface ClaimsPaired {
	a: string;
	b: string;
	pairs: number;
	/** a − b, percentage points, for found findings (higher is better). */
	findings: { deltaPp: number; lo: number; hi: number };
	/** a − b, percentage points, for asserted decoys (lower is better). */
	decoys: { deltaPp: number; lo: number; hi: number };
}

/**
 * Paired cluster bootstrap over (head, trial) pairs, as rounds.ts does for
 * findings: both arms saw the same head at the same trial index, so the pair
 * is the resampling unit. Findings and decoys are resampled together, so the
 * two intervals come from the same draws; a draw whose pairs hold no decoy (or
 * no finding) has no rate for that metric and is left out of its interval, as
 * `clusterBootstrap` leaves out an empty draw. Two runs of one arm on the same
 * head and trial cannot be paired and stop the comparison.
 */
export function compareClaims(
	cases: ClaimsCaseFile,
	results: ClaimsArmResult[],
	armA: string,
	armB: string,
	iterations = 10000,
	seed = 20261031,
): ClaimsPaired {
	const nf = new Map<string, number>();
	const nd = new Map<string, number>();
	for (const f of cases.findings) nf.set(f.head, (nf.get(f.head) ?? 0) + 1);
	for (const d of cases.decoys) nd.set(d.head, (nd.get(d.head) ?? 0) + 1);
	const byPair = (arm: string): Map<string, RunScore> => {
		const m = new Map<string, RunScore>();
		for (const s of results.find(r => r.arm === arm)?.scores ?? []) {
			const k = `${s.head}__t${s.trial}`;
			if (m.has(k)) throw new Error(`arm ${arm} has two runs on ${k}; pass one run directory per arm`);
			m.set(k, s);
		}
		return m;
	};
	const a = byPair(armA);
	const b = byPair(armB);
	const pairs: { fa: number; fb: number; nf: number; da: number; db: number; nd: number }[] = [];
	for (const [k, sa] of [...a].sort(([x], [y]) => x.localeCompare(y))) {
		const sb = b.get(k);
		if (sb === undefined) continue;
		pairs.push({
			fa: sa.found.length,
			fb: sb.found.length,
			nf: nf.get(sa.head) ?? 0,
			da: sa.asserted.length,
			db: sb.asserted.length,
			nd: nd.get(sa.head) ?? 0,
		});
	}
	/** a − b over the selected pairs, or undefined when they hold no case of that kind. */
	const delta = (sel: typeof pairs): [number | undefined, number | undefined] => {
		const sum = (f: (p: (typeof pairs)[0]) => number): number => sel.reduce((x, p) => x + f(p), 0);
		const n1 = sum(p => p.nf);
		const n2 = sum(p => p.nd);
		return [
			n1 === 0 ? undefined : (sum(p => p.fa) - sum(p => p.fb)) / n1,
			n2 === 0 ? undefined : (sum(p => p.da) - sum(p => p.db)) / n2,
		];
	};
	const [pf, pd] = delta(pairs);
	const rnd = mulberry32(seed);
	const df: number[] = [];
	const dd: number[] = [];
	for (let i = 0; i < iterations && pairs.length > 0; i++) {
		const sel = Array.from(
			{ length: pairs.length },
			() => pairs[Math.floor(rnd() * pairs.length)] as (typeof pairs)[0],
		);
		const [f, d] = delta(sel);
		if (f !== undefined) df.push(f);
		if (d !== undefined) dd.push(d);
	}
	const q = (xs: number[], p: number): number => {
		const s = [...xs].sort((x, y) => x - y);
		return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))] ?? 0;
	};
	return {
		a: armA,
		b: armB,
		pairs: pairs.length,
		findings: { deltaPp: pf === undefined ? Number.NaN : 100 * pf, lo: 100 * q(df, 0.025), hi: 100 * q(df, 0.975) },
		decoys: { deltaPp: pd === undefined ? Number.NaN : 100 * pd, lo: 100 * q(dd, 0.025), hi: 100 * q(dd, 0.975) },
	};
}

/**
 * Case ids whose patterns a prompt's own text satisfies: an arm could score
 * those findings, or be charged those decoys, by echoing its prompt.
 */
export function promptSatisfies(prompt: string, cases: ClaimsCaseFile): string[] {
	const pats = [...cases.findings, ...cases.decoys.map(asPatterns)];
	return pats
		.filter(p => detects(prompt, p, cases.window_chars))
		.map(p => p.id)
		.sort();
}

function pct(x: number): string {
	return `${(100 * x).toFixed(1)}%`;
}

function cell(r: Rate): string {
	return `${r.hits} / ${r.n} = ${pct(r.rate)} (Wilson ${pct(r.wilson.lo)}–${pct(r.wilson.hi)}; runs ${pct(r.bootstrap.lo)}–${pct(r.bootstrap.hi)})`;
}

function main(): void {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runsArg = get("--runs");
	if (runsArg === undefined) {
		console.error(
			"usage: claims.ts --runs <dir>[,<dir>...] [--cases cases-c.json] [--compare a:b,...] [--json out.json]",
		);
		process.exit(2);
	}
	const casesPath = get("--cases") ?? path.join(import.meta.dir, "cases-c.json");
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as ClaimsCaseFile;
	const runs = runsArg
		.split(",")
		.filter(s => s.length > 0)
		.flatMap(d => loadRuns(d))
		.sort((x, y) => x.runId.localeCompare(y.runId));
	const results = gradeClaims(cases, runs);
	const pairs = (get("--compare") ?? "")
		.split(",")
		.filter(s => s.includes(":"))
		.map(s => s.split(":") as [string, string])
		.map(([a, b]) => compareClaims(cases, results, a, b));
	const jsonOut = get("--json");
	if (jsonOut !== undefined)
		fs.writeFileSync(
			jsonOut,
			`${JSON.stringify({ cases: casesPath, frozen_at: cases.frozen_at, results, pairs }, null, 2)}\n`,
		);

	console.log(
		`cases frozen at ${cases.frozen_at}; ${cases.findings.length} findings and ${cases.decoys.length} decoys over ${cases.heads.length} heads; ${runs.filter(r => !cases.heads.some(h => h.id === r.head)).length} of ${runs.length} runs are on heads outside the case file and are not scored\n`,
	);
	for (const r of results) {
		console.log(`## ${r.arm} (${r.model})`);
		console.log(`- runs scored ${r.runs}; errored ${r.erroredRuns}; unformatted ${r.unformattedRuns}`);
		console.log(`- real defects claimed: ${cell(r.findings)}`);
		console.log(`  - of those the original astra arm missed: ${cell(r.findingsAstraMissed)}`);
		console.log(`  - of those the original Claude arm missed: ${cell(r.findingsClaudeMissed)}`);
		console.log(
			`  - leaving out those the earlier round given to the run already states: ${cell(r.findingsNotInPrior)}`,
		);
		console.log(`- decoys asserted as defects: ${cell(r.decoys)}`);
		console.log(`  - decoys the original reviewer asserted: ${cell(r.decoysOriginallyAsserted)}`);
		console.log(`  - decoys the original reviewer raised and withdrew: ${cell(r.decoysOriginallyWithdrawn)}`);
		console.log(`  - leaving out those the earlier round already states: ${cell(r.decoysNotInPrior)}`);
		for (const [k, v] of Object.entries(r.decoysByClass).sort()) console.log(`  - ${k}: ${v.hits} / ${v.n}`);
		console.log(`- claimed sections ${r.claims}; matching no case ${r.unmatchedClaims}`);
		console.log(
			`- diagnostic, whole report: findings mentioned ${cell(r.mentionedFindings)}; decoys mentioned ${cell(r.mentionedDecoys)}`,
		);
		console.log("\n| case | kind | claimed / runs | mentioned / runs |\n|---|---|---|---|");
		for (const [id, v] of Object.entries(r.perCase).sort())
			console.log(`| ${id} | ${v.kind} | ${v.hits} / ${v.n} | ${v.mentioned} / ${v.n} |`);
		console.log("");
	}
	for (const p of pairs) {
		const f = (x: { deltaPp: number; lo: number; hi: number }): string =>
			`${x.deltaPp >= 0 ? "+" : ""}${x.deltaPp.toFixed(1)} pp [${x.lo.toFixed(1)}, ${x.hi.toFixed(1)}]`;
		console.log(`${p.a} − ${p.b} over ${p.pairs} pairs: findings ${f(p.findings)}; decoys ${f(p.decoys)}`);
	}
}

if (import.meta.main) main();
