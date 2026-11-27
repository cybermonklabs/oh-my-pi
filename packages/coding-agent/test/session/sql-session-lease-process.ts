/**
 * Another omp-like process for the SQL session claim tests (see
 * `LeaseProcess` in `sql-session-lease-fixture.ts`). argv[2] is a JSON
 * `LeaseProcessConfig`; the process opens its own store with claims on, then
 * answers each JSON command line on stdin with one JSON report line:
 *
 * - `{ op: "claim", sessionId, path, read? }`: claim the session at open, as a resume does; `held`,
 *   and with `read` the session's stored content read right after the claim.
 * - `{ op: "release", sessionId }`: give that claim up and drain.
 * - `{ op: "hold", file, sessionDir, subagent? }`: open the session file, claim it at open and write one
 *   turn; with `subagent`, also open that subagent transcript (under the session's artifacts directory).
 * - `{ op: "open", file, sessionDir }`: open the session file as the held session without claiming it, as
 *   inspection does; its first write claims it.
 * - `{ op: "append", text, contested? }`: write one more turn to the held session; `error` names a
 *   failure. With `contested`, another store that claims nothing (an older build) appends an entry to
 *   the session first, and again right before each full write, so the append and every full write meet
 *   a changed file.
 * - `{ op: "appendSubagent", text }`: the same for the held subagent transcript.
 * - `{ op: "closeHeld" }`: close the held session's manager, leaving the subagent transcript's open.
 * - `{ op: "openSubagent", file }`: close the held subagent transcript's manager, if any, and open `file` as the
 *   held subagent transcript instead.
 * - `{ op: "rewrite", contested? }`: publish the held session's whole transcript again
 *   (`rewriteEntries`); with `contested`, another store that claims nothing (an older build) appends
 *   an entry to the session right before each full write, so every one meets a changed file.
 * - `{ op: "resume", args, cwd, sessionStart?, settings?, turns? }`: run the CLI's `createSessionManager`
 *   on `args` with `settings` (with the store as the default storage), optionally start an agent
 *   session whose extension records the session id at `session_start`, then write `turns` turns (1).
 * - `{ op: "defaultSessionDir", cwd }`: the session directory this process's home gives `cwd`.
 * - `{ op: "create", cwd, sessionDir }`: start a new session there and write one turn, claiming it at
 *   that first write.
 * - `{ op: "switch", via, cwd, scratchDir, file?, dir? }`: start an agent session on a new session in
 *   `scratchDir`, then open `file` with `switchSession` (`via: "switch"`), or the newest session of
 *   `dir` as RPC `open_session` does (`via: "rpc"`), recording every `session_start` and
 *   `session_switch` with the id it saw and when, and the manager's id once a second while it
 *   switches (as an extension's heartbeat reads it), then write one turn.
 *
 * It closes its sessions and exits when stdin ends.
 */
import * as path from "node:path";
import { parseArgs } from "../../src/cli/args";
import { Settings } from "../../src/config/settings";
import { createSessionManager } from "../../src/main";
import { openRpcSession } from "../../src/modes/rpc/rpc-mode";
import { initializeExtensions } from "../../src/modes/runtime-init";
import { createAgentSession } from "../../src/sdk";
import { SessionManager, type SessionPersistenceNotice } from "../../src/session/session-manager";
import { FileSessionStorage, type SessionStorage, setDefaultSessionStorage } from "../../src/session/session-storage";
import { SqlSessionStorage } from "../../src/session/sql-session-storage";
import { SQL } from "bun";

interface Config {
	dsn: string;
	table: string;
	leaseTable: string;
	lease?: { expiryMs: number; heartbeatMs: number };
	/** `file`: run on file storage instead, for the paths only it has. */
	storage?: "file";
	/** See `LeaseProcessConfig.holderLookupMs`. */
	holderLookupMs?: number;
}

const config = JSON.parse(process.argv[2] ?? "{}") as Config;
const client = config.storage === "file" ? undefined : new SQL(config.dsn);
const storage: SessionStorage & { refresh?: () => Promise<void> } = client
	? await SqlSessionStorage.create({
			client,
			table: config.table,
			leaseTable: config.leaseTable,
			claims: true,
			...(config.lease ? { lease: config.lease } : {}),
		})
	: new FileSessionStorage();
setDefaultSessionStorage(storage);
if (config.holderLookupMs !== undefined) {
	const lookup = storage.sessionClaimHolder?.bind(storage);
	const delayMs = config.holderLookupMs;
	(storage as { sessionClaimHolder?: SessionStorage["sessionClaimHolder"] }).sessionClaimHolder = async sessionId => {
		await Bun.sleep(delayMs);
		return lookup?.(sessionId);
	};
}

