#!/usr/bin/env bun
/**
 * Builds the claims lane's frozen cases from `corpus/claims/`, and the trees a
 * run needs, so the case file is a function of the corpus and a written rule.
 *
 *   cases  - selects heads by the rule in `SELECTION`, maps every corpus
 *            record at a selected head to a finding or a decoy, and writes
 *            `cases-c.json`. Reads git (merge bases, lockfile and Rust trees),
 *            never writes to it.
 *   setup  - for every head of `cases-c.json`: the read-only snapshot and
 *            patch (`snapshot.ts build` against the donor whose lockfile and
 *            Rust tree the head shares), and the read-only copy of the previous
 *            review round's reports and probes the run prompt points at.
 *
 * Usage:
 *   bun scripts/reviewer-gap/claims-build.ts cases [--out cases-c.json]
 *   bun scripts/reviewer-gap/claims-build.ts setup [--cases cases-c.json]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ClaimFinding, type ClaimsCaseFile, type Decoy, type DecoyClass, asPatterns } from "./claims.ts";
import { type Finding, type HeadCase, detects } from "./grade.ts";
import { readJsonl } from "./rederive.ts";
import { build } from "./snapshot.ts";

export const REPO = "/home/sami/src/oh-my-pi";
export const UPSTREAM_MAIN = "upstream/main";
/** Snapshots, patches and earlier-round copies live here, outside any temporary tree. */
const ROOT = "/mnt/nvme/sami/reviewer-gap-evals";
/** The batch's review-round directories, which `setup` copies the earlier round from. */
const BATCH = "/mnt/nvme/tmp-omp-batch";

/**
 * One donor per (bun.lock blob, crates tree). A head is usable only when a
 * donor's source tree shares both: the same dependencies, and the same Rust
 * the native addon is meant to come from, since no reviewer can build Rust
 * here. The batch's exports reused one addon binary across Rust trees, so the
 * crates match narrows the risk; it does not prove the binary's origin.
 */
export const DONORS = [
	{ lock: "ad3b2401", crates: "8cd4b931", dir: `${ROOT}/donor-ad3b2401`, from: "17396 export at 85917d21" },
	{ lock: "42c163d3", crates: "7bb64222", dir: `${ROOT}/donor-42c163d3`, from: "17402 export at ca8db136" },
];

/**
 * The subject line the run prompt shows. Pull requests: their GitHub title.
 * Lanes with no pull request: their branch's first commit, plus what the
 * branch adds where that commit does not say it.
 */
export const SUBJECTS: Record<string, string> = {
	"17394": "fix(eval): end the Python runner and JavaScript worker a session leaves behind",
	"17396": "fix(coding-agent): hold the fallback chain for a wire failure no retry layer has replayed",
	"17402": "fix(session): settle what an aside promises across a transition and a bailed prompt",
	"17421": "fix(session): resume a session another live process owns as a fork",
	"17457": "fix(coding-agent): stop work scheduled before disposal from running inside it",
	"17488": "feat(gc): make an archived session readable again — gc --restore and gc --reclaim",
	"gc-quarantine":
		"fix(coding-agent): keep an archived session resumable and its rows intact; gc --quarantine for what a killed archive left staged",
	"ai-replay-budget": "feat(ai): let a caller bound the requests one streaming call spends retrying",
};

export const SELECTION = [
	"A head is selected when any of these holds:",
	"(a) both arms (openai/gpt-6-astra and a Claude model) reviewed it and reported, at least one defect is recorded at it, and no defect at it labels either arm not-run;",
	"(b) a reviewer asserted a decoy at it, rather than raising and withdrawing it in the same report;",
	"(c) a defect at it was missed by every arm that reviewed it (found later and measured on this head).",
	"A selected head is kept only when a donor shares its bun.lock blob and its crates tree.",
	"A decoy refuted only by a deliberate change counts only as an obsolete assertion: a behaviour the author kept on purpose and a reviewer still calls a defect is a disagreement, not a decoy.",
].join(" ");

