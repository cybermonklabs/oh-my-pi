#!/usr/bin/env bun
/**
 * "How was it found" for every real defect of the claims corpus, on two axes:
 *
 *   method  - what evidence the defect needed (`how_found_primary` in the
 *             corpus: read-diff ... real-kernel-resource; `corpus/SCHEMA.md`).
 *   pointer - what the round's brief told the finding reviewer about it,
 *             read against the brief that reviewer worked under (`briefs.ts`).
 *
 * Two labellers of different model families label every round independently:
 * each splits every brief of the round into spans of one element each, and
 * for every defect and decoy at the head says which spans point at it and how.
 * This file writes their inputs, checks their outputs and merges them.
 *
 *   inputs  - one bundle per corpus round: its briefs, defects and decoys.
 *   check   - every label file: spans are verbatim, every case is labelled
 *             against every brief, every enum holds, adaptations only delete.
 *   merge   - per defect, both labellers' pointers per finding arm, their
 *             agreement, and the merged label; written to `corpus/how-found.jsonl`.
 *   index   - every defect and decoy with its diff, title and how it was
 *             found; written to `corpus/cases-index.jsonl`.
 *
 * Usage:
 *   bun scripts/reviewer-gap/how-found.ts inputs --out <dir>
 *   bun scripts/reviewer-gap/how-found.ts check --labels <dir>
 *   bun scripts/reviewer-gap/how-found.ts merge --labels <dirA>,<dirB>
 *   bun scripts/reviewer-gap/how-found.ts index
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BRIEF_STORE, type BriefIndex } from "./briefs.ts";
import { type CorpusRound, UPSTREAM_MAIN, git, headId, loadClaimsCorpus } from "./claims-build.ts";
import { readJsonl } from "./rederive.ts";

export const ELEMENTS = ["loss", "rebreak", "reproduction", "attack", "change", "logistics"] as const;
export type Element = (typeof ELEMENTS)[number];

/** Strongest first: the merged primary pointer is the first of these any label carries. */
export const POINTERS = ["states", "area", "rebreak", "loss"] as const;
export type Pointer = (typeof POINTERS)[number];

export interface Span {
	id: string;
	element: Element;
	/** A contiguous verbatim substring of the brief. */
	text: string;
	/**
	 * The span as another reviewer on another tree can use it: `text` with
	 * paths, agent names and links deleted, and "your" (the original
	 * reviewer's own earlier work) read as "the earlier round's". Empty for
	 * logistics.
	 */
	adapted: string;
}

export interface CaseLabel {
	id: string;
	/** Keyed by brief agent: the pointers that brief's spans carry for this case, empty for none. */
	by_brief: Record<string, { pointer: Pointer[]; spans: string[]; why: string }>;
}

export interface LabelFile {
	head: string;
	labeler: string;
	briefs: { agent: string; sha256: string; spans: Span[] }[];
	defects: CaseLabel[];
	decoys: CaseLabel[];
}

export interface Bundle {
	head: string;
	pr: number | null;
	round: number;
	head_sha: string;
	subject_hint: string;
	briefs: { agent: string; arm: string; model: string; started_at: string; sha256: string; text: string }[];
	defects: {
		id: string;
		title: string;
		mechanism_summary?: string;
		found_by: Record<string, string>;
		finder_sections: { arm: string; text: string }[];
	}[];
	decoys: { id: string; title: string; claimed_by: { arm: string; text: string }[] }[];
}

const DIR = import.meta.dir;

function briefIndex(): Map<string, BriefIndex> {
	return new Map(readJsonl<BriefIndex>(path.join(DIR, "corpus", "briefs.jsonl")).map(b => [b.agent, b]));
}

export function bundles(store = BRIEF_STORE): Bundle[] {
	const corpus = loadClaimsCorpus(path.join(DIR, "corpus", "claims"));
	const index = briefIndex();
	return corpus.rounds.map((r: CorpusRound) => {
		const id = headId(r);
		return {
			head: id,
			pr: r.pr,
			round: r.round,
			head_sha: r.head_sha,
			subject_hint: (r as CorpusRound & { note?: string }).note?.slice(0, 400) ?? "",
			briefs: r.arms.map(a => {
				const ix = index.get(a.agent);
				if (ix === undefined) throw new Error(`${id}: no brief indexed for ${a.agent}; run briefs.ts extract`);
				return {
					agent: a.agent,
					arm: a.arm,
					model: ix.model,
					started_at: ix.started_at,
					sha256: ix.sha256,
					text: fs.readFileSync(path.join(store, `${a.agent}.md`), "utf8"),
				};
			}),
			defects: corpus.defects
				.filter(d => headId(d) === id)
				.map(d => ({
					id: d.id,
					title: d.title,
					mechanism_summary: d.mechanism_summary,
					found_by: d.found_by,
					finder_sections: d.finder_sections.map(s => ({ arm: s.arm, text: s.text })),
				})),
			decoys: corpus.decoys
				.filter(d => headId(d) === id)
				.map(d => ({
					id: d.id,
					title: d.claim_title,
					claimed_by: d.claimed_by.map(s => ({ arm: s.arm, text: s.text })),
				})),
		};
	});
}

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Words `adapted` may hold that `text` does not: the one substitution the rule allows. */
const ALLOWED_NEW: Record<string, true> = { the: true, earlier: true, round: true, s: true };
/** Share of a brief's letters and digits its spans may leave uncovered: headings and stray punctuation, never a sentence. */
const MAX_UNCOVERED = 0.02;

