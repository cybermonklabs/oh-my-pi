#!/usr/bin/env bun
/**
 * Builds `cases-brief.json`: what each arm of the brief lane may show a
 * reviewer at each scored head, cut from the coordinator's real briefs by the
 * two labellers' spans (`how-found.ts`), never written for the test.
 *
 * The line between pressure and the answer, applied per sentence (no case is
 * dropped; every removal is recorded with its reason):
 *
 *   - Only text the coordinator wrote before the head's round began: the
 *     round's own brief (the arm whose session started first), and for the
 *     loss element the briefs of earlier rounds of the same pull request.
 *   - A span of the round's own brief is removed when EITHER labeller says
 *     it, or the same text in the round's other brief, states any recorded
 *     defect or decoy at the head (pointer `states`).
 *   - Every span and loss sentence still kept is then read by both match
 *     judges against the head's cases (`judge-leak.md`): one says someone
 *     holding it and the diff could write a case's title, and it goes. The
 *     test is the same for an attack list, a fix's claim or a loss.
 *   - Then the frozen patterns of every case at the head are run over each
 *     arm's text; a span that fires one, alone or with its neighbours, goes.
 *   - What is left names the loss, the area, the earlier finding to re-break
 *     and the evidence wanted. Cases that re-open a finding the kept re-break
 *     text names (`judge-reopen.md`) are recorded per head, so a result can
 *     be read with and without them.
 *
 * Arms read:
 *   loss    - every distinct span either labeller calls `loss` in this pull
 *             request's briefs up to and including this round: the
 *             user-visible losses the coordinator had named so far;
 *   rebreak - kept spans of this round's brief either labeller calls `rebreak`;
 *   full    - every kept non-logistics span of this round's brief, in order;
 *   repro   - one text for every head (`prompts/brief-repro.md`), joined
 *             from evidence clauses the briefs repeat; `repro_sources`
 *             counts the briefs carrying each clause.
 *
 * Usage:
 *   bun scripts/reviewer-gap/brief-build.ts --labels <baseDir>,<otherDir> --judgements <dir>
 *        [--cases cases-c.json] [--out cases-brief.json] [--store <briefs dir>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { BRIEF_STORE, type BriefIndex } from "./briefs.ts";
import { type ClaimsCaseFile, asPatterns } from "./claims.ts";
import { type Finding, detects } from "./grade.ts";
import { type LabelFile, type Span, loadLabels } from "./how-found.ts";
import { leakCheck, reopenCheck } from "./judge.ts";
import { readJsonl } from "./rederive.ts";
import type { BriefFile } from "./run.ts";

/** The briefs' own evidence clauses the reproduction text is joined from; the last row of `repro_sources` counts briefs carrying all of them. */
export const REPRO_CLAUSES = [
	"verify by running",
	"with the reproduction you ran and its measured output",
	"judge every gate by its recorded exit code",
];

export interface SpanDecision {
	id: string;
	element: Span["element"];
	/** The other labeller's element for the most of this span's characters, or null where it left them uncovered. */
	other_element: Span["element"] | null;
	kept: boolean;
	/** Why a span is not shown: `states:<id>@<labeller>`, `patterns:<ids>`, `patterns-across-spans:<id>`, or `logistics`. */
	removed_because?: string;
	adapted: string;
}

export interface LossDecision {
	/** The round whose brief the sentence comes from, and that brief's session. */
	from: string;
	agent: string;
	text: string;
	kept: boolean;
	removed_because?: string;
}

export interface HeadBrief {
	source_agent: string;
	loss: string;
	rebreak: string;
	full: string;
	spans: SpanDecision[];
	loss_sentences: LossDecision[];
	/** Cases the judges say re-open a finding the kept re-break text names: case id -> `<span>@<judge>`. */
	reopens: Record<string, string[]>;
	/** How much of each element this head shows, and where its loss sentences came from. */
	composition: {
		loss_this_round: number;
		loss_earlier_rounds: number;
		chars: { loss: number; rebreak: number; full: number; repro: number };
	};
}