interface Arm {
	arm: "astra" | "claude";
	agent: string;
	model: string;
	report_path: string;
}

export interface CorpusRound {
	kind: "round";
	pr: number | null;
	lane?: string;
	round: number;
	head_sha: string;
	arms: Arm[];
}

export interface CorpusDefect {
	kind: "defect";
	id: string;
	pr: number | null;
	lane?: string;
	round: number;
	head_sha: string;
	title: string;
	severity: string;
	how_found_primary: string;
	/** The extractor's one-sentence statement of the defect; absent on a few early records. */
	mechanism_summary?: string;
	found_by: ClaimFinding["found_by"];
	finder_sections: { arm: string; report_path: string; lines: string; text: string }[];
	mechanism: string[][];
	trigger: string[][];
}

export interface CorpusDecoy {
	kind: "decoy";
	id: string;
	pr: number | null;
	lane?: string;
	round: number;
	head_sha: string;
	claim_title: string;
	claimed_by: { arm: string; report_path: string; lines: string; text: string }[];
	decoy_class: DecoyClass;
	refuted_by: { kind: string; quote: string; source: string };
	asserted_as?: string;
	mechanism: string[][];
	trigger: string[][];
}

export type CorpusRecord = CorpusRound | CorpusDefect | CorpusDecoy;

/**
 * Overrides a review of the corpus made, each with its reason, in
 * `corpus/claims/adjudication.json`; the extracted records stay as written.
 */
export interface Adjudication {
	origin: Record<string, { origin: "asserted" | "withdrawn"; because: string }>;
	deliberate: Record<string, { because: string }>;
}

export interface ClaimsCorpus {
	rounds: CorpusRound[];
	defects: CorpusDefect[];
	decoys: CorpusDecoy[];
	adjudication: Adjudication;
}

export function loadClaimsCorpus(dir: string): ClaimsCorpus {
	const all = fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".jsonl"))
		.sort()
		.flatMap(f => readJsonl<CorpusRecord>(path.join(dir, f)));
	const adjPath = path.join(dir, "adjudication.json");
	const adjudication = fs.existsSync(adjPath)
		? (JSON.parse(fs.readFileSync(adjPath, "utf8")) as Adjudication)
		: { origin: {}, deliberate: {} };
	return {
		rounds: all.filter((r): r is CorpusRound => r.kind === "round"),
		defects: all.filter((r): r is CorpusDefect => r.kind === "defect"),
		decoys: all.filter((r): r is CorpusDecoy => r.kind === "decoy"),
		adjudication,
	};
}

/** `pr17402-r53`, or `gc-quarantine-r3` for a lane with no pull request number. */
export function headId(r: { pr: number | null; lane?: string; round: number }): string {
	return r.pr === null ? `${r.lane}-r${r.round}` : `pr${r.pr}-r${r.round}`;
}

/** Whether the original reviewer put the decoy forward as a defect, or raised it and withdrew it. */
export function decoyOrigin(d: CorpusDecoy, adj: Adjudication): "asserted" | "withdrawn" {
	const override = adj.origin[d.id];
	if (override !== undefined) return override.origin;
	return d.refuted_by.kind === "self-withdrawn" || d.asserted_as === "mentioned-and-discounted"
		? "withdrawn"
		: "asserted";
}

/** A decoy refuted only by the author's deliberate choice is a disagreement, unless it is an obsolete assertion. */
export function decoyEligible(d: CorpusDecoy, adj: Adjudication): boolean {
	const deliberate = d.refuted_by.kind === "deliberate-change" || adj.deliberate[d.id] !== undefined;
	return !deliberate || d.decoy_class === "obsolete-assertion";
}

type Groups = Pick<Finding, "mechanism" | "trigger">;