const releases = new Map<string, () => void>();
const managers: SessionManager[] = [];
let held: SessionManager | undefined;
let subagent: SessionManager | undefined;
let notices: SessionPersistenceNotice[] = [];

function report(fields: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(fields)}\n`);
}

function describe(manager: SessionManager): Record<string, unknown> {
	return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), notices };
}

async function writeTurn(manager: SessionManager, text: string): Promise<void> {
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	await manager.flush();
}

/** Write one turn to `manager`, reporting where it went and any failure rather than throwing. */
async function appendTo(manager: SessionManager | undefined, text: string): Promise<Record<string, unknown>> {
	if (!manager) throw new Error("no such session is held");
	let error: string | undefined;
	try {
		await writeTurn(manager, text);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	return { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), notices, error };
}

function adopt(manager: SessionManager): SessionManager {
	managers.push(manager);
	held = manager;
	notices = [];
	manager.onPersistenceNotice(notice => notices.push(notice));
	return manager;
}

/** An agent session on `manager` whose extension records each session event with the id it saw. */
async function startAgentSession(manager: SessionManager, cwd: string) {
	const events: Array<{ type: string; id: string; at: number }> = [];
	const { session } = await createAgentSession({
		cwd,
		sessionManager: manager,
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		disableExtensionDiscovery: true,
		settings: Settings.isolated({ "compaction.enabled": false }),
		extensions: [
			pi => {
				pi.on("session_start", (_event, ctx) => {
					events.push({ type: "session_start", id: ctx.sessionManager.getSessionId(), at: Date.now() });
				});
				pi.on("session_switch", (_event, ctx) => {
					events.push({ type: "session_switch", id: ctx.sessionManager.getSessionId(), at: Date.now() });
				});
			},
		],
	});
	await initializeExtensions(session, { reportSendError: () => {}, reportRuntimeError: () => {} });
	return { session, events };
}

async function resume(command: Record<string, unknown>): Promise<Record<string, unknown>> {
	const args = command.args as string[];
	const cwd = String(command.cwd);
	const started = Date.now();
	let stderr = "";
	const write = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return write(chunk, ...rest);
	}) as typeof process.stderr.write;
	let manager: SessionManager | undefined;
	try {
		manager = await createSessionManager(
			parseArgs(args),
			cwd,
			Settings.isolated((command.settings as Record<string, unknown> | undefined) ?? {}),
		);
	} finally {
		process.stderr.write = write;
	}
	if (!manager) throw new Error("createSessionManager returned no session");
	adopt(manager);
	const elapsedMs = Date.now() - started;
	let sessionStartId: string | undefined;
	if (command.sessionStart === true) {
		const { events } = await startAgentSession(manager, cwd);
		sessionStartId = events.find(event => event.type === "session_start")?.id;
	}
	const turns = typeof command.turns === "number" ? command.turns : 1;
	for (let n = 0; n < turns; n++) await writeTurn(manager, `resumed by ${process.pid}${n > 0 ? ` (${n + 1})` : ""}`);
	return { ...describe(manager), sessionStartId, elapsedMs, stderr };
}

/**
 * Another store that claims nothing (an older build), and a hook on this
 * process's store that has it append an entry to `file` right before each
 * full write of `file`. Returns that append.
 */
async function contest(file: string): Promise<() => Promise<void>> {
	const other: SessionStorage =
		config.storage === "file"
			? new FileSessionStorage()
			: await SqlSessionStorage.create({
					client: new SQL(config.dsn),
					table: config.table,
					leaseTable: config.leaseTable,
				});
	let n = 0;
	const foreign = async () => {
		n++;
		const writer = other.openWriter(file);
		await writer.append(
			`${JSON.stringify({ type: "message", id: `foreign${n}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: `foreign ${n}`, timestamp: n } })}\n`,
		);
		await writer.close();
		await other.drain();
	};
	const publish = storage.writeTextAtomic.bind(storage);
	storage.writeTextAtomic = async (target, content, options) => {
		if (path.resolve(target) === path.resolve(file)) await foreign();
		return publish(target, content, options);
	};
	// A full rewrite of lines takes the same hook, as one joined body.
	storage.writeLinesAtomic = (target, lines, options) =>
		storage.writeTextAtomic(target, Array.from(lines).join(""), options);
	return foreign;
}