export interface BuiltBriefs extends BriefFile {
	rule: string;
	base_labeler: string;
	other_labeler: string;
	repro_sources: { clause: string; briefs: number }[];
	heads: Record<string, HeadBrief>;
}

const DIR = import.meta.dir;

/** Character ranges of a labeller's spans in a brief, located by first occurrence. */
function ranges(text: string, spans: Span[]): { span: Span; start: number; end: number }[] {
	return spans.map(s => {
		const start = text.indexOf(s.text);
		return { span: s, start, end: start + s.text.length };
	});
}

/** The element the other labeller gives most of [start, end), or null where its spans miss it. */
function overlapElement(
	start: number,
	end: number,
	other: { span: Span; start: number; end: number }[],
): Span["element"] | null {
	const by = new Map<Span["element"], number>();
	for (const o of other) {
		const n = Math.min(end, o.end) - Math.max(start, o.start);
		if (n > 0) by.set(o.span.element, (by.get(o.span.element) ?? 0) + n);
	}
	let best: Span["element"] | null = null;
	let most = 0;
	for (const [e, n] of by)
		if (n > most) {
			best = e;
			most = n;
		}
	return best;
}

/** Span ids of one brief that state some case at the head, with the case ids each states. */
function statingSpans(l: LabelFile, agent: string, caseIds: Set<string>): Map<string, string[]> {
	const m = new Map<string, string[]>();
	for (const c of [...l.defects, ...l.decoys]) {
		if (!caseIds.has(c.id)) continue;
		const v = c.by_brief[agent];
		if (v === undefined || !v.pointer.includes("states")) continue;
		for (const s of v.spans) m.set(s, [...(m.get(s) ?? []), c.id]);
	}
	return m;
}

