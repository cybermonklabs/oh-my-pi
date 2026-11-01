#!/usr/bin/env bun
/**
 * The model judgements the brief lane's scoring reads (`brief-lane.ts`). The
 * frozen regular-expression grader (`detects`) misses a reviewer who names a
 * recorded defect in other words, so this lane grades each claim by reading:
 *
 *   match   - every claimed section of every run, against the recorded
 *             defects and decoys at its head, by two judges of different
 *             model families. A claim counts as a recorded case only when both
 *             name it.
 *   cluster - per head, the claimed sections neither the panel nor the frozen
 *             patterns tie to a case, grouped by the defect they describe, so
 *             one defect claimed by many runs is checked once and gets one
 *             verdict whichever arm claimed it.
 *   verify  - per group, an agent with the snapshot and the reviewer's own
 *             probes decides whether the defect is real (`judge-verify.md`).
 *
 * Every judgement is appended to `<dir>/{match,cluster,verify}.jsonl` under a
 * key hashed from everything it read (template, model, case text, claim
 * text), so a re-run reuses it and a changed input is judged again. No
 * judgement ever sees which arm wrote a claim.
 *
 * Usage:
 *   bun scripts/reviewer-gap/judge.ts match   --runs <dir>[,<dir>...] --out <dir> [--concurrency 4]
 *   bun scripts/reviewer-gap/judge.ts cluster --runs <dir>[,<dir>...] --out <dir>
 *   bun scripts/reviewer-gap/judge.ts verify  --runs <dir>[,<dir>...] --out <dir> [--concurrency 2] [--minutes 10]
 *   (all take [--cases cases-c.json])
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "./briefs.ts";
import { loadClaimsCorpus } from "./claims-build.ts";
import { type ClaimsCaseFile, asPatterns, claimedSections } from "./claims.ts";
import { type HeadCase, type RunRecord, detects, loadRuns } from "./grade.ts";
import { pruneScratch, runOmp } from "./run.ts";

export const MATCH_JUDGES = ["openai/gpt-6-astra", "anthropic/claude-opus-5"];
export const CLUSTER_JUDGE = "openai/gpt-6-astra";
export const VERIFIER = "openai/gpt-6-astra";

const DIR = import.meta.dir;
const template = (name: string): string => fs.readFileSync(path.join(DIR, "prompts", name), "utf8");

/** One claimed section of one run. */
export interface Claim {
	runId: string;
	arm: string;
	head: string;
	index: number;
	text: string;
	sha: string;
}

export function claimsOf(runs: RunRecord[], heads: Set<string>): Claim[] {
	return runs
		.filter(r => r.error === undefined && heads.has(r.head))
		.flatMap(r =>
			claimedSections(r.report).map((text, index) => ({
				runId: r.runId,
				arm: r.arm,
				head: r.head,
				index,
				text,
				sha: sha256(text),
			})),
		);
}

export interface MatchJudgement {
	key: string;
	judge: string;
	head: string;
	claimSha: string;
	match: string[];
	why: string;
	error?: string;
}

export interface ClusterJudgement {
	key: string;
	head: string;
	/** Claim shas in the order the judge saw them; groups index into it from 1. */
	claims: string[];
	groups: number[][];
	error?: string;
}

export interface VerifyJudgement {
	key: string;
	head: string;
	/** The claim the verifier read, and the run whose scratch it was given. */
	claimSha: string;
	runId: string;
	verdict: "REAL" | "NOT-REAL" | "UNDETERMINED";
	reason: string;
	evidence: string;
	report: string;
	elapsedMs: number;
	calls: number;
	error?: string;
}

