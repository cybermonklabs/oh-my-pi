import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ROOT } from "./claims-build.ts";
import { detects, type RunRecord } from "./grade.ts";
import { preflight, sessionDirs, userPrompt } from "./run.ts";
import {
	COORDINATES,
	gradeVerdicts,
	outcomeOf,
	parseVerdict,
	type VerdictCase,
	type VerdictCaseFile,
	type VerdictHead,
} from "./verdict.ts";
import { makeMaterial, sourcesFor } from "./verdict-build.ts";

const dir = import.meta.dir;

const head: VerdictHead = {
	id: "h1",
	pr: 1,
	round: 1,
	head_sha: "a".repeat(40),
	base_sha: "b".repeat(40),
	checkout: "/nonexistent/snapshot",
	diff: "/nonexistent/patch.diff",
	subject: "s",
	packages: ["packages/x"],
	claim: "Writing to a full disk reports ENOSPC.",
	claim_source: "SOURCE-OF-THE-CLAIM",
	materials: [],
	cwd: null,
};

const toy: VerdictCaseFile = {
	frozen_at: "t",
	window_chars: 1200,
	report_format: "verdict",
	heads: [head, { ...head, id: "h2" }],
	verdicts: [
		{
			id: "V-1",
			head: "h1",
			title: "a full disk is silent",
			expected: "does-not-hold",
			coordinate: "domain",
			mechanism: [["/dev/full"]],
			trigger: [["silent", "nothing"]],
		},
		{
			id: "V-2",
			head: "h2",
			title: "the script excludes napi",
			expected: "holds",
			coordinate: "object",
			mechanism: [["napi"]],
			trigger: [["exclud"]],
		},
	],
};

function run(report: string, over: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "a__h1__t1",
		arm: "a",
		head: "h1",
		trial: 1,
		model: "m",
		report,
		costUsd: 1,
		elapsedMs: 1,
		exitCode: 0,
		...over,
	};
}

describe("parseVerdict", () => {
	test("the last verdict line is the run's verdict, in either spelling and with markup", () => {
		expect(parseVerdict("VERDICT: HOLDS")).toBe("holds");
		expect(parseVerdict("**VERDICT: DOES NOT HOLD**")).toBe("does-not-hold");
		expect(parseVerdict("## Verdict: does not hold.")).toBe("does-not-hold");
		expect(parseVerdict("VERDICT: HOLDS\n\nOn reflection:\n\nVERDICT: DOES NOT HOLD")).toBe("does-not-hold");
	});

	test("a verdict quoted in output, in a block quote or inside a sentence is not the run's", () => {
		expect(parseVerdict("```\nVERDICT: HOLDS\n```")).toBeNull();
		expect(parseVerdict("> VERDICT: HOLDS")).toBeNull();
		expect(parseVerdict("I would write VERDICT: HOLDS if it held.")).toBeNull();
		expect(parseVerdict("VERDICT: DOES NOT HOLD\n```\nVERDICT: HOLDS\n```")).toBe("does-not-hold");
	});
});

describe("outcomeOf", () => {
	test("a wrong verdict is named by its direction; a right one by whether its deciding observation is there", () => {
		expect(outcomeOf("does-not-hold", "holds", true)).toBe("wrong-clear");
		expect(outcomeOf("holds", "does-not-hold", true)).toBe("wrong-fail");
		expect(outcomeOf("does-not-hold", "does-not-hold", true)).toBe("supported");
		expect(outcomeOf("does-not-hold", "does-not-hold", false)).toBe("unsupported");
	});
});

describe("gradeVerdicts", () => {
	test("errored and verdict-less runs are excluded from n and counted; each direction has its own denominator", () => {
		const runs = [
			run("Wrote to /dev/full: the refusal was silent? No, it printed.\nVERDICT: HOLDS", { runId: "r1" }),
			run("f 2>/dev/full printed nothing on Bash and the error here.\nVERDICT: DOES NOT HOLD", {
				runId: "r2",
				trial: 2,
			}),
			run("It fails.\nVERDICT: DOES NOT HOLD", { runId: "r3", trial: 3 }),
			run("", { runId: "r4", trial: 4, error: "spend cap reached" }),
			run("Looks fine to me.", { runId: "r5", trial: 5 }),
			run("napi is excluded by the script.\nVERDICT: DOES NOT HOLD", { runId: "r6", head: "h2" }),
			run("VERDICT: HOLDS", { runId: "r7", head: "elsewhere" }),
		];
		const [r] = gradeVerdicts(toy, runs);
		expect(r?.runs).toBe(4);
		expect(r?.erroredRuns).toBe(1);
		expect(r?.noVerdictRuns).toBe(1);
		expect([r?.wrongClear.hits, r?.wrongClear.n]).toEqual([1, 3]);
		expect([r?.wrongFail.hits, r?.wrongFail.n]).toEqual([1, 1]);
		expect([r?.wrong.hits, r?.supported.hits, r?.wrong.n]).toEqual([2, 1, 4]);
		expect(r?.perCase["V-1"]).toEqual({ supported: 1, unsupported: 1, "wrong-clear": 1, "wrong-fail": 0 });
		expect(r?.byCoordinate.object).toEqual({ n: 1, wrong: 1, supported: 0 });
	});
});