/**
 * `detects` anchors its window on the hits of the first group, so a record
 * whose groups all match its own text inside 1200 characters can still miss
 * when the first group's hits sit at the text's edge. The extractors checked
 * "every group inside some window"; the frozen grader checks "inside a window
 * centred on a first-group hit". This moves to the front the first group that
 * anchors a window on every source text of the record (mechanism groups, then
 * trigger groups), and otherwise keeps the record's order. Groups are never
 * added, dropped or edited, so a report must still contain the same phrases;
 * only the hit the 1200-character window is centred on moves.
 */
export function anchored(r: Groups, sources: string[]): Groups {
	const fires = (g: Groups): boolean =>
		sources.every(t => detects(t, { id: "", head: "", severity: "", how_found_primary: "", title: "", ...g }, 1200));
	const asGiven: Groups = { mechanism: r.mechanism, trigger: r.trigger };
	if (fires(asGiven)) return asGiven;
	const candidates: Groups[] = [
		...r.mechanism.slice(1).map((g, i) => ({
			mechanism: [g, ...r.mechanism.filter((_, j) => j !== i + 1)],
			trigger: r.trigger,
		})),
		...r.trigger.map((g, i) => ({
			mechanism: [g, ...r.mechanism],
			trigger: r.trigger.filter((_, j) => j !== i),
		})),
	];
	return candidates.find(fires) ?? asGiven;
}

