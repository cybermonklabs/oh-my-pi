/**
 * Fixtures for `session.sql.offboxCheck` tests: the directories a test's
 * sessions live in, and a real check program. The program refuses a session
 * whose cwd or transcript name says "refuse", sleeps 60 s when the cwd says
 * "slow" (past any short timeout a test sets), and logs every run with the
 * arguments, working directory and environment it was given.
 */
import * as fs from "node:fs";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { OffboxCheck } from "@oh-my-pi/pi-coding-agent/session/offbox-check";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { TempDir } from "@oh-my-pi/pi-utils";

const CHECK_SCRIPT = `import * as fs from "node:fs";
import * as path from "node:path";
const [log, cwd, sessionId, sessionFile] = process.argv.slice(2);
const env = { cwd: process.env.OMP_SESSION_CWD, sessionId: process.env.OMP_SESSION_ID, sessionFile: process.env.OMP_SESSION_FILE };
fs.appendFileSync(log, JSON.stringify({ cwd, sessionId, sessionFile, pwd: process.cwd(), env }) + "\\n");
if (cwd.includes("slow")) await Bun.sleep(60_000);
if ((cwd + "\\n" + path.basename(sessionFile)).toLowerCase().includes("refuse")) {
	console.error("no-offbox: REFUSED " + sessionFile + ": test marker");
	process.exit(1);
}
`;

/** One run of the check program, as it logged it. */
export interface CheckRun {
	cwd: string;
	sessionId: string;
	sessionFile: string;
	pwd: string;
	env: { cwd: string; sessionId: string; sessionFile: string };
}

/** A test's directories and its check program, under one temporary directory. */
export class OffboxFixture {
	readonly sessionsRoot: string;
	readonly allowedCwd: string;
	readonly refusedCwd: string;
	readonly slowCwd: string;
	readonly #log: string;
	readonly #script: string;
	readonly #missing: string;

	constructor(tmp: TempDir) {
		this.sessionsRoot = tmp.join("sessions");
		this.allowedCwd = tmp.join("work", "allowed");
		this.refusedCwd = tmp.join("work", "refuse-me");
		this.slowCwd = tmp.join("work", "slow");
		for (const dir of [this.sessionsRoot, this.allowedCwd, this.refusedCwd, this.slowCwd]) {
			fs.mkdirSync(dir, { recursive: true });
		}
		this.#log = tmp.join("check-runs.jsonl");
		this.#script = tmp.join("check.mjs");
		this.#missing = tmp.join("no-such-check");
		fs.writeFileSync(this.#script, CHECK_SCRIPT);
	}

	check(timeoutMs = 60_000): OffboxCheck {
		return { argv: [process.execPath, this.#script, this.#log, "{cwd}", "{sessionId}", "{sessionFile}"], timeoutMs };
	}

	/** A check whose program does not exist. */
	missingCheck(): OffboxCheck {
		return { argv: [this.#missing, "{cwd}"], timeoutMs: 60_000 };
	}

	runs(): CheckRun[] {
		if (!fs.existsSync(this.#log)) return [];
		return fs
			.readFileSync(this.#log, "utf-8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as CheckRun);
	}

	/** The run the check program logs when asked about this session. */
	runFor(cwd: string, sessionId: string, sessionFile: string): CheckRun {
		return { cwd, sessionId, sessionFile, pwd: fs.realpathSync(cwd), env: { cwd, sessionId, sessionFile } };
	}
}

const USAGE: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** One user turn and one assistant reply whose text is `reply`. */
export function converse(manager: SessionManager, reply: string): void {
	manager.appendMessage({ role: "user", content: `asking for ${reply}`, timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "test-model",
		api: "anthropic-messages",
		content: [{ type: "text", text: reply }],
		usage: { ...USAGE, cost: { ...USAGE.cost } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
}