/** Every way a label file breaks the labelling rule; empty when it holds. */
export function checkLabels(bundle: Bundle, labels: LabelFile): string[] {
	const out: string[] = [];
	const briefs = new Map(bundle.briefs.map(b => [b.agent, b]));
	for (const b of labels.briefs) {
		const src = briefs.get(b.agent);
		if (src === undefined) {
			out.push(`unknown brief ${b.agent}`);
			continue;
		}
		if (b.sha256 !== src.sha256) out.push(`${b.agent}: sha256 differs from the brief labelled`);
		const ids = new Set<string>();
		for (const s of b.spans) {
			if (ids.has(s.id)) out.push(`${b.agent}/${s.id}: duplicate span id`);
			ids.add(s.id);
			if (!(ELEMENTS as readonly string[]).includes(s.element)) out.push(`${b.agent}/${s.id}: element ${s.element}`);
			if (!src.text.includes(s.text)) out.push(`${b.agent}/${s.id}: text is not a verbatim substring`);
			if (s.element === "logistics") continue;
			const have = new Set(words(s.text));
			const added = words(s.adapted).filter(w => !have.has(w) && !ALLOWED_NEW[w]);
			if (added.length > 0) out.push(`${b.agent}/${s.id}: adapted adds ${[...new Set(added)].join(", ")}`);
		}
		// Every sentence belongs to a span: count the brief's letters and digits no span covers.
		const covered = new Uint8Array(src.text.length);
		for (const s of b.spans) {
			const at = src.text.indexOf(s.text);
			if (at >= 0) covered.fill(1, at, at + s.text.length);
		}
		let wordChars = 0;
		let missed = 0;
		for (let i = 0; i < src.text.length; i++) {
			if (!/[A-Za-z0-9]/.test(src.text[i] as string)) continue;
			wordChars++;
			if (covered[i] === 0) missed++;
		}
		if (wordChars > 0 && missed / wordChars > MAX_UNCOVERED)
			out.push(
				`${b.agent}: spans leave ${((100 * missed) / wordChars).toFixed(1)}% of the brief's letters and digits uncovered`,
			);
	}
	for (const agent of briefs.keys())
		if (!labels.briefs.some(b => b.agent === agent)) out.push(`brief ${agent} not segmented`);
	const spanIds = new Map(labels.briefs.map(b => [b.agent, new Set(b.spans.map(s => s.id))]));
	const checkCases = (kind: string, want: string[], got: CaseLabel[]): void => {
		for (const id of want) {
			const l = got.find(g => g.id === id);
			if (l === undefined) {
				out.push(`${kind} ${id} not labelled`);
				continue;
			}
			for (const agent of briefs.keys()) {
				const v = l.by_brief[agent];
				if (v === undefined) {
					out.push(`${id}: no label against ${agent}`);
					continue;
				}
				for (const p of v.pointer)
					if (!(POINTERS as readonly string[]).includes(p)) out.push(`${id}/${agent}: pointer ${p}`);
				for (const s of v.spans) if (!spanIds.get(agent)?.has(s)) out.push(`${id}/${agent}: unknown span ${s}`);
				if (v.pointer.length > 0 && v.spans.length === 0) out.push(`${id}/${agent}: a pointer names no span`);
			}
		}
	};
	checkCases(
		"defect",
		bundle.defects.map(d => d.id),
		labels.defects,
	);
	checkCases(
		"decoy",
		bundle.decoys.map(d => d.id),
		labels.decoys,
	);
	return out;
}

/** The strongest pointer in a set, or "none". */
export function primary(pointers: Iterable<Pointer>): Pointer | "none" {
	const set = new Set(pointers);
	return POINTERS.find(p => set.has(p)) ?? "none";
}