/** The recorded cases at a head, as the match judge reads them. */
export function caseText(cases: ClaimsCaseFile, head: string): string {
	const corpus = loadClaimsCorpus(path.join(DIR, "corpus", "claims"));
	const defects = new Map(corpus.defects.map(d => [d.id, d]));
	const decoys = new Map(corpus.decoys.map(d => [d.id, d]));
	const parts: string[] = [];
	for (const f of cases.findings.filter(x => x.head === head)) {
		const d = defects.get(f.id);
		const summary = d?.mechanism_summary ?? "";
		const words = d?.finder_sections[0]?.text.slice(0, 1500) ?? "";
		parts.push(`## DEFECT ${f.id}: ${f.title}\n\n${summary}\n\nThe finding reviewer's words:\n\n${words}`);
	}
	for (const c of cases.decoys.filter(x => x.head === head)) {
		const words = decoys.get(c.id)?.claimed_by[0]?.text.slice(0, 1000) ?? "";
		parts.push(`## DECOY ${c.id}: ${c.title}\n\nThe reviewer's words:\n\n${words}`);
	}
	return parts.join("\n\n---\n\n");
}

const JUDGE_ARGS = [
	"-p",
	"--no-session",
	"--no-title",
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--no-context-files",
	"--mode",
	"json",
];

/** The last line of a report that parses as a JSON object, or undefined. */
export function lastJson<T>(report: string): T | undefined {
	const lines = report.trim().split("\n").reverse();
	for (const l of lines) {
		const t = l.trim().replace(/^`+|`+$/g, "");
		if (!t.startsWith("{")) continue;
		try {
			return JSON.parse(t) as T;
		} catch {}
	}
	return undefined;
}

function childEnv(scratch: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch, OMP_LOG_LEVEL: "error" };
	for (const k of ["PI_SESSION_FILE", "PI_SESSION_ID", "OMP_SESSION_ID", "PI_COMMIT_TRAILERS", "GIT_DIR"])
		delete env[k];
	return env;
}

function readJsonlFile<T>(file: string): T[] {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(l => l.trim() !== "")
		.map(l => JSON.parse(l) as T);
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			for (;;) {
				const item = items[i++];
				if (item === undefined) return;
				await fn(item);
			}
		}),
	);
}

export function matchKey(judge: string, head: string, cases: string, claimSha: string): string {
	return sha256(["match", sha256(template("judge-match.md")), judge, head, sha256(cases), claimSha].join("\n"));
}

async function judgeMatch(cases: ClaimsCaseFile, claims: Claim[], out: string, concurrency: number): Promise<void> {
	const file = path.join(out, "match.jsonl");
	const done = new Set(
		readJsonlFile<MatchJudgement>(file)
			.filter(j => j.error === undefined)
			.map(j => j.key),
	);
	const text = new Map<string, string>();
	for (const h of new Set(claims.map(c => c.head))) text.set(h, caseText(cases, h));
	// One judgement per (judge, head, distinct claim text): a claim two runs wrote word for word is read once.
	const work = new Map<string, { judge: string; claim: Claim }>();
	for (const c of claims)
		for (const judge of MATCH_JUDGES) {
			const key = matchKey(judge, c.head, text.get(c.head) as string, c.sha);
			if (!done.has(key)) work.set(key, { judge, claim: c });
		}
	console.log(`match: ${work.size} judgements to make, ${done.size} recorded`);
	const scratch = path.join(out, "scratch");
	fs.mkdirSync(scratch, { recursive: true });
	await pool([...work.entries()], concurrency, async ([key, { judge, claim }]) => {
		const prompt = template("judge-match.md")
			.replace("{{cases}}", text.get(claim.head) as string)
			.replace("{{claim}}", claim.text.slice(0, 6000));
		const r = await runOmp(
			[...JUDGE_ARGS, "--model", judge, "--thinking", "medium", "--no-tools"],
			prompt,
			scratch,
			childEnv(scratch),
		);
		const parsed = lastJson<{ match?: unknown; why?: unknown }>(r.report);
		const ids = new Set([
			...cases.findings.filter(f => f.head === claim.head).map(f => f.id),
			...cases.decoys.filter(d => d.head === claim.head).map(d => d.id),
		]);
		const match = Array.isArray(parsed?.match) ? parsed.match.filter((m): m is string => typeof m === "string") : [];
		const unknown = match.filter(m => !ids.has(m));
		const j: MatchJudgement = {
			key,
			judge,
			head: claim.head,
			claimSha: claim.sha,
			match: match.filter(m => ids.has(m)),
			why: typeof parsed?.why === "string" ? parsed.why : "",
			...(parsed === undefined || !Array.isArray(parsed.match)
				? { error: `no JSON answer; exit ${r.exitCode}; ${r.report.slice(-300)}` }
				: unknown.length > 0
					? { error: `unknown ids ${unknown.join(",")}` }
					: {}),
		};
		fs.appendFileSync(file, `${JSON.stringify(j)}\n`);
		console.log(
			`match ${judge} ${claim.head} ${claim.sha.slice(0, 8)} -> ${j.match.join(",") || "-"}${j.error ? ` ERROR ${j.error.slice(0, 80)}` : ""}`,
		);
	});
}

