/**
 * Child process for test/session/older-bodies-private-dir.test.ts, so the
 * warnings a cold store or a spool logs once are this process's first. Takes
 * the scenario (`private`, `owner-only-0300` or `no-account-id`), the
 * directory that stands for `os.tmpdir()`, and a session file whose
 * compaction leaves entries before its cut. Resumes the session twice with
 * the older-entry store and rewrites one store's session twice through the
 * spool, then prints, as JSON, what each resume kept and read back, the files
 * opened under that directory, and the warnings logged.
 */
import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { withoutAccountId } from "../helpers/account-id";

const [scenario, tmp, file] = process.argv.slice(2);
if (!scenario || !tmp || !file) throw new Error("usage: older-bodies-private-dir-probe.ts <scenario> <tmp> <session>");
if (scenario === "no-account-id") withoutAccountId();
spyOn(os, "tmpdir").mockReturnValue(tmp);
const warnings: string[] = [];
spyOn(logger, "warn").mockImplementation(message => {
	warnings.push(message);
});
const opened: string[] = [];
const openSync = fs.openSync;
spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
	if (String(target).startsWith(`${tmp}${path.sep}`)) opened.push(path.relative(tmp, String(target)));
	return Reflect.apply(openSync, fs, [target, ...rest]);
}) as typeof fs.openSync);

/** A backend that keeps each session's text in memory and takes a streamed full write. */
class MemoryBackend implements SessionStorageBackend {
	readonly sessions = new Map<string, string>();
	async init(): Promise<void> {}
	async loadIndex(): Promise<Iterable<SessionStorageIndexEntry>> {
		return [];
	}
	async readFull(target: string): Promise<string | null> {
		return this.sessions.get(target) ?? null;
	}
	async readSlices(): Promise<[string, string]> {
		return ["", ""];
	}
	async writeFull(target: string, content: string): Promise<void> {
		this.sessions.set(target, content);
	}
	async writeFullStream(target: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
		const parts: Uint8Array[] = [];
		for await (const chunk of chunks) parts.push(chunk);
		this.sessions.set(target, Buffer.concat(parts).toString("utf8"));
	}
	async append(target: string, line: string): Promise<void> {
		this.sessions.set(target, (this.sessions.get(target) ?? "") + line);
	}
	async updateSessionTitle(): Promise<void> {}
	async truncate(target: string): Promise<void> {
		this.sessions.set(target, "");
	}
	async remove(paths: string[]): Promise<void> {
		for (const target of paths) this.sessions.delete(target);
	}
	async move(): Promise<void> {}
}

const open = (coldStore: boolean): Promise<SessionManager> =>
	SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true, coldStore });

const whole = await open(false);
const expected = JSON.stringify(whole.getEntries());
await whole.close();
const resumes: Array<{ storeInMemory: boolean; coldEntries: number; readsBack: boolean }> = [];
for (let resume = 0; resume < 2; resume++) {
	const manager = await open(true);
	const { storeInMemory, coldEntries } = manager.coldStoreStats();
	resumes.push({ storeInMemory, coldEntries, readsBack: JSON.stringify(manager.getEntries()) === expected });
	await manager.close();
}

const lines = (await Bun.file(file).text()).split(/(?<=\n)/);
const backend = new MemoryBackend();
const storage = new IndexedSessionStorage(backend);
await storage.initialize();
for (const target of ["/sessions/one.jsonl", "/sessions/two.jsonl"]) {
	await storage.writeLinesAtomic(target, lines, { expectedSize: null });
}
const rewritesStored = [...backend.sessions.values()].map(text => text === lines.join(""));

process.stdout.write(
	JSON.stringify({ resumes, rewritesStored, opened, warnings, underTmp: fs.readdirSync(tmp).sort() }),
);
