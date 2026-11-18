/**
 * Child process for the signal-exit tests of the session exit record. It opens
 * a session on the store its arguments name, stores one finished turn, creates
 * the `AgentSession` that registers the exit recorder, prints one JSON line
 * (`sessionFile`, and `storedAt` for the queued store) once those writes are
 * stored, and waits for a signal.
 *
 *   session-exit-signal-host.ts queued <work dir> <slow|hang>
 *     An indexed store whose backend keeps each session in a file under the
 *     work dir. Once ready, each backend write takes 500 ms (slow) or never
 *     answers (hang).
 *   session-exit-signal-host.ts postgres <work dir> <url> <table>
 *     SQL storage on PostgreSQL, in <table>.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { postmortem } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

postmortem.installProcessHandlers();

/** Keeps each session in a file under `dir`; while `stall` is set, every write waits on it first. */
class FileBackend implements SessionStorageBackend {
	stall: (() => Promise<void>) | undefined;
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	fileOf(sessionPath: string): string {
		return path.join(this.#dir, encodeURIComponent(sessionPath));
	}

	async #write(update: () => void): Promise<void> {
		await this.stall?.();
		update();
	}

	async init(): Promise<void> {}

	async loadIndex(): Promise<SessionStorageIndexEntry[]> {
		return [];
	}

	async readFull(sessionPath: string): Promise<string | null> {
		const file = this.fileOf(sessionPath);
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	}

	async readSlices(sessionPath: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		const content = Buffer.from((await this.readFull(sessionPath)) ?? "", "utf8");
		const suffixStart = Math.max(0, content.length - suffixBytes);
		return [content.subarray(0, prefixBytes).toString("utf8"), content.subarray(suffixStart).toString("utf8")];
	}

	writeFull(sessionPath: string, content: string): Promise<void> {
		return this.#write(() => fs.writeFileSync(this.fileOf(sessionPath), content));
	}

	append(sessionPath: string, line: string): Promise<void> {
		return this.#write(() => fs.appendFileSync(this.fileOf(sessionPath), line));
	}

	updateSessionTitle(): Promise<void> {
		return this.#write(() => {});
	}

	truncate(sessionPath: string): Promise<void> {
		return this.#write(() => fs.writeFileSync(this.fileOf(sessionPath), ""));
	}

	remove(paths: string[]): Promise<void> {
		return this.#write(() => {
			for (const sessionPath of paths) fs.rmSync(this.fileOf(sessionPath), { force: true });
		});
	}

	move(src: string, dst: string): Promise<void> {
		return this.#write(() => fs.renameSync(this.fileOf(src), this.fileOf(dst)));
	}
}

const [mode, workDir, ...rest] = process.argv.slice(2);
if (!workDir || (mode !== "queued" && mode !== "postgres")) throw new Error("usage: see the file header");

let storage: SessionStorage;
let backend: FileBackend | undefined;
let stall: (() => Promise<void>) | undefined;
if (mode === "queued") {
	const [speed] = rest;
	if (speed !== "slow" && speed !== "hang") throw new Error("queued: expected slow or hang");
	const storeDir = path.join(workDir, "store");
	fs.mkdirSync(storeDir, { recursive: true });
	backend = new FileBackend(storeDir);
	const indexed = new IndexedSessionStorage(backend);
	await indexed.initialize();
	storage = indexed;
	// Real time: the parent signals this process and reads the store after it ends.
	stall = speed === "slow" ? () => Bun.sleep(500) : () => Promise.withResolvers<void>().promise;
} else {
	const [url, table] = rest;
	if (!url || !table) throw new Error("postgres: expected <url> <table>");
	storage = await SqlSessionStorage.create({ client: new SQL(url), table });
}

const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Expected built-in anthropic model to exist");
const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};
const sessionManager = SessionManager.create(workDir, path.join(workDir, "sessions"), storage);
sessionManager.appendMessage({ role: "user", content: "finish", timestamp: Date.now() });
sessionManager.appendMessage(assistant);
await sessionManager.flush();

const authStorage = await AuthStorage.create(path.join(workDir, "auth.db"));
const agent = new Agent({
	initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	convertToLlm,
});
const session = new AgentSession({
	agent,
	sessionManager,
	settings: Settings.isolated({ "compaction.enabled": false }),
	modelRegistry: new ModelRegistry(authStorage),
});

const sessionFile = session.sessionManager.getSessionFile();
if (!sessionFile) throw new Error("Expected a persisted session file");
if (backend) backend.stall = stall;
process.stdout.write(`${JSON.stringify({ sessionFile, storedAt: backend?.fileOf(sessionFile) })}\n`);
// Keeps the process alive until the signal.
setInterval(() => {}, 60_000);