export interface HowFound {
	id: string;
	head: string;
	method: string;
	/** Arms that found it, from the corpus. */
	finders: string[];
	/** Per labeller: the strongest pointer across the finding arms' briefs. */
	labels: Record<string, Pointer | "none">;
	/** Both labellers' pointers pooled over the finding arms' briefs, strongest first. */
	pointer: Pointer | "none";
	agree: boolean;
}

export function loadLabels(dir: string): Map<string, LabelFile> {
	const m = new Map<string, LabelFile>();
	for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
		const l = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as LabelFile;
		m.set(l.head, l);
	}
	return m;
}

/**
 * Merge two labellers. The merged pointer is the strongest either labeller
 * gives against a finding arm's brief: a pointer only one of them saw is kept,
 * so "the brief did not point at it" is never claimed past a labeller who
 * read it as pointing.
 */
export function merge(bs: Bundle[], a: Map<string, LabelFile>, b: Map<string, LabelFile>): HowFound[] {
	const corpus = loadClaimsCorpus(path.join(DIR, "corpus", "claims"));
	const out: HowFound[] = [];
	for (const bundle of bs) {
		const la = a.get(bundle.head);
		const lb = b.get(bundle.head);
		if (la === undefined || lb === undefined) throw new Error(`${bundle.head}: missing labels`);
		for (const d of bundle.defects) {
			const finders = Object.entries(d.found_by)
				.filter(([, v]) => v === "found")
				.map(([k]) => k);
			const agents = bundle.briefs.filter(x => finders.includes(x.arm)).map(x => x.agent);
			const pick = (l: LabelFile): Pointer[] =>
				agents.flatMap(ag => l.defects.find(x => x.id === d.id)?.by_brief[ag]?.pointer ?? []);
			const pa = primary(pick(la));
			const pb = primary(pick(lb));
			out.push({
				id: d.id,
				head: bundle.head,
				method: corpus.defects.find(x => x.id === d.id)?.how_found_primary ?? "",
				finders,
				labels: { [la.labeler]: pa, [lb.labeler]: pb },
				pointer: primary([...pick(la), ...pick(lb)]),
				agree: pa === pb,
			});
		}
	}
	return out;
}

/** Cohen's kappa of two labellers' primary pointers over the same defects. */
export function kappa(rows: HowFound[]): number {
	const names = [...new Set(rows.flatMap(r => Object.keys(r.labels)))];
	if (names.length !== 2 || rows.length === 0) return Number.NaN;
	const [a, b] = names as [string, string];
	const cats = ["none", ...POINTERS];
	const n = rows.length;
	const po = rows.filter(r => r.labels[a] === r.labels[b]).length / n;
	const pe = cats.reduce(
		(s, c) => s + (rows.filter(r => r.labels[a] === c).length / n) * (rows.filter(r => r.labels[b] === c).length / n),
		0,
	);
	return (po - pe) / (1 - pe);
}

