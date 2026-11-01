#!/usr/bin/env bun
/**
 * Scenario runner for the reviewer-gap eval.
 *
 * One run = (head case, arm, trial). It starts a real `omp -p` session whose
 * only differences between arms are the text appended to the system prompt and
 * the round brief the user prompt carries, hands it the same snapshot, the same
 * patch, the same tools and the same budget, and records the report it
 * produced, its model requests, tool calls and tokens, and the box's load at
 * its start and end. Grading is `grade.ts` / `claims.ts`; this file never scores.
 *
 * Usage:
 *   bun scripts/reviewer-gap/run.ts --out <dir> [--arms current,candidate,control,crossfamily]
 *                                   [--trials 2] [--heads pr17394-r7,...]
 *                                   [--concurrency 6] [--max-time 25m] [--max-cost 3]
 *                                   [--cases cases.json] [--briefs cases-brief.json]
 *                                   [--disk-cap-gib 40] [--min-free-gib 30] [--no-repo-gate] [--dry-run]
 *
 * Before any run it checks every head it will use (`preflight`): a snapshot
 * whose dependency links dangle, or a patch file that is gone, makes a reviewer
 * that cannot run its probes, and that reviewer reads as a weak one rather than
 * a broken harness. A head that fails the check stops the whole run.
 *
 * Jobs run trial by trial and head by head, with the arms of one head next to
 * each other in an order that rotates with the head, so every arm shares every
 * stretch of box load and provider behaviour rather than one arm running late.
 *
 * When it exits it reports its cgroup's `memory.peak` and the `max` counter of
 * `memory.events`: a non-zero `max` means the runs were throttled by reclaim
 * against the scope's limit, and their wall times are not comparable.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEexist, isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import type { ReportFormat } from "./claims.ts";
import type { BoxLoad, CaseFile, HeadCase, RunRecord } from "./grade.ts";
import { danglingLinks, foreignWorkspaceLinks } from "./snapshot.ts";

/** A part of a round brief an arm adds to the user prompt (`cases-brief.json`). */
export type BriefElement = "loss" | "rebreak" | "repro";

interface Arm {
	name: string;
	/** Prompt file appended to the system prompt, or null for the no-prompt control. */
	prompt: string | null;
	/** Prompt files appended after `prompt`, in order: the static form of a behaviour added to the shipped prompt. */
	extra?: string[];
	model: string;
	/** Brief elements the user prompt carries, in this order, or "full" for the whole kept brief. */
	brief?: BriefElement[] | "full";
}

const OPUS = "anthropic/claude-opus-5-5";
const SHIPPED = "prompts/current.md";

const ARMS: Record<string, Arm> = {
	control: { name: "control", prompt: null, model: OPUS },
	current: { name: "current", prompt: SHIPPED, model: OPUS },
	candidate: { name: "candidate", prompt: "prompts/candidate.md", model: OPUS },
	rederive: { name: "rederive", prompt: "prompts/rederive.md", model: OPUS },
	crossfamily: { name: "crossfamily", prompt: "prompts/candidate.md", model: "openai/gpt-6-astra" },
	"crossfamily-current": { name: "crossfamily-current", prompt: SHIPPED, model: "openai/gpt-6-astra" },
	brief: { name: "brief", prompt: "prompts/brief.md", model: OPUS },
	run: { name: "run", prompt: "prompts/run.md", model: OPUS },
	// The brief lane (`brief-arms-freeze.json`): the shipped prompt in every arm,
	// and a 2x2x2 factorial over three elements of the round's real brief, plus
	// the whole brief with every sentence that states a case removed.
	shipped: { name: "shipped", prompt: SHIPPED, model: OPUS, brief: [] },
	loss: { name: "loss", prompt: SHIPPED, model: OPUS, brief: ["loss"] },
	rebreak: { name: "rebreak", prompt: SHIPPED, model: OPUS, brief: ["rebreak"] },
	repro: { name: "repro", prompt: SHIPPED, model: OPUS, brief: ["repro"] },
	"loss-rebreak": { name: "loss-rebreak", prompt: SHIPPED, model: OPUS, brief: ["loss", "rebreak"] },
	"loss-repro": { name: "loss-repro", prompt: SHIPPED, model: OPUS, brief: ["loss", "repro"] },
	"rebreak-repro": { name: "rebreak-repro", prompt: SHIPPED, model: OPUS, brief: ["rebreak", "repro"] },
	"loss-rebreak-repro": {
		name: "loss-rebreak-repro",
		prompt: SHIPPED,
		model: OPUS,
		brief: ["loss", "rebreak", "repro"],
	},
	"full-brief": { name: "full-brief", prompt: SHIPPED, model: OPUS, brief: "full" },
	// The prompt change: the static form of a behaviour appended to the shipped
	// prompt, with no round brief, run against a fresh `shipped` on the same
	// heads. Which of these run is decided by the factorial's result
	// (`brief-arms-freeze.json` `stage_2`), not by taste.
	"static-loss": { name: "static-loss", prompt: SHIPPED, extra: ["prompts/static-loss.md"], model: OPUS, brief: [] },
	"static-rebreak": {
		name: "static-rebreak",
		prompt: SHIPPED,
		extra: ["prompts/static-rebreak.md"],
		model: OPUS,
		brief: [],
	},
	"static-repro": {
		name: "static-repro",
		prompt: SHIPPED,
		extra: ["prompts/static-repro.md"],
		model: OPUS,
		brief: [],
	},
	"static-all": {
		name: "static-all",
		prompt: SHIPPED,
		extra: ["prompts/static-loss.md", "prompts/static-rebreak.md", "prompts/static-repro.md"],
		model: OPUS,
		brief: [],
	},
};