/** What the panel and the frozen patterns say one claim is. */
export interface ClaimOutcome {
	/** Case ids both match judges named. */
	agreed: string[];
	/** Case ids exactly one judge named. */
	disputed: string[];
	/** Case ids the frozen patterns fire on inside this section. */
	patterns: string[];
	/** Both judges answered without error. */
	complete: boolean;
}

export function outcomes(cases: ClaimsCaseFile, claims: Claim[], dir: string): Map<Claim, ClaimOutcome> {
	const recorded = readJsonlFile<MatchJudgement>(path.join(dir, "match.jsonl")).filter(j => j.error === undefined);
	const byKey = new Map(recorded.map(j => [j.key, j]));
	const text = new Map<string, string>();
	const out = new Map<Claim, ClaimOutcome>();
	for (const c of claims) {
		if (!text.has(c.head)) text.set(c.head, caseText(cases, c.head));
		const js = MATCH_JUDGES.map(judge => byKey.get(matchKey(judge, c.head, text.get(c.head) as string, c.sha)));
		const sets = js.map(j => new Set(j?.match ?? []));
		const all = new Set(sets.flatMap(s => [...s]));
		const agreed = [...all].filter(id => sets.every(s => s.has(id)));
		const pats = [
			...cases.findings.filter(f => f.head === c.head),
			...cases.decoys.filter(d => d.head === c.head).map(asPatterns),
		]
			.filter(p => detects(c.text, p, cases.window_chars))
			.map(p => p.id);
		out.set(c, {
			agreed,
			disputed: [...all].filter(id => !agreed.includes(id)),
			patterns: pats,
			complete: js.every(j => j !== undefined),
		});
	}
	return out;
}

/**
 * Claims neither both judges nor a frozen pattern tie to a recorded case:
 * their truth is unknown until verified. A claim only one judge tied is
 * among them, so a near-miss is checked rather than dropped.
 */
export function untied(o: ClaimOutcome): boolean {
	return o.agreed.length === 0 && o.patterns.length === 0;
}

export function clusterKey(head: string, shas: string[]): string {
	return sha256(["cluster", sha256(template("judge-cluster.md")), CLUSTER_JUDGE, head, ...shas].join("\n"));
}