describe("run.ts on a verdict head", () => {
	test("the prompt carries the claim and the two verdict lines, and never where the claim came from", () => {
		const p = userPrompt(head, "/scratch", 20, false, "verdict");
		expect(p).toContain(`Claim to verify:\n\n${head.claim}\n`);
		expect(p).toContain("\nVERDICT: HOLDS\nVERDICT: DOES NOT HOLD\n");
		expect(p).not.toContain(head.claim_source);
		expect(p).not.toContain("## DEFECT:");
		expect(() => userPrompt({ ...head, claim: undefined }, "/scratch", 20, false, "verdict")).toThrow();
	});

	test("a head that names a working directory starts there, and git stops climbing at it", () => {
		expect(sessionDirs(head, "/scratch")).toEqual({ cwd: "/scratch", ceiling: "/nonexistent/snapshot:/scratch" });
		const d = sessionDirs({ ...head, cwd: "/elsewhere/oh-my-pi" }, "/scratch");
		expect(d.cwd).toBe("/elsewhere/oh-my-pi");
		expect(d.ceiling.split(":")).toEqual(["/nonexistent/snapshot", "/scratch", "/elsewhere/oh-my-pi"]);
	});

	test("preflight names a missing working directory and a missing material", () => {
		const problems = preflight({
			...head,
			cwd: "/nonexistent/cwd",
			materials: [{ path: "/nonexistent/m", note: "" }],
		});
		expect(problems).toContain("h1: working directory /nonexistent/cwd does not exist");
		expect(problems).toContain("h1: material /nonexistent/m does not exist");
	});
});