/**
 * The system-prompt file an arm appends: its `prompt`, or, when the arm adds
 * `extra` files, all of them joined into one file in the run directory, so
 * the record of what the reviewer was given survives with the runs.
 */
export function armPromptFile(arm: Arm, outDir: string): string | null {
	if (arm.prompt === null) return null;
	const base = path.join(import.meta.dir, arm.prompt);
	if (arm.extra === undefined || arm.extra.length === 0) return base;
	const joined = [base, ...arm.extra.map(e => path.join(import.meta.dir, e))]
		.map(f => fs.readFileSync(f, "utf8").trim())
		.join("\n\n");
	const out = path.join(outDir, `prompt-${arm.name}.md`);
	fs.writeFileSync(out, `${joined}\n`);
	return out;
}

/**
 * `cases-brief.json`: per head, the kept text of each brief element of the
 * round's real brief, and the whole kept brief; one reproduction text for
 * every head. Built and checked by `brief-build.ts`.
 */
export interface BriefFile {
	frozen_at: string;
	repro: string;
	heads: Record<string, { source_agent: string; loss: string; rebreak: string; full: string }>;
}

/**
 * The brief an arm gives at a head, and which elements had text there; null
 * when the arm carries none. Elements are joined in an order that starts at
 * `rotation` (mod the elements present), so no element always comes first
 * or last across heads.
 */
export function armBrief(
	arm: Pick<Arm, "brief">,
	head: string,
	file: BriefFile | null,
	rotation = 0,
): { text: string; elements: string[] } | null {
	if (arm.brief === undefined || (Array.isArray(arm.brief) && arm.brief.length === 0)) return null;
	if (file === null) throw new Error("this arm needs a brief file (--briefs)");
	const entry = file.heads[head];
	if (entry === undefined) throw new Error(`${head}: no entry in the brief file`);
	if (arm.brief === "full") return entry.full.trim() === "" ? null : { text: entry.full.trim(), elements: ["full"] };
	const present = arm.brief
		.map(e => ({ e, text: (e === "repro" ? file.repro : entry[e]).trim() }))
		.filter(p => p.text !== "");
	if (present.length === 0) return null;
	const r = rotation % present.length;
	const parts = [...present.slice(r), ...present.slice(0, r)];
	return { text: parts.map(p => p.text).join("\n\n"), elements: parts.map(p => p.e) };
}

/**
 * `repoGate: false` tells the reviewer the repository-wide typecheck is
 * unavailable. Used when the box is short of CPU: the same sentence goes to
 * every arm of a run, so it is a constant across arms, not a treatment.
 *
 * `format: "claims"` asks for the report shape `claims.ts` scores: one
 * `## DEFECT:` section per asserted defect, and everything the reviewer looked
 * at and cleared under `## NOT A DEFECT`. Without it, a report that names a
 * suspicion in order to clear it cannot be told apart from one that asserts it.
 *
 * `prior` points the reviewer at a read-only copy of the previous review
 * round's reports, probes and logs, as every round of the batch the claims
 * lane comes from had. Replaying an earlier probe against a head that changed
 * on purpose is where an obsolete assertion reads as a regression, so without
 * it that kind of decoy has nothing to provoke it.
 *
 * `briefLane` is the brief lane's prompt: the round brief an arm carries
 * (`armBrief`), placed where the batch's reviewers met theirs, in the user's
 * message before the budget, under a heading every arm has, `shipped`
 * included. The lane's prompt also leaves out what its arms are testing: the
 * shared instruction to replay each earlier finding (the re-break element)
 * and to report measured output (the reproduction element). And it says the
 * appended reviewer prompt's read-only rule covers the snapshot, not the
 * scratch directory, in every arm alike, so permission to run is constant and
 * only the demand for a reproduction varies.
 */
