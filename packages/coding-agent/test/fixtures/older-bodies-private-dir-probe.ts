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
import { IndexedSessionStorage } from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { withoutAccountId } from "../helpers/account-id";
import { StreamingMemoryBackend } from "../helpers/memory-session-backend";

/** What the probe prints: what each resume kept and read back, the rewrites stored, the files opened and the warnings logged. */
export interface OlderBodiesProbeResult {
	resumes: Array<{ storeInMemory: boolean; coldEntries: number; readsBack: boolean }>;
	rewritesStored: boolean[];
	/** Files opened under the directory standing for `os.tmpdir()`, relative to it. */
	opened: string[];
	warnings: string[];
	/** The entries of that directory once the probe is done, sorted. */
	underTmp: string[];
}

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

const open = (coldStore: boolean): Promise<SessionManager> =>
	SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true, coldStore });

const whole = await open(false);
const expected = JSON.stringify(whole.getEntries());
await whole.close();
const resumes: OlderBodiesProbeResult["resumes"] = [];
for (let resume = 0; resume < 2; resume++) {
	const manager = await open(true);
	const { storeInMemory, coldEntries } = manager.coldStoreStats();
	resumes.push({ storeInMemory, coldEntries, readsBack: JSON.stringify(manager.getEntries()) === expected });
	await manager.close();
}

const lines = (await Bun.file(file).text()).split(/(?<=\n)/);
const backend = new StreamingMemoryBackend();
const storage = new IndexedSessionStorage(backend);
await storage.initialize();
for (const target of ["/sessions/one.jsonl", "/sessions/two.jsonl"]) {
	await storage.writeLinesAtomic(target, lines, { expectedSize: null });
}
const rewritesStored = [...backend.sessions.values()].map(text => text === lines.join(""));

const result: OlderBodiesProbeResult = {
	resumes,
	rewritesStored,
	opened,
	warnings,
	underTmp: fs.readdirSync(tmp).sort(),
};
process.stdout.write(JSON.stringify(result));