/** Markdown cross-tables of the merged labels: pointer by method, pointer by finding arm. */
export function summary(rows: HowFound[]): string {
	const found = rows.filter(r => r.finders.length > 0);
	const pointers = [...POINTERS, "none"] as const;
	const methods = [...new Set(found.map(r => r.method))].sort();
	const lines = [
		`${rows.length} defects; ${found.length} found in the round they are recorded at (the rest were found later, at that head, and have no finding brief).`,
		`Labellers agree on the primary pointer for ${found.filter(r => r.agree).length} of ${found.length}; Cohen's kappa ${kappa(found).toFixed(2)}.`,
		"",
		`| pointer (merged) | ${methods.join(" | ")} | all |`,
		`|---|${methods.map(() => "---").join("|")}|---|`,
	];
	for (const p of pointers) {
		const mine = found.filter(r => r.pointer === p);
		lines.push(
			`| ${p} | ${methods.map(m => mine.filter(r => r.method === m).length).join(" | ")} | ${mine.length} |`,
		);
	}
	lines.push(`| all | ${methods.map(m => found.filter(r => r.method === m).length).join(" | ")} | ${found.length} |`);
	lines.push("", "| pointer (merged) | found by astra only | by claude only | by both |", "|---|---|---|---|");
	for (const p of pointers) {
		const mine = found.filter(r => r.pointer === p);
		const only = (arm: string): number => mine.filter(r => r.finders.length === 1 && r.finders[0] === arm).length;
		lines.push(
			`| ${p} | ${only("astra")} | ${only("claude")} | ${mine.filter(r => r.finders.length === 2).length} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

/** One line of `corpus/cases-index.jsonl`: every case with the diff it sits on, what it is, and how it was found. */
export interface CaseIndex {
	id: string;
	kind: "defect" | "decoy";
	head: string;
	head_sha: string;
	base_sha: string;
	/** The diff under review: `git diff <base_sha>..<head_sha>` in this repository. */
	diff: string;
	title: string;
	how_found:
		| { method: string; pointer: string; pointer_by_labeller: Record<string, string>; finders: string[] }
		| { decoy_class: string; refuted_by: string };
}

/**
 * The corpus as the requester reads it: each recorded defect and decoy with
 * its diff (the round's recorded base, else the head's merge base with
 * upstream main), its title, and how it was found (method and pointer for a
 * defect from `corpus/how-found.jsonl`; for a decoy, its class and what
 * refuted it).
 */
export function casesIndex(): CaseIndex[] {
	const corpus = loadClaimsCorpus(path.join(DIR, "corpus", "claims"));
	const found = new Map(readJsonl<HowFound>(path.join(DIR, "corpus", "how-found.jsonl")).map(r => [r.id, r]));
	const base = new Map<string, string>();
	for (const r of corpus.rounds) base.set(headId(r), r.base_sha ?? git("merge-base", r.head_sha, UPSTREAM_MAIN));
	const diff = (head: string, sha: string): { base_sha: string; diff: string } => {
		const b = base.get(head) ?? "";
		return { base_sha: b, diff: `git diff ${b.slice(0, 12)}..${sha.slice(0, 12)}` };
	};
	return [
		...corpus.defects.map((d): CaseIndex => {
			const h = found.get(d.id);
			return {
				id: d.id,
				kind: "defect",
				head: headId(d),
				head_sha: d.head_sha,
				...diff(headId(d), d.head_sha),
				title: d.title,
				how_found: {
					method: d.how_found_primary,
					pointer: h?.pointer ?? "unlabelled",
					pointer_by_labeller: h?.labels ?? {},
					finders: h?.finders ?? [],
				},
			};
		}),
		...corpus.decoys.map((d): CaseIndex => ({
			id: d.id,
			kind: "decoy",
			head: headId(d),
			head_sha: d.head_sha,
			...diff(headId(d), d.head_sha),
			title: d.claim_title,
			how_found: { decoy_class: d.decoy_class, refuted_by: d.refuted_by.kind },
		})),
	];
}

function main(): void {
	const [mode, ...argv] = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (mode === "inputs") {
		const out = get("--out");
		if (out === undefined) throw new Error("--out <dir>");
		fs.mkdirSync(out, { recursive: true });
		const bs = bundles();
		for (const b of bs) fs.writeFileSync(path.join(out, `${b.head}.json`), `${JSON.stringify(b, null, "\t")}\n`);
		console.log(
			`${bs.length} bundles, ${bs.reduce((n, b) => n + b.defects.length, 0)} defects, ${bs.reduce((n, b) => n + b.decoys.length, 0)} decoys -> ${out}`,
		);
		return;
	}
	if (mode === "check") {
		const dir = get("--labels");
		if (dir === undefined) throw new Error("--labels <dir>");
		const bs = new Map(bundles().map(b => [b.head, b]));
		const labels = loadLabels(dir);
		let bad = 0;
		for (const head of bs.keys()) {
			const l = labels.get(head);
			const problems = l === undefined ? ["no label file"] : checkLabels(bs.get(head) as Bundle, l);
			if (problems.length > 0) {
				bad++;
				for (const p of problems) console.log(`${head}: ${p}`);
			}
		}
		console.log(`${bs.size - bad} of ${bs.size} heads pass`);
		process.exit(bad === 0 ? 0 : 1);
	}
	if (mode === "merge") {
		const dirs = (get("--labels") ?? "").split(",");
		if (dirs.length !== 2) throw new Error("--labels <dirA>,<dirB>");
		const rows = merge(bundles(), loadLabels(dirs[0] as string), loadLabels(dirs[1] as string));
		fs.writeFileSync(path.join(DIR, "corpus", "how-found.jsonl"), `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
		console.log(summary(rows));
		return;
	}
	if (mode === "index") {
		const rows = casesIndex();
		fs.writeFileSync(
			path.join(DIR, "corpus", "cases-index.jsonl"),
			`${rows.map(r => JSON.stringify(r)).join("\n")}\n`,
		);
		console.log(`${rows.length} cases -> corpus/cases-index.jsonl`);
		return;
	}
	console.error("usage: how-found.ts inputs --out <dir> | check --labels <dir> | merge --labels <a>,<b> | index");
	process.exit(2);
}

if (import.meta.main) main();