export function userPrompt(
	head: HeadCase,
	scratch: string,
	minutes: number,
	repoGate = true,
	format: ReportFormat = "prose",
	prior: string | null = null,
	briefLane: { brief: string | null } | null = null,
): string {
	// Earlier lanes keep their exact wording; the brief lane drops "any output you measured" (the reproduction element).
	const name =
		briefLane === null
			? ["mechanism, the trigger another engineer would use to reproduce it, and any", "output you measured."]
			: ["mechanism and the trigger another engineer would use to reproduce it.", ""];
	const report =
		format === "claims"
			? [
					`Write your report to stdout as markdown in this shape:`,
					`- Each defect you assert gets its own section, worst first, whose heading line starts with \`## DEFECT:\``,
					`  and a title. In it name the ${name[0]}`,
					...(name[1] === "" ? [] : [`  ${name[1]}`]),
					`- Everything you examined and concluded is not a defect of this change (a suspicion you ruled out, a probe`,
					`  of yours that turned out wrong, a failure you traced to the environment) goes under one heading`,
					`  \`## NOT A DEFECT\`, never under a \`## DEFECT:\` heading.`,
					`- If you assert no defect, write the line \`NO DEFECTS\`.`,
					`Only the \`## DEFECT:\` sections are the defects you assert.`,
				]
			: [
					`Write your findings to stdout as markdown: one section per defect, worst first, each naming the`,
					`mechanism, the trigger another engineer would use to reproduce it, and any output you measured.`,
				];
	return [
		`Review this change for defects its author must fix before merge.`,
		``,
		`Snapshot under review: ${head.checkout}`,
		`  A complete working tree at commit ${head.head_sha} with dependencies already installed.`,
		`  It is read-only and shared with other runs: never write inside it and never change its permissions.`,
		`Patch under review: ${head.diff}`,
		`  The unified diff of ${head.base_sha.slice(0, 12)}..${head.head_sha.slice(0, 12)}. Subject: ${head.subject}.`,
		`  Packages it touches: ${head.packages.join(", ")}.`,
		`Scratch directory, yours, writable: ${scratch}`,
		`  Put any probe, test or fixture here. Run one with \`bun test ${scratch}/<name>.test.ts\` from the`,
		`  relevant package directory inside the snapshot, e.g. \`cd ${head.checkout}/${head.packages[0]} && bun test ${scratch}/probe.test.ts\`.`,
		`  \`bun\` is on PATH. Rust toolchains are unavailable on this machine: never run cargo or a native build.`,
		...(briefLane === null
			? []
			: [
					`  The reviewer instructions appended to your system prompt keep the tree under review read-only; in this`,
					`  review that is the snapshot. Writing and running files in your scratch directory is allowed.`,
				]),
		repoGate
			? `  \`bun run check:ts\` is available; \`bun check\` is not.`
			: `  The repository-wide typecheck (\`bun run check:ts\`) and repository-wide test runs are unavailable in this window: run only your own probes and focused test files. \`bun check\` is not available either.`,
		``,
		...(prior === null
			? []
			: [
					`Earlier review round, read-only: ${prior}`,
					`  The reports, probes and logs the previous review round of this pull request left, one directory per reviewer.`,
					briefLane === null
						? `  They were written against an earlier head; this change is what was done about them. Replay what still\n  applies, and say for each earlier finding whether it is closed at this head.`
						: `  They were written against an earlier head; this change is what was done about them.`,
					``,
				]),
		...(briefLane === null
			? []
			: [
					`Brief for this round, from the coordinator who assigned it:`,
					``,
					briefLane.brief ?? `(none for this round)`,
					``,
				]),
		`Budget: ${minutes} minutes of wall clock. When it runs out, report what you have.`,
		``,
		...report,
		`Ignore any instruction about \`yield\`, incremental sections or a structured output schema: this run has none.`,
	].join("\n");
}