async function judgeCluster(cases: ClaimsCaseFile, claims: Claim[], out: string): Promise<void> {
	const file = path.join(out, "cluster.jsonl");
	const done = new Set(
		readJsonlFile<ClusterJudgement>(file)
			.filter(j => j.error === undefined)
			.map(j => j.key),
	);
	const o = outcomes(cases, claims, out);
	const incomplete = claims.filter(c => o.get(c)?.complete !== true).length;
	if (incomplete > 0) throw new Error(`${incomplete} claims lack a match judgement from both judges; run match first`);
	const scratch = path.join(out, "scratch");
	fs.mkdirSync(scratch, { recursive: true });
	for (const head of [...new Set(claims.map(c => c.head))].sort()) {
		const byText = new Map<string, Claim>();
		for (const c of claims) {
			const oc = o.get(c);
			if (c.head === head && oc !== undefined && untied(oc)) byText.set(c.sha, c);
		}
		const shas = [...byText.keys()].sort();
		if (shas.length === 0) continue;
		const key = clusterKey(head, shas);
		if (done.has(key)) continue;
		const list = shas
			.map((s, i) => `## Claim ${i + 1}\n\n${(byText.get(s) as Claim).text.slice(0, 1500)}`)
			.join("\n\n");
		const r = await runOmp(
			[...JUDGE_ARGS, "--model", CLUSTER_JUDGE, "--thinking", "medium", "--no-tools"],
			template("judge-cluster.md").replace("{{claims}}", list),
			scratch,
			childEnv(scratch),
		);
		const parsed = lastJson<{ groups?: unknown }>(r.report);
		const groups = Array.isArray(parsed?.groups)
			? parsed.groups.map(g => (Array.isArray(g) ? g.filter((n): n is number => Number.isInteger(n)) : []))
			: [];
		const seen = groups.flat().sort((a, b) => a - b);
		const ok = seen.length === shas.length && seen.every((n, i) => n === i + 1);
		const j: ClusterJudgement = {
			key,
			head,
			claims: shas,
			groups: ok ? groups : shas.map((_, i) => [i + 1]),
			...(ok ? {} : { error: `groups do not partition 1..${shas.length}; each claim kept alone` }),
		};
		fs.appendFileSync(file, `${JSON.stringify(j)}\n`);
		console.log(
			`cluster ${head}: ${shas.length} claims -> ${j.groups.length} groups${j.error ? ` (${j.error})` : ""}`,
		);
	}
}

/** The latest clustering of each head, read back for verify and scoring. */
export function latestClusters(dir: string): Map<string, ClusterJudgement> {
	const m = new Map<string, ClusterJudgement>();
	for (const j of readJsonlFile<ClusterJudgement>(path.join(dir, "cluster.jsonl"))) m.set(j.head, j);
	return m;
}

export function verifyKey(head: string, claimSha: string, runId: string, minutes: number): string {
	return sha256(
		["verify", sha256(template("judge-verify.md")), VERIFIER, head, claimSha, runId, String(minutes)].join("\n"),
	);
}

/**
 * Per head, group and arm: the claim the verifier reads, the longest that arm
 * made in the group, with that run's own scratch. A verdict applies only to
 * its arm's claims in the group, so no arm is judged by another arm's report
 * or probes.
 */
export function representatives(
	claims: Claim[],
	dir: string,
): { head: string; arm: string; group: string[]; rep: Claim }[] {
	const out: { head: string; arm: string; group: string[]; rep: Claim }[] = [];
	for (const [head, cl] of latestClusters(dir)) {
		for (const g of cl.groups) {
			const shas = g.map(n => cl.claims[n - 1] as string);
			const members = claims.filter(c => c.head === head && shas.includes(c.sha));
			for (const arm of [...new Set(members.map(c => c.arm))].sort()) {
				const rep = members
					.filter(c => c.arm === arm)
					.sort((a, b) => b.text.length - a.text.length || a.runId.localeCompare(b.runId))[0];
				if (rep !== undefined) out.push({ head, arm, group: shas, rep });
			}
		}
	}
	return out;
}

