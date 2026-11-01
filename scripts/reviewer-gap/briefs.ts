#!/usr/bin/env bun
/**
 * The per-round briefs the batch's reviewers worked under. A review round was
 * a subagent of the coordinating session, and its brief has two parts the
 * coordinator wrote for it: the shared context (the `§ Context` section of the
 * subagent's system prompt) and the assignment (its first user message). Both
 * are kept in the subagent's transcript beside the session.
 *
 *   list     - every transcript in a session directory whose agent id matches
 *              `--match`: start time, model, brief length.
 *   extract  - for every arm of every round in `corpus/claims/`, writes the
 *              verbatim brief to `<store>/<agent>.md` and its index line to
 *              `corpus/briefs.jsonl` (agent, start time, model, sha256, chars).
 *
 * The verbatim text stays out of the repository: it carries the coordinator's
 * paths and links. The index's sha256 pins the text each label was made from.
 *
 * Usage:
 *   bun scripts/reviewer-gap/briefs.ts list --session <dir> [--match <regex>]
 *   bun scripts/reviewer-gap/briefs.ts extract --session <dir> [--store <dir>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadClaimsCorpus } from "./claims-build.ts";

/** Where the verbatim briefs are kept, outside any repository. */
export const BRIEF_STORE = "/mnt/nvme/sami/reviewer-gap-evals/briefs";

export interface Brief {
	agent: string;
	/** The transcript the brief was read from. */
	source: string;
	/** When the subagent's session started: the brief existed then, and nothing the round found did. */
	started_at: string;
	model: string;
	/** The shared context and the assignment, under `## Context` and `## Assignment`. */
	text: string;
}

export interface BriefIndex {
	agent: string;
	started_at: string;
	model: string;
	sha256: string;
	chars: number;
}

interface Line {
	type?: string;
	timestamp?: string;
	model?: string;
	systemPrompt?: string[];
	message?: { role?: string; content?: string | { type?: string; text?: string }[] };
}

function transcriptPath(sessionDir: string, agent: string): string | undefined {
	for (const name of [`${agent}.jsonl`, `${agent}.jsonl.gz`]) {
		const p = path.join(sessionDir, name);
		if (fs.existsSync(p)) return p;
	}
	return undefined;
}

function readTranscript(file: string): Line[] {
	const raw = fs.readFileSync(file);
	const text = file.endsWith(".gz") ? new TextDecoder().decode(Bun.gunzipSync(raw)) : raw.toString("utf8");
	const out: Line[] = [];
	for (const l of text.split("\n")) {
		if (l.trim().length === 0) continue;
		try {
			out.push(JSON.parse(l) as Line);
		} catch {
			// A transcript cut by a kill ends in a partial line; the brief is at its start.
		}
	}
	return out;
}

/** The coordinator-written `§ Context` section of a subagent's system prompt, or "" when it has none. */
export function contextSection(systemPrompt: string): string {
	const marker = "\n§ Context\n";
	const start = systemPrompt.indexOf(marker);
	if (start < 0) return "";
	const body = systemPrompt.slice(start + marker.length);
	const end = body.search(/\n§ [A-Z]/);
	return (end < 0 ? body : body.slice(0, end)).trim();
}

/** The brief of one review subagent, or undefined when its transcript is gone. */
export function readBrief(sessionDir: string, agent: string): Brief | undefined {
	const source = transcriptPath(sessionDir, agent);
	if (source === undefined) return undefined;
	const lines = readTranscript(source);
	const started = lines.find(l => l.type === "session")?.timestamp ?? lines.find(l => l.timestamp)?.timestamp ?? "";
	const model = lines.find(l => l.type === "model_change")?.model ?? "";
	const first = lines.find(l => l.type === "message" && l.message?.role === "user")?.message?.content;
	if (first === undefined) return undefined;
	const assignment =
		typeof first === "string"
			? first
			: first
					.filter(b => b.type === "text")
					.map(b => b.text ?? "")
					.join("\n");
	const context = contextSection((lines.find(l => l.type === "session_init")?.systemPrompt ?? []).join("\n"));
	const text = `## Context\n\n${context}\n\n## Assignment\n\n${assignment.trim()}\n`;
	return { agent, source, started_at: started, model, text };
}

export function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function main(): void {
	const [mode, ...argv] = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const session = get("--session");
	if (session === undefined || (mode !== "list" && mode !== "extract")) {
		console.error("usage: briefs.ts list --session <dir> [--match <regex>] | extract --session <dir> [--store <dir>]");
		process.exit(2);
	}
	if (mode === "list") {
		const match = new RegExp(get("--match") ?? "Review|^Astra|^Claude");
		const rows = fs
			.readdirSync(session)
			.filter(f => /\.jsonl(\.gz)?$/.test(f))
			.map(f => f.replace(/\.jsonl(\.gz)?$/, ""))
			.filter(a => match.test(a))
			.map(a => readBrief(session, a))
			.filter((b): b is Brief => b !== undefined)
			.sort((a, b) => a.started_at.localeCompare(b.started_at));
		for (const b of rows) console.log(`${b.started_at}\t${b.agent}\t${b.model}\t${b.text.length}`);
		return;
	}
	const store = get("--store") ?? BRIEF_STORE;
	const corpus = loadClaimsCorpus(path.join(import.meta.dir, "corpus", "claims"));
	const agents = [...new Set(corpus.rounds.flatMap(r => r.arms.map(a => a.agent)))].sort();
	const index: BriefIndex[] = [];
	const missing: string[] = [];
	fs.mkdirSync(store, { recursive: true });
	for (const agent of agents) {
		const b = readBrief(session, agent);
		if (b === undefined) {
			missing.push(agent);
			continue;
		}
		fs.writeFileSync(path.join(store, `${agent}.md`), b.text);
		index.push({ agent, started_at: b.started_at, model: b.model, sha256: sha256(b.text), chars: b.text.length });
	}
	fs.writeFileSync(
		path.join(import.meta.dir, "corpus", "briefs.jsonl"),
		`${index.map(i => JSON.stringify(i)).join("\n")}\n`,
	);
	console.log(`${index.length} briefs written to ${store}; ${missing.length} missing: ${missing.join(", ")}`);
}

if (import.meta.main) main();