/** Markdown, list numbers and case stripped, for comparing sentences and clauses. */
const plain = (s: string): string =>
	s
		.toLowerCase()
		.replace(/[*_`]/g, "")
		.replace(/^\s*\d+\.\s*/, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

/** The head's pull request or lane: `pr17396` for `pr17396-r5`. */
const laneOf = (head: string): string => head.replace(/-r\d+$/, "");

export async function buildBriefs(
	cases: ClaimsCaseFile & { heads: { id: string }[] },
	base: Map<string, LabelFile>,
	other: Map<string, LabelFile>,
	index: BriefIndex[],
	briefText: (agent: string) => string,
	judgements: string,
): Promise<BuiltBriefs> {
	const baseName = [...base.values()][0]?.labeler ?? "base";
	const otherName = [...other.values()][0]?.labeler ?? "other";
	const started = new Map(index.map(i => [i.agent, i.started_at]));
	const repro = fs.readFileSync(path.join(DIR, "prompts", "brief-repro.md"), "utf8").trim();
	const allBriefs = index.map(i => plain(briefText(i.agent)));
	const repro_sources = [
		...REPRO_CLAUSES.map(clause => ({
			clause,
			briefs: allBriefs.filter(t => t.includes(plain(clause))).length,
		})),
		{
			clause: "(all of the above)",
			briefs: allBriefs.filter(t => REPRO_CLAUSES.every(c => t.includes(plain(c)))).length,
		},
	];

	const heads: Record<string, HeadBrief> = {};
	for (const h of cases.heads) {
		const lb = base.get(h.id);
		const lo = other.get(h.id);
		if (lb === undefined || lo === undefined) throw new Error(`${h.id}: labels missing`);
		const agents = lb.briefs.map(b => b.agent);
		const source = index
			.filter(i => agents.includes(i.agent))
			.sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
		if (source === undefined) throw new Error(`${h.id}: no indexed brief`);
		const text = briefText(source.agent);
		const bspans = lb.briefs.find(b => b.agent === source.agent)?.spans ?? [];
		const ospans = lo.briefs.find(b => b.agent === source.agent)?.spans ?? [];
		const oranges = ranges(text, ospans);
		const caseIds = new Set([
			...cases.findings.filter(f => f.head === h.id).map(f => f.id),
			...cases.decoys.filter(d => d.head === h.id).map(d => d.id),
		]);
		const statesBase = statingSpans(lb, source.agent, caseIds);
		const statesOther = statingSpans(lo, source.agent, caseIds);
		const otherStating = oranges.filter(o => statesOther.has(o.span.id));
		const pats: Finding[] = [
			...cases.findings.filter(f => f.head === h.id),
			...cases.decoys.filter(d => d.head === h.id).map(asPatterns),
		];
		const fires = (t: string): string[] => pats.filter(p => detects(t, p, cases.window_chars)).map(p => p.id);
		// A stating span of the round's other brief removes the same text where the source brief repeats it.
		const otherBriefStating: { start: number; end: number; ids: string[] }[] = [];
		for (const l of [lb, lo])
			for (const b of l.briefs) {
				if (b.agent === source.agent) continue;
				const st = statingSpans(l, b.agent, caseIds);
				for (const s of b.spans) {
					if (!st.has(s.id)) continue;
					const start = text.indexOf(s.text);
					if (start >= 0)
						otherBriefStating.push({
							start,
							end: start + s.text.length,
							ids: (st.get(s.id) ?? []).map(i => `${i}@${l.labeler}:${b.agent}`),
						});
				}
			}
		const decisions: SpanDecision[] = ranges(text, bspans).map(r => {
			const d: SpanDecision = {
				id: r.span.id,
				element: r.span.element,
				other_element: r.start < 0 ? null : overlapElement(r.start, r.end, oranges),
				kept: true,
				adapted: r.span.adapted,
			};
			const overlaps = (o: { start: number; end: number }): boolean =>
				Math.min(r.end, o.end) - Math.max(r.start, o.start) > 0;
			const by = [
				...(statesBase.get(r.span.id) ?? []).map(i => `${i}@${baseName}`),
				...otherStating
					.filter(overlaps)
					.flatMap(o => (statesOther.get(o.span.id) ?? []).map(i => `${i}@${otherName}`)),
				...otherBriefStating.filter(overlaps).flatMap(o => o.ids),
			];
			if (r.span.element === "logistics" || r.span.adapted.trim() === "")
				Object.assign(d, { kept: false, removed_because: "logistics" });
			else if (by.length > 0)
				Object.assign(d, { kept: false, removed_because: `states:${[...new Set(by)].join(",")}` });
			return d;
		});

		// The loss element: every distinct loss span of this pull request's briefs up to this round.
		const seen = new Set<string>();
		const candidates: LossDecision[] = [];
		const rawOf = new Map<LossDecision, string>();
		for (const [head, labels] of [...base.entries(), ...other.entries()]) {
			if (laneOf(head) !== laneOf(h.id)) continue;
			for (const b of labels.briefs) {
				if ((started.get(b.agent) ?? "~") > source.started_at) continue;
				for (const s of b.spans) {
					if (s.element !== "loss" || s.adapted.trim() === "") continue;
					const key = plain(s.adapted);
					if (key === "" || seen.has(key)) continue;
					seen.add(key);
					const c: LossDecision = { from: head, agent: b.agent, text: s.adapted.trim(), kept: true };
					rawOf.set(c, s.text);
					candidates.push(c);
				}
			}
		}
		// A sentence from this round's own briefs was labelled against this
		// head's cases: it goes when it overlaps a span either labeller says
		// states one, exactly as in `full`.
		for (const c of candidates) {
			if (c.from !== h.id) continue;
			const btext = briefText(c.agent);
			const raw = rawOf.get(c) ?? "";
			const start = btext.indexOf(raw);
			if (start < 0) continue;
			const by: string[] = [];
			for (const l of [lb, lo]) {
				const stating = statingSpans(l, c.agent, caseIds);
				const spans = l.briefs.find(b => b.agent === c.agent)?.spans ?? [];
				for (const r of ranges(
					btext,
					spans.filter(s => stating.has(s.id)),
				))
					if (r.start >= 0 && Math.min(start + raw.length, r.end) - Math.max(start, r.start) > 0)
						by.push(...(stating.get(r.span.id) ?? []).map(i => `${i}@${l.labeler}`));
			}
			if (by.length > 0) Object.assign(c, { kept: false, removed_because: `states:${[...new Set(by)].join(",")}` });
		}
		// A sentence contained in a longer kept one adds nothing.
		for (const c of candidates)
			if (
				c.kept &&
				candidates.some(
					o => o !== c && o.kept && o.text.length > c.text.length && plain(o.text).includes(plain(c.text)),
				)
			)
				Object.assign(c, { kept: false, removed_because: "contained in a longer loss sentence" });

		// Every kept sentence of every arm, read by both match judges against this head's cases.
		const liveSpans = decisions.filter(d => d.kept);
		const liveLoss = candidates.filter(c => c.kept);
		const leaks = await leakCheck(
			cases,
			h.id,
			[...liveSpans.map(d => d.adapted.trim()), ...liveLoss.map(c => c.text)],
			judgements,
		);
		[...liveSpans, ...liveLoss].forEach((x, i) => {
			const by = leaks.get(i);
			const fired = fires("adapted" in x ? x.adapted : x.text);
			if (by !== undefined) Object.assign(x, { kept: false, removed_because: `judge:${by.join(",")}` });
			else if (fired.length > 0) Object.assign(x, { kept: false, removed_because: `patterns:${fired.join(",")}` });
		});

		const join = (pick: (d: SpanDecision) => boolean): string =>
			decisions
				.filter(d => d.kept && pick(d))
				.map(d => d.adapted.trim())
				.join("\n\n");
		const isRebreak = (d: SpanDecision): boolean => d.element === "rebreak" || d.other_element === "rebreak";
		// An arm's whole text can fire a pattern no single span fires, across a
		// span boundary. Remove, one at a time, the kept span whose removal stops
		// a fire, else the kept span that matches the most of that pattern's groups.
		for (const pick of [isRebreak, () => true]) {
			for (;;) {
				const p = pats.find(x => detects(join(pick), x, cases.window_chars));
				if (p === undefined) break;
				const kept = decisions.filter(d => d.kept && pick(d));
				const stops = kept.find(d => {
					d.kept = false;
					const still = detects(join(pick), p, cases.window_chars);
					d.kept = true;
					return !still;
				});
				const groupsHit = (d: SpanDecision): number =>
					[...p.mechanism, ...p.trigger].filter(g => g.some(re => new RegExp(re, "i").test(d.adapted))).length;
				const victim = stops ?? kept.sort((a, b) => groupsHit(b) - groupsHit(a))[0];
				if (victim === undefined) throw new Error(`${h.id}: ${p.id} fires with no kept span left`);
				Object.assign(victim, { kept: false, removed_because: `patterns-across-spans:${p.id}` });
			}
		}
		const lossText = (): string =>
			candidates
				.filter(c => c.kept)
				.map(c => `- ${c.text}`)
				.join("\n");
		for (;;) {
			const p = pats.find(x => detects(lossText(), x, cases.window_chars));
			if (p === undefined) break;
			const victim = candidates.filter(c => c.kept).sort((a, b) => b.text.length - a.text.length)[0];
			if (victim === undefined) break;
			Object.assign(victim, { kept: false, removed_because: `patterns-across-spans:${p.id}` });
		}

		// Which cases are the still-open form of a finding the kept re-break text names: the
		// cases where re-breaking is the whole of the pressure, reported apart.
		const rebreakSpans = decisions.filter(d => d.kept && isRebreak(d));
		const reopenBy = await reopenCheck(
			cases,
			h.id,
			rebreakSpans.map(d => d.adapted.trim()),
			judgements,
		);
		const reopens: Record<string, string[]> = {};
		for (const [i, ids] of reopenBy)
			for (const tagged of ids) {
				const id = tagged.split("@")[0] as string;
				reopens[id] = [...new Set([...(reopens[id] ?? []), `${rebreakSpans[i]?.id ?? i}@${tagged.split("@")[1]}`])];
			}
		const keptLoss = candidates.filter(c => c.kept);
		heads[h.id] = {
			source_agent: source.agent,
			loss: lossText(),
			rebreak: join(isRebreak),
			full: join(() => true),
			spans: decisions,
			loss_sentences: candidates,
			reopens,
			composition: {
				loss_this_round: keptLoss.filter(c => c.from === h.id).length,
				loss_earlier_rounds: keptLoss.filter(c => c.from !== h.id).length,
				chars: {
					loss: lossText().length,
					rebreak: join(isRebreak).length,
					full: join(() => true).length,
					repro: repro.length,
				},
			},
		};
	}
	const reproFired = [...cases.findings, ...cases.decoys.map(asPatterns)]
		.filter(p => detects(repro, p, cases.window_chars))
		.map(p => p.id);
	if (reproFired.length > 0) throw new Error(`the shared reproduction text fires ${reproFired.join(",")}`);
	return {
		frozen_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
		rule: "Only coordinator text written before the head's round. A span of the round's first-started brief is removed when either labeller says it, or the same text in the round's other brief, states a recorded defect or decoy at the head; then every kept span and loss sentence is read by both match judges (judge-leak.md: could someone with this sentence and the diff write a case's title) and one flag removes it; then any text a frozen pattern of the head fires on, alone or across spans, is removed. loss = the pull request's distinct loss sentences up to this round (either labeller); rebreak = kept spans either labeller calls rebreak; full = every kept non-logistics span; repro = prompts/brief-repro.md for every head. No case is dropped: the line is drawn per sentence.",
		base_labeler: baseName,
		other_labeler: otherName,
		repro,
		repro_sources,
		heads,
	};
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const [baseDir, otherDir] = (get("--labels") ?? "").split(",");
	const judgements = get("--judgements");
	if (baseDir === undefined || otherDir === undefined || judgements === undefined) {
		console.error(
			"usage: brief-build.ts --labels <baseDir>,<otherDir> --judgements <dir> [--cases cases-c.json] [--out cases-brief.json] [--store <dir>]",
		);
		process.exit(2);
	}
	const cases = JSON.parse(fs.readFileSync(get("--cases") ?? path.join(DIR, "cases-c.json"), "utf8"));
	const index = readJsonl<BriefIndex>(path.join(DIR, "corpus", "briefs.jsonl"));
	const store = get("--store") ?? BRIEF_STORE;
	fs.mkdirSync(judgements, { recursive: true });
	const built = await buildBriefs(
		cases,
		loadLabels(baseDir),
		loadLabels(otherDir),
		index,
		agent => fs.readFileSync(path.join(store, `${agent}.md`), "utf8"),
		judgements,
	);
	const out = get("--out") ?? path.join(DIR, "cases-brief.json");
	fs.writeFileSync(out, `${JSON.stringify(built, null, "\t")}\n`);
	for (const [id, h] of Object.entries(built.heads)) {
		const removed = h.spans.filter(s => s.removed_because !== undefined && s.removed_because !== "logistics").length;
		const lossOut = h.loss_sentences.filter(s => /^(judge|patterns|states)/.test(s.removed_because ?? "")).length;
		console.log(
			`${id}: source ${h.source_agent}; loss ${h.loss.length} rebreak ${h.rebreak.length} full ${h.full.length} chars; ${removed} brief spans and ${lossOut} loss sentences removed as giving a case away`,
		);
	}
	for (const s of built.repro_sources) console.log(`repro clause "${s.clause}": in ${s.briefs} briefs`);
	console.log(`-> ${out}`);
}

if (import.meta.main) await main();