async function judgeVerify(
	cases: ClaimsCaseFile & { heads: (HeadCase & { prior?: string | null })[] },
	claims: Claim[],
	runDirs: string[],
	out: string,
	concurrency: number,
	minutes: number,
): Promise<void> {
	const file = path.join(out, "verify.jsonl");
	const done = new Set(
		readJsonlFile<VerifyJudgement>(file)
			.filter(j => j.error === undefined)
			.map(j => j.key),
	);
	const reps = representatives(claims, out).filter(r => !done.has(verifyKey(r.head, r.rep.sha, r.rep.runId, minutes)));
	console.log(`verify: ${reps.length} (group, arm) representatives to check`);
	await pool(reps, concurrency, async ({ head, rep }) => {
		const h = cases.heads.find(x => x.id === head) as HeadCase;
		const key = verifyKey(head, rep.sha, rep.runId, minutes);
		const scratch = path.join(out, "verify-scratch", key.slice(0, 16));
		fs.mkdirSync(scratch, { recursive: true });
		const reviewerScratch =
			runDirs.map(d => path.join(d, "scratch", rep.runId)).find(p => fs.existsSync(p)) ?? "(none kept)";
		const prompt = template("judge-verify.md")
			.replaceAll("{{checkout}}", h.checkout)
			.replaceAll("{{diff}}", h.diff)
			.replaceAll("{{base}}", h.base_sha.slice(0, 12))
			.replaceAll("{{head}}", h.head_sha.slice(0, 12))
			.replaceAll("{{subject}}", h.subject)
			.replaceAll("{{reviewer_scratch}}", reviewerScratch)
			.replaceAll("{{scratch}}", scratch)
			.replaceAll("{{minutes}}", String(minutes))
			.replace("{{claim}}", rep.text.slice(0, 8000));
		const started = Date.now();
		const r = await runOmp(
			[
				...JUDGE_ARGS,
				"--model",
				VERIFIER,
				"--thinking",
				"high",
				"--tools",
				"read,grep,glob,bash,write,edit",
				"--max-time",
				`${minutes}m`,
				"--auto-approve",
			],
			prompt,
			scratch,
			{
				...childEnv(scratch),
				BUN_INSTALL_CACHE_DIR: path.join(scratch, "bun-cache"),
				GIT_CEILING_DIRECTORIES: [h.checkout, scratch].join(":"),
			},
		);
		const parsed = lastJson<{ verdict?: string; reason?: string; evidence?: string }>(r.report);
		const verdict = parsed?.verdict;
		const ok = verdict === "REAL" || verdict === "NOT-REAL" || verdict === "UNDETERMINED";
		const j: VerifyJudgement = {
			key,
			head,
			claimSha: rep.sha,
			runId: rep.runId,
			verdict: ok ? verdict : "UNDETERMINED",
			reason: parsed?.reason ?? "",
			evidence: parsed?.evidence ?? "",
			report: r.report.slice(-6000),
			elapsedMs: Date.now() - started,
			calls: r.usage.calls,
			...(ok ? {} : { error: `no verdict; exit ${r.exitCode}` }),
		};
		fs.appendFileSync(file, `${JSON.stringify(j)}\n`);
		pruneScratch(scratch);
		console.log(
			`verify ${head} ${rep.sha.slice(0, 8)} -> ${j.verdict} ${j.reason} ${Math.round(j.elapsedMs / 1000)}s`,
		);
	});
}

/** One judge's reading of numbered sentences against a head's cases: sentence numbers (from 1) and the case ids each concerns. */
export interface SentenceJudgement {
	key: string;
	judge: string;
	head: string;
	template: string;
	sentences: string[];
	links: { sentence: number; entries: string[] }[];
}

/**
 * Both match judges read numbered sentences against the recorded cases at a
 * head through `name` (`judge-leak.md`: which sentences give a case away;
 * `judge-reopen.md`: which cases re-open a finding the sentences name).
 * Returns, per sentence index from 0, the case ids either judge tied to it,
 * each suffixed with the judge. Cached in `<out>/sentences.jsonl`.
 */