/** The `append` op with `contested`: see the header. */
async function appendContested(text: string): Promise<Record<string, unknown>> {
	const file = held?.getSessionFile();
	if (!held || !file) throw new Error("no session is held");
	await (
		await contest(file)
	)();
	return appendTo(held, text);
}

/** The `rewrite` op: see the header. */
async function rewrite(contested: boolean): Promise<Record<string, unknown>> {
	const manager = held;
	const file = manager?.getSessionFile();
	if (!manager || !file) throw new Error("no session is held");
	if (contested) await contest(file);
	let error: string | undefined;
	try {
		await manager.rewriteEntries();
		await manager.flush();
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	return { ...describe(manager), error };
}

async function switchTo(command: Record<string, unknown>): Promise<Record<string, unknown>> {
	const cwd = String(command.cwd);
	const manager = adopt(SessionManager.create(cwd, String(command.scratchDir), storage));
	const { session, events } = await startAgentSession(manager, cwd);
	const scratchId = manager.getSessionId();
	const started = Date.now();
	// As an extension's heartbeat does: read the manager's id once a second, with no session event.
	const polled = new Set<string>();
	const poll = setInterval(() => polled.add(session.sessionManager.getSessionId()), 1000);
	try {
		if (command.via === "rpc") await openRpcSession(session, String(command.dir));
		else await session.switchSession(String(command.file));
	} finally {
		clearInterval(poll);
	}
	const elapsedMs = Date.now() - started;
	await writeTurn(session.sessionManager, `switched by ${process.pid}`);
	return {
		...describe(session.sessionManager),
		events: events.map(event => ({ type: event.type, id: event.id, afterSwitchStartMs: event.at - started })),
		polled: [...polled],
		scratchId,
		elapsedMs,
	};
}

async function handle(command: Record<string, unknown>): Promise<Record<string, unknown>> {
	switch (command.op) {
		case "claim": {
			const sessionId = String(command.sessionId);
			const file = String(command.path);
			const release = await storage.acquireSessionClaim?.(sessionId, file);
			if (release) releases.set(sessionId, release);
			if (command.read !== true) return { held: Boolean(release) };
			await storage.refresh?.();
			return { held: Boolean(release), content: storage.existsSync(file) ? await storage.readText(file) : null };
		}
		case "release": {
			releases.get(String(command.sessionId))?.();
			releases.delete(String(command.sessionId));
			await storage.drain();
			return {};
		}
		case "open":
			return describe(
				adopt(
					await SessionManager.open(String(command.file), String(command.sessionDir), storage, {
						suppressBreadcrumb: true,
					}),
				),
			);
		case "hold": {
			const manager = adopt(
				await SessionManager.open(String(command.file), String(command.sessionDir), storage, {
					suppressBreadcrumb: true,
				}),
			);
			await manager.claimOpenedSession();
			const wrote = await appendTo(manager, `held by ${process.pid}`);
			if (typeof command.subagent === "string") {
				subagent = await SessionManager.open(command.subagent, undefined, storage, { suppressBreadcrumb: true });
				managers.push(subagent);
			}
			return wrote;
		}
		case "append":
			return command.contested === true
				? appendContested(String(command.text))
				: appendTo(held, String(command.text));
		case "appendSubagent":
			return appendTo(subagent, String(command.text));
		case "closeHeld": {
			await held?.close();
			return { sessionFile: held?.getSessionFile() };
		}
		case "openSubagent": {
			await subagent?.close().catch(() => undefined);
			subagent = await SessionManager.open(String(command.file), undefined, storage, { suppressBreadcrumb: true });
			managers.push(subagent);
			return { sessionFile: subagent.getSessionFile() };
		}
		case "rewrite":
			return rewrite(command.contested === true);
		case "resume":
			return resume(command);
		case "defaultSessionDir":
			return { sessionDir: SessionManager.getDefaultSessionDir(String(command.cwd)) };
		case "create": {
			const manager = adopt(SessionManager.create(String(command.cwd), String(command.sessionDir), storage));
			await manager.ensureOnDisk();
			await writeTurn(manager, `created by ${process.pid}`);
			return describe(manager);
		}
		case "switch":
			return switchTo(command);
		default:
			throw new Error(`unknown command ${JSON.stringify(command.op)}`);
	}
}

report({});
for await (const line of console) {
	if (!line.trim()) continue;
	try {
		report(await handle(JSON.parse(line) as Record<string, unknown>));
	} catch (err) {
		report({ error: err instanceof Error ? err.message : String(err) });
	}
}
for (const manager of managers) await manager.close().catch(() => undefined);
for (const release of releases.values()) release();
await storage.drain().catch(() => undefined);
await client?.end();
process.exit(0);
