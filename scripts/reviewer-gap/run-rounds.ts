#!/usr/bin/env bun
/**
 * Multi-round scenario runner for the reviewer-rounds eval.
 *
 * One *sequence* = (arm, head case, trial). A sequence runs its arm's rounds
 * serially in fresh `omp -p` sessions. Round 1 is byte-identical to the
 * one-round arms of the first eval, so it doubles as a provider-drift check.
 * Rounds 2 and above append the arm's frozen round template:
 *
 *   retry-blind  - the expectation that an earlier attempt missed something,
 *                  nothing else; fresh scratch directory every round.
 *   rounds-carry - the same expectation plus every earlier round's report
 *                  verbatim and the sequence's shared scratch directory, so the
 *                  earlier rounds' probes and recorded output are still there.
 *
 * The arms, templates, budgets and cost cap come from `rounds-freeze.json`,
 * committed before the first model call. This file never scores: `rounds.ts`
 * does, with the detection rule of `grade.ts` unchanged.
 *
 * Usage:
 *   bun scripts/reviewer-gap/run-rounds.ts --out <dir> [--arms retry-blind,rounds-carry]
 *                                          [--trials 2] [--heads pr17394-r7,...]
 *                                          [--concurrency 6] [--budget 85] [--dry-run]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { CaseFile, HeadCase, RunRecord } from "./grade.ts";
import { runOmp, scratchTmp, userPrompt } from "./run.ts";

export interface RoundRecord extends RunRecord {
	sequence: string;
	round: number;
	rounds: number;
	promptChars: number;
}

interface FrozenArm {
	name: string;
	model: string;
	rounds: number;
	carries: string;
	new_model_calls: number;
}

interface Freeze {
	frozen_at: string;
	inherits: { cases: string; prompt: string };
	held_fixed: { per_round_budget_minutes: number; per_round_max_cost_usd: number; trials_per_head: number };
	arms: FrozenArm[];
	round_prompt_templates: Record<string, string>;
	cost: { hard_cap_usd: number };
}

/** Earlier rounds' probes, so a carrying round knows what is already on disk. */
export function scratchListing(dir: string): string {
	if (!fs.existsSync(dir)) return "  (nothing yet)";
	const lines: string[] = [];
	const walk = (d: string, prefix: string): void => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			// Caches are noise, not a reproduction.
			if (entry.name === "bun-cache" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) {
				lines.push(`  ${prefix}${entry.name}/`);
				if (lines.length < 200) walk(full, `${prefix}  `);
			} else {
				lines.push(`  ${prefix}${entry.name} (${fs.statSync(full).size} bytes)`);
			}
		}
	};
	walk(dir, "");
	return lines.length === 0 ? "  (nothing yet)" : lines.slice(0, 200).join("\n");
}