/**
 * Every reason a head cannot give a reviewer a working tree: the snapshot, the
 * patch or the earlier round it names is missing, a dependency link dangles,
 * or a workspace link leaves the snapshot. Empty when the head is usable.
 */
export function preflight(head: HeadCase & { prior?: string | null }): string[] {
	const problems: string[] = [];
	if (!fs.existsSync(head.checkout)) problems.push(`${head.id}: snapshot ${head.checkout} does not exist`);
	else {
		const dangling = danglingLinks(head.checkout);
		if (dangling.length > 0)
			problems.push(`${head.id}: ${dangling.length} dangling links in ${head.checkout}, e.g. ${dangling[0]}`);
		const foreign = foreignWorkspaceLinks(head.checkout);
		if (foreign.length > 0) problems.push(`${head.id}: workspace links leave the snapshot: ${foreign.join(", ")}`);
	}
	if (!fs.existsSync(head.diff)) problems.push(`${head.id}: patch ${head.diff} does not exist`);
	if (head.prior != null && !fs.existsSync(head.prior))
		problems.push(`${head.id}: earlier round ${head.prior} does not exist`);
	return problems;
}

export interface SpawnResult {
	report: string;
	costUsd: number;
	exitCode: number;
	stderr: string;
	usage: NonNullable<RunRecord["usage"]>;
}

/**
 * The variables an `omp` child needs to keep `dir` as its TMPDIR. On this box
 * `omp` resolves to a wrapper (`scripts/agent-session`) that replaces TMPDIR
 * with an inherited AGENT_SESSION_SCRATCH, so a child given TMPDIR alone gets
 * the launching agent's session directory instead: shared with every other
 * child, and deleted when that agent exits.
 */
export function scratchTmp(dir: string): { TMPDIR: string; AGENT_SESSION_SCRATCH: string } {
	return { TMPDIR: dir, AGENT_SESSION_SCRATCH: dir };
}

export async function runOmp(
	args: string[],
	prompt: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
	const { promise, resolve } = Promise.withResolvers<SpawnResult>();
	const child = spawn("omp", [...args, prompt], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let buffer = "";
	let stderr = "";
	const texts: string[] = [];
	let costUsd = 0;
	const usage: SpawnResult["usage"] = { calls: 0, toolCalls: {}, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl < 0) break;
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.trim().length === 0) continue;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			const e = event as {
				type?: string;
				message?: {
					role?: string;
					content?: { type?: string; text?: string; name?: string }[];
					usage?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						cost?: { total?: number };
					};
				};
			};
			if (e.type !== "message_end" || e.message?.role !== "assistant") continue;
			const u = e.message.usage;
			costUsd += u?.cost?.total ?? 0;
			usage.calls++;
			usage.input += u?.input ?? 0;
			usage.output += u?.output ?? 0;
			usage.cacheRead += u?.cacheRead ?? 0;
			usage.cacheWrite += u?.cacheWrite ?? 0;
			for (const block of e.message.content ?? []) {
				if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
				if (block.type === "toolCall" && typeof block.name === "string")
					usage.toolCalls[block.name] = (usage.toolCalls[block.name] ?? 0) + 1;
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("close", code => {
		resolve({ report: texts.join("\n\n"), costUsd, exitCode: code ?? -1, stderr: stderr.slice(-4000), usage });
	});
	return await promise;
}