export function git(...args: string[]): string {
	const r = spawnSync("git", ["-C", REPO, ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

export interface Selection {
	selected: { id: string; reasons: string[]; donor: string }[];
	excluded: { id: string; reasons: string[]; why: string }[];
}

export function selectHeads(corpus: ClaimsCorpus, tree: (sha: string) => { lock: string; crates: string }): Selection {
	const out: Selection = { selected: [], excluded: [] };
	for (const r of corpus.rounds) {
		const id = headId(r);
		const defects = corpus.defects.filter(d => headId(d) === id);
		const decoys = corpus.decoys.filter(d => headId(d) === id && decoyEligible(d, corpus.adjudication));
		const reasons: string[] = [];
		const bothArms = ["astra", "claude"].every(a => r.arms.some(x => x.arm === a));
		const noNotRun = defects.every(d => d.found_by.astra !== "not-run" && d.found_by.claude !== "not-run");
		if (bothArms && noNotRun && defects.length > 0) reasons.push("a");
		if (decoys.some(d => decoyOrigin(d, corpus.adjudication) === "asserted")) reasons.push("b");
		if (defects.some(d => d.found_by.astra !== "found" && d.found_by.claude !== "found")) reasons.push("c");
		if (reasons.length === 0) continue;
		const t = tree(r.head_sha);
		const donor = DONORS.find(d => d.lock === t.lock && d.crates === t.crates);
		if (donor === undefined)
			out.excluded.push({ id, reasons, why: `no donor shares bun.lock ${t.lock} and crates ${t.crates}` });
		else out.selected.push({ id, reasons, donor: donor.dir });
	}
	return out;
}

/** The earlier round of the same pull request in the corpus, if any. */
export function priorRound(corpus: ClaimsCorpus, r: CorpusRound): CorpusRound | undefined {
	return corpus.rounds
		.filter(x => x.pr === r.pr && x.lane === r.lane && x.round < r.round)
		.sort((a, b) => b.round - a.round)[0];
}

/** The written `cases-c.json`: the case file plus the rule and what it selected and excluded. */
export interface BuiltCases extends ClaimsCaseFile {
	selection: string;
	selected: Selection;
	heads: (HeadCase & { prior: string | null; prior_round: number | null })[];
	decoys: (Decoy & { origin: "asserted" | "withdrawn" })[];
}

function buildCases(corpusDir: string): BuiltCases {
	const corpus = loadClaimsCorpus(corpusDir);
	const tree = (sha: string): { lock: string; crates: string } => ({
		lock: git("rev-parse", `${sha}:bun.lock`).slice(0, 8),
		crates: git("rev-parse", `${sha}:crates`).slice(0, 8),
	});
	const selection = selectHeads(corpus, tree);
	const ids = new Set(selection.selected.map(s => s.id));
	const heads: (HeadCase & { prior: string | null; prior_round: number | null })[] = [];
	for (const r of corpus.rounds) {
		const id = headId(r);
		if (!ids.has(id)) continue;
		const base = git("merge-base", r.head_sha, UPSTREAM_MAIN);
		const packages = [
			...new Set(
				git("diff", "--name-only", `${base}..${r.head_sha}`)
					.split("\n")
					.map(f => f.split("/").slice(0, 2).join("/"))
					.filter(p => p.startsWith("packages/")),
			),
		].sort();
		const prior = priorRound(corpus, r);
		heads.push({
			id,
			pr: r.pr ?? 0,
			round: r.round,
			head_sha: r.head_sha,
			base_sha: base,
			checkout: `${ROOT}/heads/${r.head_sha}`,
			diff: `${ROOT}/diffs/${r.head_sha}.diff`,
			subject: SUBJECTS[String(r.pr ?? r.lane)] ?? "",
			packages,
			prior: prior === undefined ? null : `${ROOT}/prior/${id}`,
			prior_round: prior?.round ?? null,
		});
	}
	const findings: ClaimFinding[] = corpus.defects
		.filter(d => ids.has(headId(d)))
		.map(d => ({
			id: d.id,
			head: headId(d),
			severity: d.severity,
			how_found_primary: d.how_found_primary,
			title: d.title,
			...anchored(
				d,
				d.finder_sections.map(s => s.text),
			),
			found_by: d.found_by,
		}));
	const decoys: (Decoy & { origin: "asserted" | "withdrawn" })[] = corpus.decoys
		.filter(d => ids.has(headId(d)) && decoyEligible(d, corpus.adjudication))
		.map(d => ({
			id: d.id,
			head: headId(d),
			title: d.claim_title,
			decoy_class: d.decoy_class,
			refuted_by: d.refuted_by.kind,
			origin: decoyOrigin(d, corpus.adjudication),
			...anchored(
				d,
				d.claimed_by.map(s => s.text),
			),
		}));
	return {
		frozen_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		window_chars: 1200,
		report_format: "claims",
		selection: SELECTION,
		selected: selection,
		heads,
		findings,
		decoys,
	};
}

const COPY_EXT = /\.(md|ts|mts|js|mjs|cjs|py|sh|json|jsonl|log|txt|tsv|patch|diff|out|err|stdout|stderr)$/;
const SKIP_DIR: Record<string, true> = {
	node_modules: true,
	".bun": true,
	".git": true,
	hm: true,
	".omp": true,
	".cache": true,
	"bun-cache": true,
};
const MAX_FILE = 1 << 20;
const MAX_DEPTH = 3;

/**
 * Regular files a reviewer of the earlier round left: reports, probes, logs.
 * Never a link, a dependency tree or a copied checkout; at most three levels
 * deep and one MiB a file, so a round that copied whole trees stays small.
 */
export function copyRoundFiles(from: string, to: string, depth = 0): number {
	let n = 0;
	for (const e of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, e.name);
		if (e.isDirectory()) {
			if (depth + 1 >= MAX_DEPTH || SKIP_DIR[e.name] || e.name.startsWith("export") || e.name.includes("session-"))
				continue;
			n += copyRoundFiles(src, path.join(to, e.name), depth + 1);
		} else if (e.isFile() && COPY_EXT.test(e.name) && fs.statSync(src).size <= MAX_FILE) {
			fs.mkdirSync(to, { recursive: true });
			fs.copyFileSync(src, path.join(to, e.name));
			n++;
		}
	}
	return n;
}

/** The batch directory a report lives in, e.g. `<batch>/17488-review-r21` for `<batch>/17488-review-r21/astra/report.md`. */
export function roundDirOf(reportPath: string): string | undefined {
	if (!reportPath.startsWith(`${BATCH}/`)) return undefined;
	const first = reportPath.slice(BATCH.length + 1).split("/")[0];
	return first === undefined || !reportPath.slice(BATCH.length + 1).includes("/")
		? undefined
		: path.join(BATCH, first);
}

function setup(casesPath: string, corpusDir: string): void {
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as BuiltCases;
	const corpus = loadClaimsCorpus(corpusDir);
	for (const head of cases.heads) {
		const donor = cases.selected.selected.find(s => s.id === head.id)?.donor;
		if (donor === undefined) throw new Error(`${head.id}: no donor recorded`);
		if (!fs.existsSync(head.checkout)) build(REPO, head.head_sha, head.base_sha, ROOT, donor);
		if (head.prior === null || fs.existsSync(head.prior)) continue;
		const r = corpus.rounds.find(x => headId(x) === head.id);
		const prior = r === undefined ? undefined : priorRound(corpus, r);
		if (prior === undefined) throw new Error(`${head.id}: prior round vanished from the corpus`);
		let files = 0;
		for (const arm of prior.arms) {
			const dest = path.join(head.prior, arm.arm);
			fs.mkdirSync(dest, { recursive: true });
			if (fs.existsSync(arm.report_path) && fs.statSync(arm.report_path).isFile()) {
				fs.copyFileSync(arm.report_path, path.join(dest, `REPORT-${path.basename(arm.report_path)}`));
				files++;
			}
			// A report of record that is an agent's final output, not a file in the
			// batch, still left its probes in the batch's directory for that round.
			const dir =
				roundDirOf(arm.report_path) ??
				(prior.pr === null
					? undefined
					: path.join(BATCH, `${prior.pr}-${arm.arm === "astra" ? "review" : "claude"}-r${prior.round}`));
			if (dir !== undefined && fs.existsSync(dir)) files += copyRoundFiles(dir, path.join(dest, path.basename(dir)));
		}
		spawnSync("chmod", ["-R", "a-w", head.prior]);
		console.log(`${head.id}: prior round ${prior.round}, ${files} files`);
	}
	cases.prior_overlap = priorOverlap(cases);
	fs.writeFileSync(casesPath, `${JSON.stringify(cases, null, "\t")}\n`);
	console.log(`${cases.prior_overlap.length} cases whose patterns already fire on their head's earlier-round copy`);
}

/**
 * Case ids whose patterns fire on a file of the earlier round their run is
 * pointed at: a defect the earlier round already described and the review at
 * this head found still open, or a decoy the earlier round already carried. A
 * reviewer can claim those by repeating the earlier report, so the score is
 * also reported without them.
 */
export function priorOverlap(cases: BuiltCases): string[] {
	const walk = (d: string): string[] =>
		fs
			.readdirSync(d, { withFileTypes: true })
			.flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
	const out: string[] = [];
	for (const h of cases.heads) {
		if (h.prior === null) continue;
		const texts = walk(h.prior).map(f => fs.readFileSync(f, "utf8"));
		const pats = [
			...cases.findings.filter(f => f.head === h.id),
			...cases.decoys.filter(d => d.head === h.id).map(asPatterns),
		];
		for (const p of pats) if (texts.some(t => detects(t, p, cases.window_chars))) out.push(p.id);
	}
	return out.sort();
}

function main(): void {
	const [mode, ...argv] = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const corpusDir = path.join(import.meta.dir, "corpus", "claims");
	const casesPath = get("--cases") ?? get("--out") ?? path.join(import.meta.dir, "cases-c.json");
	if (mode === "cases") {
		const cases = buildCases(corpusDir);
		fs.writeFileSync(casesPath, `${JSON.stringify(cases, null, "\t")}\n`);
		console.log(
			`${cases.heads.length} heads, ${cases.findings.length} findings, ${cases.decoys.length} decoys; excluded ${cases.selected.excluded.length}`,
		);
		for (const e of cases.selected.excluded) console.log(`  excluded ${e.id} (${e.reasons.join(",")}): ${e.why}`);
		return;
	}
	if (mode === "setup") return setup(casesPath, corpusDir);
	console.error("usage: claims-build.ts cases [--out cases-c.json] | setup [--cases cases-c.json]");
	process.exit(2);
}

if (import.meta.main) main();