describe("makeMaterial", () => {
	test("a pinned copy drops the named lines, is read-only, and refuses bytes that are not the pinned ones", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-material-"));
		try {
			const from = path.join(tmp, "src.log");
			fs.writeFileSync(from, "SET=script\nCOMMAND: x\nanswer 1\nanswer 2\nkept\n");
			const sha256 = new Bun.CryptoHasher("sha256").update(fs.readFileSync(from)).digest("hex");
			const at = path.join(tmp, "out", "1.log");
			makeMaterial(at, {
				kind: "copy",
				from,
				sha256,
				drop: {
					lines: [
						[1, 1],
						[3, 4],
					],
					why: "test",
				},
			});
			expect(fs.readFileSync(at, "utf8")).toBe("COMMAND: x\nkept\n");
			expect(() => fs.writeFileSync(at, "x")).toThrow();
			expect(() =>
				makeMaterial(path.join(tmp, "out", "2.log"), { kind: "copy", from, sha256: "0".repeat(64) }),
			).toThrow("pinned");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});

interface CorpusRecord {
	id: string;
	head: string;
	head_sha: string;
	coordinate: string;
	expected: string;
	original_verdict: string;
	claim: string;
	wrong_verdict: { source: string; text: string }[];
	refutations: { source: string; text: string }[];
	diagnosis: { by: string; source: string; text: string };
}

const cases = JSON.parse(fs.readFileSync(path.join(dir, "cases-verdict.json"), "utf8")) as VerdictCaseFile;
const corpus = fs
	.readFileSync(path.join(dir, "corpus", "verdicts.jsonl"), "utf8")
	.split("\n")
	.filter(l => l.trim().length > 0)
	.map(l => JSON.parse(l) as CorpusRecord);

const freeze = JSON.parse(fs.readFileSync(path.join(dir, "verdict-freeze.json"), "utf8")) as {
	frozen_at: string;
	inputs: { cases_sha256: string; corpus_sha256: string; scorer_sha256: string };
	arms: { name: string; model: string; prompt: string; prompt_sha256: string }[];
	trials: number;
	concurrency: number;
	max_time: string;
	max_cost: number;
	repo_gate: boolean;
};
const fires = (text: string, c: VerdictCase): boolean =>
	detects(text, { ...c, severity: "", how_found_primary: "" }, cases.window_chars);

describe("corpus/verdicts.jsonl and cases-verdict.json", () => {
	test("one record per case, on the same head, with the same claim, coordinate and verdict", () => {
		expect(corpus.map(r => r.id).sort()).toEqual(cases.verdicts.map(v => v.id).sort());
		for (const v of cases.verdicts) {
			const r = corpus.find(x => x.id === v.id) as CorpusRecord;
			const h = cases.heads.find(x => x.id === v.head) as VerdictHead;
			expect([r.head, r.head_sha, r.coordinate, r.expected, r.claim]).toEqual([
				v.head,
				h.head_sha,
				v.coordinate,
				v.expected,
				h.claim,
			]);
		}
	});

	test("every record is a wrong verdict a reviewer of the batch gave, and every coordinate has a case", () => {
		for (const r of corpus) expect(r.original_verdict).not.toBe(r.expected);
		expect([...new Set(cases.verdicts.map(v => v.coordinate))].sort()).toEqual([...COORDINATES].sort());
	});

	test("the freeze pins the exact cases, corpus, scorer and planned run", () => {
		const hash = (file: string): string =>
			new Bun.CryptoHasher("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex");
		expect(freeze.frozen_at).toBe(cases.frozen_at);
		expect([freeze.inputs.cases_sha256, freeze.inputs.corpus_sha256, freeze.inputs.scorer_sha256]).toEqual([
			hash("cases-verdict.json"),
			hash("corpus/verdicts.jsonl"),
			hash("verdict.ts"),
		]);
		expect(freeze.arms).toEqual([
			{
				name: "current",
				model: "anthropic/claude-opus-5-5",
				prompt: "prompts/current.md",
				prompt_sha256: hash("prompts/current.md"),
			},
		]);
		expect([freeze.trials, freeze.concurrency, freeze.max_time, freeze.max_cost, freeze.repo_gate]).toEqual([
			3,
			1,
			"20m",
			3,
			false,
		]);
	});

	test("a case's patterns fire on every text that refuted the wrong verdict and on none of the wrong verdict's", () => {
		for (const v of cases.verdicts) {
			const r = corpus.find(x => x.id === v.id) as CorpusRecord;
			expect({ id: v.id, refutations: r.refutations.map(t => fires(t.text, v)) }).toEqual({
				id: v.id,
				refutations: r.refutations.map(() => true),
			});
			expect({ id: v.id, wrong: r.wrong_verdict.map(t => fires(t.text, v)) }).toEqual({
				id: v.id,
				wrong: r.wrong_verdict.map(() => false),
			});
		}
	});

	test("no prompt a run is given states a case's deciding observation", () => {
		const arms = fs
			.readdirSync(path.join(dir, "prompts"))
			.map(f => fs.readFileSync(path.join(dir, "prompts", f), "utf8"));
		for (const h of cases.heads) {
			const v = cases.verdicts.find(x => x.head === h.id) as VerdictCase;
			const shared = userPrompt(h, "/scratch", 20, false, "verdict");
			expect({ head: h.id, shared: fires(shared, v), arms: arms.some(a => fires(a, v)) }).toEqual({
				head: h.id,
				shared: false,
				arms: false,
			});
		}
	});

	test("setup can rebuild every material and working directory the eval makes", () => {
		const made = cases.heads.flatMap(h => [...h.materials.map(m => m.path), ...(h.cwd === null ? [] : [h.cwd])]);
		for (const p of made.filter(p => p.startsWith(`${ROOT}/verdict/`)))
			expect({ p, sources: sourcesFor(p).length > 0 }).toEqual({ p, sources: true });
		for (const p of made.filter(p => !p.startsWith(`${ROOT}/verdict/`)))
			expect(cases.heads.some(h => p.startsWith(`${h.checkout}/`)) || p === "/usr/bin/bash").toBe(true);
	});
});

const built = cases.heads.every(h => preflight(h).length === 0);
describe.if(built)("the built materials", () => {
	const files = (p: string): string[] =>
		fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap(e => files(path.join(p, e))) : [p];

	test("no material a run is handed states its case's deciding observation", () => {
		for (const h of cases.heads) {
			const v = cases.verdicts.find(x => x.head === h.id) as VerdictCase;
			const given = h.materials
				.filter(m => m.path.startsWith(`${ROOT}/verdict/`))
				.flatMap(m => files(m.path))
				.filter(f => fires(fs.readFileSync(f, "utf8"), v));
			expect({ head: h.id, given }).toEqual({ head: h.id, given: [] });
		}
	});

	test("the working directory of the object case holds the other revision's script, and the snapshot the head's", () => {
		const h = cases.heads.find(x => x.cwd !== null) as VerdictHead;
		const excludes = (root: string): string[] =>
			[
				...fs
					.readFileSync(path.join(root, "scripts", "run-rs-task.ts"), "utf8")
					.matchAll(/"--exclude",\s*"([^"]+)"/g),
			].map(m => m[1] as string);
		expect(excludes(h.cwd as string)).toEqual(["brush-core", "cfg_aliases"]);
		expect(excludes(h.checkout).slice(0, 4)).toEqual(["brush-core", "brush-parser", "cfg_aliases", "napi"]);
	});
});