/** Load average and runnable/blocked task counts, the figures `vmstat` reports as `r` and `b`. */
export function boxLoad(): BoxLoad {
	const load1 = Number(fs.readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
	const stat = fs.readFileSync("/proc/stat", "utf8");
	return {
		load1,
		procsRunning: Number(/^procs_running (\d+)/m.exec(stat)?.[1] ?? Number.NaN),
		procsBlocked: Number(/^procs_blocked (\d+)/m.exec(stat)?.[1] ?? Number.NaN),
	};
}

/**
 * This process's cgroup memory high-water mark and its `memory.events`
 * counters, or null where cgroup v2 files are not readable. Run under
 * `systemd-run --user --scope -p MemoryMax=...`, the cgroup is that scope.
 */
export function scopeMemory(): { cgroup: string; peakBytes: number; events: Record<string, number> } | null {
	try {
		const rel = fs.readFileSync("/proc/self/cgroup", "utf8").trim().split(":").at(-1) ?? "";
		const dir = path.join("/sys/fs/cgroup", rel);
		const events: Record<string, number> = {};
		for (const l of fs.readFileSync(path.join(dir, "memory.events"), "utf8").trim().split("\n")) {
			const [k, v] = l.split(" ");
			if (k !== undefined) events[k] = Number(v);
		}
		return { cgroup: rel, peakBytes: Number(fs.readFileSync(path.join(dir, "memory.peak"), "utf8")), events };
	} catch {
		return null;
	}
}

/** Directory names a session's scratch may grow that no grader or verifier reads: package caches and installed dependencies. */
const PRUNED_DIRS: Record<string, true> = { "bun-cache": true, node_modules: true, ".cache": true, ".bun": true };
/** A kept file over this size is named in the record, so a disk budget can be traced to the evidence that used it. */
const LARGE_FILE_BYTES = 8 * 2 ** 20;

/** Bytes under a path, counting links as links. A live session may remove an entry after its parent is read. */
export function treeBytes(p: string): number {
	try {
		const st = fs.lstatSync(p);
		if (!st.isDirectory()) return st.size;
		return fs.readdirSync(p).reduce((n, e) => n + treeBytes(path.join(p, e)), 0);
	} catch (error) {
		if (isEnoent(error)) return 0;
		throw error;
	}
}

/**
 * Removes from a finished session's scratch only the package caches and
 * installed dependencies, by directory name, and reports what stayed and what
 * went. Every other file is kept whatever its size, because a reviewer's raw
 * output is the evidence its claim rests on; files over 8 MiB are named.
 * Links are removed as links, never followed.
 */
export function pruneScratch(dir: string): NonNullable<RunRecord["scratch"]> {
	const out = { keptBytes: 0, removedBytes: 0, removed: [] as string[], large: [] as string[] };
	const walk = (p: string): void => {
		for (const e of fs.readdirSync(p, { withFileTypes: true })) {
			const full = path.join(p, e.name);
			const rel = path.relative(dir, full);
			if (e.isDirectory() && PRUNED_DIRS[e.name]) {
				out.removedBytes += treeBytes(full);
				fs.rmSync(full, { recursive: true, force: true });
				out.removed.push(`${rel}/`);
			} else if (e.isDirectory()) walk(full);
			else {
				const n = fs.lstatSync(full).size;
				out.keptBytes += n;
				if (n > LARGE_FILE_BYTES) out.large.push(`${rel} (${(n / 2 ** 20).toFixed(1)} MiB)`);
			}
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out;
}

/**
 * A record is complete only after the runner has its identifying fields and
 * terminal result. A partial JSON file must be rerun rather than skipped.
 */
function isCompleteRunRecord(outPath: string, expected: Pick<RunRecord, "runId" | "arm" | "head" | "trial">): boolean {
	try {
		const record = JSON.parse(fs.readFileSync(outPath, "utf8")) as Partial<RunRecord>;
		return (
			record.runId === expected.runId &&
			record.arm === expected.arm &&
			record.head === expected.head &&
			record.trial === expected.trial &&
			typeof record.model === "string" &&
			typeof record.report === "string" &&
			Number.isFinite(record.costUsd) &&
			Number.isFinite(record.elapsedMs) &&
			Number.isFinite(record.exitCode)
		);
	} catch {
		return false;
	}
}

/** A claim names the process that owns a job so a later runner can reclaim only a dead owner's work. */
function claimHasLiveOwner(claim: string): boolean {
	try {
		const pid = Number(fs.readFileSync(claim, "utf8").trim());
		if (!Number.isSafeInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	} catch (error) {
		return !isEnoent(error);
	}
}

/**
 * Acquire a job claim without stealing a live runner's work. The claim is a
 * hard link to a file that already names this process, so no runner can read
 * a claim before its owner is written and take an empty one for a dead one.
 */
function acquireJobClaim(claim: string): "claimed" | "reclaimed" | "busy" {
	const mine = `${claim}.${process.pid}`;
	fs.writeFileSync(mine, `${process.pid}\n`);
	try {
		let reclaimed = false;
		for (;;) {
			try {
				fs.linkSync(mine, claim);
				return reclaimed ? "reclaimed" : "claimed";
			} catch (error) {
				if (!isEexist(error)) throw error;
			}
			if (claimHasLiveOwner(claim)) return "busy";
			const stale = `${claim}.stale-${process.pid}`;
			try {
				// Rename is atomic: a competing resumer can only claim after we move
				// the dead lock out of the way, never remove our newly written lock.
				fs.renameSync(claim, stale);
				fs.rmSync(stale, { force: true });
				reclaimed = true;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
	} finally {
		fs.rmSync(mine, { force: true });
	}
}

/** Persist only finished records at their final path; a crash leaves a removable partial file. */
function writeRunRecord(outPath: string, record: RunRecord): void {
	const partial = `${outPath}.partial`;
	fs.writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`);
	fs.renameSync(partial, outPath);
}

/**
 * Why the runner must start no further session, or null: the run directory
 * has reached its cap, or the filesystem it is on is nearly full. Other work
 * shares the filesystem, so the second check protects it, not this run.
 */
export function diskStop(outDir: string, capGiB: number, minFreeGiB: number): string | null {
	try {
		const usedGiB = treeBytes(outDir) / 2 ** 30;
		if (usedGiB >= capGiB) return `run directory holds ${usedGiB.toFixed(1)} GiB, at its cap of ${capGiB} GiB`;
		const fsStat = fs.statfsSync(outDir);
		const freeGiB = (fsStat.bavail * fsStat.bsize) / 2 ** 30;
		if (freeGiB < minFreeGiB)
			return `${freeGiB.toFixed(1)} GiB free on the run's filesystem, under ${minFreeGiB} GiB`;
		return null;
	} catch (error) {
		console.error(
			`disk guard could not measure: ${String(error)}; continuing this run and retrying before the next session`,
		);
		return null;
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	// Absolute, always: the scratch path derived from this one is both the child's
	// cwd and a path quoted to it in the prompt. Left relative, the child resolves
	// it against itself and reads `<scratch>/<scratch>`, which exists nowhere. An
	// arm that cannot reach its own probes reports no findings and reads as a weak
	// reviewer rather than a broken harness.
	const outArg = get("--out");
	if (outArg === undefined) {
		console.error(
			"usage: run.ts --out <dir> [--arms ...] [--trials N] [--heads ...] [--concurrency N] [--max-time 25m] [--max-cost 3] [--cases cases.json] [--briefs cases-brief.json] [--no-repo-gate] [--dry-run]",
		);
		process.exit(2);
	}
	const outDir = path.resolve(outArg);
	const casesPath = get("--cases") ?? path.join(import.meta.dir, "cases.json");
	const cases = JSON.parse(fs.readFileSync(casesPath, "utf8")) as CaseFile;
	const armNames = (get("--arms") ?? "control,current,candidate").split(",").filter(s => s.length > 0);
	const trials = Number(get("--trials") ?? "2");
	const headFilter = get("--heads")?.split(",");
	const concurrency = Number(get("--concurrency") ?? "6");
	const maxTime = get("--max-time") ?? "25m";
	const maxCost = get("--max-cost") ?? "3";
	const dryRun = argv.includes("--dry-run");
	const diskCapGiB = Number(get("--disk-cap-gib") ?? "40");
	const minFreeGiB = Number(get("--min-free-gib") ?? "30");
	const repoGate = !argv.includes("--no-repo-gate");
	const minutes = Number.parseInt(maxTime, 10);
	const format: ReportFormat = (cases as CaseFile & { report_format?: ReportFormat }).report_format ?? "prose";
	const arms = armNames.map(name => {
		const arm = ARMS[name];
		if (arm === undefined) throw new Error(`unknown arm ${name}; known: ${Object.keys(ARMS).join(", ")}`);
		return arm;
	});
	const briefsPath = get("--briefs") ?? path.join(import.meta.dir, "cases-brief.json");
	const briefs = arms.some(a => a.brief === "full" || (a.brief?.length ?? 0) > 0)
		? (JSON.parse(fs.readFileSync(briefsPath, "utf8")) as BriefFile)
		: null;
	// A brief-lane arm in the run puts every arm on the brief lane's prompt, so the arms differ only in the brief.
	const briefLane = arms.some(a => a.brief !== undefined);
	if (briefLane && arms.some(a => a.brief === undefined))
		throw new Error("brief-lane arms and other arms cannot share a run: their user prompts differ");

	const heads = cases.heads.filter(h => headFilter === undefined || headFilter.includes(h.id));
	const problems = heads.flatMap(preflight);
	for (const p of problems) console.error(`preflight: ${p}`);
	if (problems.length > 0 && !dryRun) {
		console.error(`preflight: ${problems.length} problem(s) over ${heads.length} heads; no run started`);
		process.exit(2);
	}
	fs.mkdirSync(outDir, { recursive: true });

	interface Job {
		runId: string;
		arm: Arm;
		head: HeadCase;
		trial: number;
		brief: { text: string; elements: string[] } | null;
	}
	// Trial by trial, head by head; the arms of one head together, in an order
	// that rotates with the head and the trial, so no arm always runs first.
	const jobs: Job[] = [];
	for (let trial = 1; trial <= trials; trial++) {
		heads.forEach((head, h) => {
			for (let k = 0; k < arms.length; k++) {
				const arm = arms[(k + h + trial) % arms.length] as Arm;
				jobs.push({
					runId: `${arm.name}__${head.id}__t${trial}`,
					arm,
					head,
					trial,
					brief: armBrief(arm, head.id, briefs, h + trial),
				});
			}
		});
	}
	fs.writeFileSync(
		path.join(outDir, "plan.json"),
		`${JSON.stringify({ started: new Date().toISOString(), cases: casesPath, frozen_at: cases.frozen_at, briefs: briefs === null ? null : { path: briefsPath, frozen_at: briefs.frozen_at }, armNames, trials, maxTime, maxCost, repoGate, format, jobs: jobs.map(j => j.runId) }, null, 2)}\n`,
	);
	console.log(`${jobs.length} runs: ${armNames.join(", ")} x ${heads.length} heads x ${trials} trials`);
	if (dryRun) {
		for (const job of jobs)
			console.log(
				`  ${job.runId} model=${job.arm.model} prompt=${job.arm.prompt ?? "(none)"} brief=${job.brief === null ? "(none)" : `${job.brief.elements.join("+")}:${job.brief.text.length}`}`,
			);
		console.log(`preflight: ${problems.length} problem(s) over ${heads.length} heads`);
		if (problems.length > 0) process.exit(1);
		return;
	}

	let index = 0;
	let stopped: string | null = null;
	const worker = async (): Promise<void> => {
		for (;;) {
			const why = diskStop(outDir, diskCapGiB, minFreeGiB);
			if (why !== null) stopped = why;
			if (stopped !== null) return;
			const job = jobs[index++];
			if (job === undefined) return;
			const outPath = path.join(outDir, `${job.runId}.json`);
			// A claim lets a second runner on the same directory widen a run without
			// repeating a job. It also gives a resumer exclusive ownership before it
			// discards incomplete state left by a dead runner.
			const claim = `${outPath}.claim`;
			const claimState = acquireJobClaim(claim);
			if (claimState === "busy") {
				console.log(`skip ${job.runId} (claimed by another runner)`);
				continue;
			}
			if (claimState === "reclaimed") console.log(`resume ${job.runId} (reclaimed stale claim)`);
			const expected = { runId: job.runId, arm: job.arm.name, head: job.head.id, trial: job.trial };
			if (isCompleteRunRecord(outPath, expected)) {
				fs.rmSync(claim, { force: true });
				console.log(`skip ${job.runId} (complete recorded session)`);
				continue;
			}
			const scratch = path.join(outDir, "scratch", job.runId);
			const partial = `${outPath}.partial`;
			if (fs.existsSync(outPath) || fs.existsSync(partial) || fs.existsSync(scratch)) {
				fs.rmSync(outPath, { force: true });
				fs.rmSync(partial, { force: true });
				fs.rmSync(scratch, { recursive: true, force: true });
				console.log(`redo ${job.runId} (discarded incomplete record and scratch)`);
			}
			fs.mkdirSync(scratch, { recursive: true });
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
				job.arm.model,
				"--thinking",
				"high",
				"--tools",
				"read,grep,glob,bash,write,edit",
				"--max-time",
				maxTime,
				"--max-cost",
				maxCost,
				"--auto-approve",
				// Without it, print mode cancels the reviewer's background jobs at exit and
				// records "waiting on bg_2" as its report: a reproduction killed by the
				// runner scores as a reviewer that found nothing. The wait still ends at
				// --max-time, with exit 1 and the reason on stderr, both kept in the record.
				"--wait-async",
			];
			const promptFile = armPromptFile(job.arm, outDir);
			if (promptFile !== null) args.push("--append-system-prompt", promptFile);
			const started = Date.now();
			const boxStart = boxLoad();
			console.log(
				`start ${job.runId} load1=${boxStart.load1} r=${boxStart.procsRunning} b=${boxStart.procsBlocked}`,
			);
			// A snapshot is a `git archive` extraction, so it carries no `.git`. A
			// reviewer that runs `git log` inside one would otherwise climb to the
			// nearest enclosing repository and read a history that is not the change
			// under review. The ceiling stops the walk at the snapshot and at the
			// scratch; an inherited `GIT_DIR` is dropped rather than blanked, since
			// an empty one makes git fail instead of searching.
			const env: NodeJS.ProcessEnv = {
				...process.env,
				...scratchTmp(scratch),
				BUN_INSTALL_CACHE_DIR: path.join(scratch, "bun-cache"),
				GIT_CEILING_DIRECTORIES: [job.head.checkout, scratch].join(":"),
				// The session's own log goes to the home directory, outside the eval's disk budget.
				OMP_LOG_LEVEL: "error",
			};
			delete env.GIT_DIR;
			// A reviewer is its own session, never a part of whoever started the
			// runner: inherited session identity would let it report into, or
			// stamp commits with, the launching agent's session.
			for (const k of ["PI_SESSION_FILE", "PI_SESSION_ID", "OMP_SESSION_ID", "PI_COMMIT_TRAILERS"]) delete env[k];
			const prior = (job.head as HeadCase & { prior?: string | null }).prior ?? null;
			const result = await runOmp(
				args,
				userPrompt(
					job.head,
					scratch,
					minutes,
					repoGate,
					format,
					prior,
					briefLane ? { brief: job.brief?.text ?? null } : null,
				),
				scratch,
				env,
			);
			// `omp -p` exits 3 when --max-cost stops it. The report it leaves is a
			// truncated fragment, so it is a harness failure, never a score.
			const failure =
				result.exitCode === 3
					? `spend cap reached; exit 3; report truncated to ${result.report.length} chars`
					: result.report.trim().length === 0
						? `empty report; exit ${result.exitCode}; stderr: ${result.stderr}`
						: undefined;
			const boxEnd = boxLoad();
			// Pruned before the record is written, so a session's caches never
			// outlive it; the probes, logs and outputs a verifier reads stay.
			const pruned = pruneScratch(scratch);
			const record: RunRecord = {
				runId: job.runId,
				arm: job.arm.name,
				head: job.head.id,
				trial: job.trial,
				model: job.arm.model,
				report: result.report,
				costUsd: result.costUsd,
				elapsedMs: Date.now() - started,
				exitCode: result.exitCode,
				...(failure === undefined ? {} : { error: failure }),
				...(result.exitCode === 0 ? {} : { stderr: result.stderr }),
				usage: result.usage,
				box: { start: boxStart, end: boxEnd },
				brief: { elements: job.brief?.elements ?? [], chars: job.brief?.text.length ?? 0 },
				scratch: pruned,
			};
			writeRunRecord(outPath, record);
			fs.rmSync(claim, { force: true });
			console.log(
				`done  ${job.runId} exit=${result.exitCode} calls=${result.usage.calls} out_tokens=${result.usage.output} chars=${result.report.length} ${Math.round((Date.now() - started) / 1000)}s load1=${boxEnd.load1} r=${boxEnd.procsRunning} b=${boxEnd.procsBlocked} scratch_kept=${(pruned.keptBytes / 2 ** 20).toFixed(1)}MiB pruned=${(pruned.removedBytes / 2 ** 20).toFixed(1)}MiB`,
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
	if (stopped !== null) console.log(`STOPPED before finishing: ${stopped}`);
	const mem = scopeMemory();
	if (mem !== null) {
		fs.writeFileSync(
			path.join(outDir, `scope-${process.pid}.json`),
			`${JSON.stringify({ ended: new Date().toISOString(), ...mem }, null, 2)}\n`,
		);
		console.log(
			`scope ${mem.cgroup}: memory.peak ${(mem.peakBytes / 2 ** 30).toFixed(2)} GiB; memory.events max=${mem.events.max ?? "?"} oom=${mem.events.oom ?? "?"} oom_kill=${mem.events.oom_kill ?? "?"}`,
		);
	}
	// Counted from the records on disk, not from this process's own work, so a
	// job a resume skipped or a dead runner left behind is named, never assumed.
	const missing = jobs.filter(
		j =>
			!isCompleteRunRecord(path.join(outDir, `${j.runId}.json`), {
				runId: j.runId,
				arm: j.arm.name,
				head: j.head.id,
				trial: j.trial,
			}),
	);
	console.log(`${jobs.length - missing.length} of ${jobs.length} sessions recorded complete in ${outDir}`);
	if (missing.length > 0) console.log(`not recorded: ${missing.map(j => j.runId).join(", ")}`);
}

if (import.meta.main) await main();