export function roundSuffix(
	template: string,
	round: number,
	rounds: number,
	scratch: string,
	prior: RoundRecord[],
): string {
	const reports = prior
		.map(r => `===== round ${r.round} report =====\n${r.report}\n===== end of round ${r.round} report =====`)
		.join("\n\n");
	return template
		.replaceAll("{N}", String(round))
		.replaceAll("{TOTAL}", String(rounds))
		.replaceAll("{PRIOR}", String(round - 1))
		.replaceAll("{SCRATCH_LISTING}", scratchListing(scratch))
		.replaceAll("{PRIOR_REPORTS}", reports);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	// Absolute, always, for the reason given in `run.ts`: the scratch derived from
	// this path is the child's cwd and is quoted to it in the prompt.
	const outArg = get("--out");
	if (outArg === undefined) {
		console.error(
			"usage: run-rounds.ts --out <dir> [--arms ...] [--trials N] [--heads ...] [--concurrency N] [--budget USD] [--dry-run]",
		);
		process.exit(2);
	}
	const outDir = path.resolve(outArg);
	const freeze = JSON.parse(
		fs.readFileSync(get("--freeze") ?? path.join(import.meta.dir, "rounds-freeze.json"), "utf8"),
	) as Freeze;
	const casesPath = get("--cases") ?? path.join(import.meta.dir, freeze.inherits.cases);
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as CaseFile;
	const promptFile = path.join(import.meta.dir, freeze.inherits.prompt);
	const minutes = freeze.held_fixed.per_round_budget_minutes;
	const maxCost = freeze.held_fixed.per_round_max_cost_usd;
	const budget = Number(get("--budget") ?? freeze.cost.hard_cap_usd);
	const trials = Number(get("--trials") ?? freeze.held_fixed.trials_per_head);
	const concurrency = Number(get("--concurrency") ?? "6");
	const dryRun = argv.includes("--dry-run");
	const armNames = (get("--arms") ?? "retry-blind,rounds-carry").split(",").filter(s => s.length > 0);
	const headFilter = get("--heads")?.split(",");
	const heads = cases.heads.filter(h => headFilter === undefined || headFilter.includes(h.id));

	interface Sequence {
		id: string;
		arm: FrozenArm;
		head: HeadCase;
		trial: number;
	}
	const sequences: Sequence[] = [];
	for (const name of armNames) {
		const arm = freeze.arms.find(a => a.name === name);
		if (arm === undefined) throw new Error(`unknown arm ${name}; frozen: ${freeze.arms.map(a => a.name).join(", ")}`);
		if (arm.rounds < 2) throw new Error(`arm ${name} has ${arm.rounds} round(s); use run.ts for one-round arms`);
		if (freeze.round_prompt_templates[name] === undefined)
			throw new Error(`arm ${name} has no frozen round template`);
		for (const head of heads) {
			for (let trial = 1; trial <= trials; trial++) {
				sequences.push({ id: `${arm.name}__${head.id}__t${trial}`, arm, head, trial });
			}
		}
	}

	fs.mkdirSync(outDir, { recursive: true });
	const totalRuns = sequences.reduce((a, s) => a + s.arm.rounds, 0);
	fs.writeFileSync(
		path.join(outDir, "plan.json"),
		`${JSON.stringify(
			{
				started: new Date().toISOString(),
				freeze_frozen_at: freeze.frozen_at,
				cases: casesPath,
				cases_frozen_at: cases.frozen_at,
				prompt: promptFile,
				arms: armNames,
				trials,
				minutes,
				maxCost,
				budget,
				sequences: sequences.map(s => s.id),
				totalRuns,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`${sequences.length} sequences, ${totalRuns} runs, budget $${budget}`);
	if (dryRun) {
		for (const s of sequences) console.log(`  ${s.id} model=${s.arm.model} rounds=${s.arm.rounds}`);
		return;
	}

	// Cumulative spend is checked before every round, so the cap stops the run
	// rather than being exceeded and reported afterwards.
	let spent = 0;
	let stopped = false;
	for (const entry of fs.readdirSync(outDir)) {
		if (!entry.endsWith(".json") || entry === "plan.json" || entry === "results.json") continue;
		spent += (JSON.parse(fs.readFileSync(path.join(outDir, entry), "utf8")) as RoundRecord).costUsd;
	}
	if (spent > 0) console.log(`resuming; $${spent.toFixed(2)} already recorded in ${outDir}`);

	let index = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const seq = sequences[index++];
			if (seq === undefined) return;
			const seqScratch = path.join(outDir, "scratch", seq.id);
			const prior: RoundRecord[] = [];
			for (let round = 1; round <= seq.arm.rounds; round++) {
				const runId = `${seq.id}__r${round}`;
				const outPath = path.join(outDir, `${runId}.json`);
				if (fs.existsSync(outPath)) {
					prior.push(JSON.parse(fs.readFileSync(outPath, "utf8")) as RoundRecord);
					console.log(`skip ${runId} (already recorded)`);
					continue;
				}
				if (spent >= budget) {
					if (!stopped)
						console.error(`BUDGET $${budget} reached at $${spent.toFixed(2)}; starting no more rounds`);
					stopped = true;
					return;
				}
				// retry-blind gets a fresh scratch per round: nothing carries, not
				// even a file on disk. rounds-carry shares one scratch across the
				// sequence, so an earlier round's probes are still there.
				const roundScratch =
					seq.arm.name === "retry-blind" ? path.join(seqScratch, `r${round}`) : path.join(seqScratch, "shared");
				fs.mkdirSync(roundScratch, { recursive: true });
				let prompt = userPrompt(seq.head, roundScratch, minutes);
				if (round > 1) {
					prompt += roundSuffix(
						freeze.round_prompt_templates[seq.arm.name] ?? "",
						round,
						seq.arm.rounds,
						roundScratch,
						prior,
					);
				}
				const args = [
					"-p",
					"--no-session",
					"--no-title",
					"--no-extensions",
					"--no-skills",
					"--no-rules",
					"--no-context-files",
					"--mode",
					"json",
					"--model",
					seq.arm.model,
					"--thinking",
					"high",
					"--tools",
					"read,grep,glob,bash,write,edit",
					"--max-time",
					`${minutes}m`,
					"--max-cost",
					String(maxCost),
					"--auto-approve",
					"--append-system-prompt",
					promptFile,
				];
				const started = Date.now();
				console.log(`start ${runId} (prompt ${prompt.length} chars)`);
				// `GIT_CEILING_DIRECTORIES` for the reason given in `run.ts`: a snapshot
				// carries no `.git`, so `git log` inside one climbs to whatever
				// repository encloses it and reads the wrong history.
				const env: NodeJS.ProcessEnv = {
					...process.env,
					...scratchTmp(roundScratch),
					BUN_INSTALL_CACHE_DIR: path.join(seqScratch, "bun-cache"),
					GIT_CEILING_DIRECTORIES: [seq.head.checkout, roundScratch].join(":"),
				};
				delete env.GIT_DIR;
				const result = await runOmp(args, prompt, roundScratch, env);
				spent += result.costUsd;
				const failure =
					result.exitCode === 3
						? `spend cap reached at $${result.costUsd.toFixed(2)}; exit 3; report truncated to ${result.report.length} chars`
						: result.report.trim().length === 0
							? `empty report; exit ${result.exitCode}; stderr: ${result.stderr}`
							: undefined;
				const record: RoundRecord = {
					runId,
					arm: seq.arm.name,
					head: seq.head.id,
					trial: seq.trial,
					sequence: seq.id,
					round,
					rounds: seq.arm.rounds,
					model: seq.arm.model,
					report: result.report,
					costUsd: result.costUsd,
					elapsedMs: Date.now() - started,
					exitCode: result.exitCode,
					promptChars: prompt.length,
					...(failure === undefined ? {} : { error: failure }),
				};
				fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
				prior.push(record);
				console.log(
					`done  ${runId} exit=${result.exitCode} cost=$${result.costUsd.toFixed(2)} spent=$${spent.toFixed(2)} chars=${result.report.length} ${Math.round((Date.now() - started) / 1000)}s`,
				);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, sequences.length) }, worker));
	console.log(`${stopped ? "STOPPED AT BUDGET" : "all rounds recorded"} in ${outDir}; spent $${spent.toFixed(2)}`);
}

if (import.meta.main) await main();