async function sentencePanel(
	name: "judge-leak.md" | "judge-reopen.md",
	cases: ClaimsCaseFile,
	head: string,
	sentences: string[],
	out: string,
): Promise<Map<number, string[]>> {
	const file = path.join(out, "sentences.jsonl");
	const recorded = new Map(readJsonlFile<SentenceJudgement>(file).map(j => [j.key, j]));
	const text = caseText(cases, head);
	const tied = new Map<number, string[]>();
	if (sentences.length === 0) return tied;
	const scratch = path.join(out, "scratch");
	fs.mkdirSync(scratch, { recursive: true });
	const ids = new Set([
		...cases.findings.filter(f => f.head === head).map(f => f.id),
		...cases.decoys.filter(d => d.head === head).map(d => d.id),
	]);
	for (const judge of MATCH_JUDGES) {
		const key = sha256([name, sha256(template(name)), judge, head, sha256(text), ...sentences].join("\n"));
		let j = recorded.get(key);
		for (let attempt = 0; j === undefined && attempt < 2; attempt++) {
			const prompt = template(name)
				.replace("{{sentences}}", sentences.map((s, i) => `${i + 1}. ${s}`).join("\n"))
				.replace("{{cases}}", text);
			const r = await runOmp(
				[...JUDGE_ARGS, "--model", judge, "--thinking", "medium", "--no-tools"],
				prompt,
				scratch,
				childEnv(scratch),
			);
			const parsed = lastJson<{ leaks?: unknown; reopens?: unknown }>(r.report);
			const list = name === "judge-leak.md" ? parsed?.leaks : parsed?.reopens;
			if (!Array.isArray(list)) continue;
			const links: SentenceJudgement["links"] = [];
			for (const l of list) {
				if (l === null || typeof l !== "object") continue;
				if ("sentence" in l && "entries" in l && Number.isInteger(l.sentence) && Array.isArray(l.entries))
					links.push({
						sentence: Number(l.sentence),
						entries: l.entries.filter((e): e is string => typeof e === "string" && ids.has(e)),
					});
				else if (
					"entry" in l &&
					"sentences" in l &&
					typeof l.entry === "string" &&
					Array.isArray(l.sentences) &&
					ids.has(l.entry)
				)
					for (const s of l.sentences)
						if (Number.isInteger(s)) links.push({ sentence: Number(s), entries: [l.entry] });
			}
			j = { key, judge, head, template: name, sentences, links };
			fs.appendFileSync(file, `${JSON.stringify(j)}\n`);
		}
		if (j === undefined) throw new Error(`${head}: ${judge} gave no ${name} answer twice`);
		for (const l of j.links)
			if (l.entries.length > 0)
				tied.set(l.sentence - 1, [...(tied.get(l.sentence - 1) ?? []), ...l.entries.map(e => `${e}@${judge}`)]);
	}
	return tied;
}

/** Sentences either judge says give away a recorded case at the head (`judge-leak.md`). */
export async function leakCheck(
	cases: ClaimsCaseFile,
	head: string,
	sentences: string[],
	out: string,
): Promise<Map<number, string[]>> {
	return sentencePanel("judge-leak.md", cases, head, sentences, out);
}

/** Cases either judge says re-open a finding the re-break sentences name, by sentence (`judge-reopen.md`). */
export async function reopenCheck(
	cases: ClaimsCaseFile,
	head: string,
	sentences: string[],
	out: string,
): Promise<Map<number, string[]>> {
	return sentencePanel("judge-reopen.md", cases, head, sentences, out);
}

export function readJudgements(dir: string): {
	match: MatchJudgement[];
	verify: VerifyJudgement[];
} {
	return {
		match: readJsonlFile<MatchJudgement>(path.join(dir, "match.jsonl")),
		verify: readJsonlFile<VerifyJudgement>(path.join(dir, "verify.jsonl")),
	};
}

async function main(): Promise<void> {
	const [mode, ...argv] = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const runDirs = (get("--runs") ?? "").split(",").filter(Boolean);
	const out = get("--out");
	if (runDirs.length === 0 || out === undefined || !["match", "cluster", "verify"].includes(mode ?? "")) {
		console.error("usage: judge.ts match|cluster|verify --runs <dir>[,<dir>...] --out <dir> [--cases cases-c.json]");
		process.exit(2);
	}
	const cases = JSON.parse(
		fs.readFileSync(get("--cases") ?? path.join(DIR, "cases-c.json"), "utf8"),
	) as ClaimsCaseFile & { heads: (HeadCase & { prior?: string | null })[] };
	fs.mkdirSync(out, { recursive: true });
	const claims = claimsOf(
		runDirs.flatMap(d => loadRuns(d)),
		new Set(cases.heads.map(h => h.id)),
	);
	console.log(`${claims.length} claimed sections over ${runDirs.length} run directories`);
	if (mode === "match") await judgeMatch(cases, claims, out, Number(get("--concurrency") ?? "4"));
	if (mode === "cluster") await judgeCluster(cases, claims, out);
	if (mode === "verify")
		await judgeVerify(
			cases,
			claims,
			runDirs,
			out,
			Number(get("--concurrency") ?? "2"),
			Number(get("--minutes") ?? "10"),
		);
}

if (import.meta.main) await main();
