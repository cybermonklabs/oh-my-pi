/**
 * Under `OMP_SESSION_EXCLUSIVE=1` a session that finds another process holds
 * it stops instead of moving to a sibling, and after that stop it writes
 * nothing: not to a sibling, and not to its own file, which the holder
 * writes. The case that shows it is a size check that passes: the holder's
 * file is still the size the stopped session loaded, so a full write checked
 * against that size would land over the holder's bytes. On every SQL backend
 * the fixture runs (SQLite always; PostgreSQL and MySQL when
 * `OMP_TEST_SQL_POSTGRES_URL` / `OMP_TEST_SQL_MYSQL_URL` name a database) and
 * on file storage, in real processes, since the stop ends the process.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	LEASE_BACKENDS,
	LeaseProcess,
	type LeaseProcessConfig,
	openLeaseDb,
	transcript,
} from "./sql-session-lease-fixture";

// A new id each run: file storage's claim is an OS lock keyed by the session id alone, machine-wide, so two runs of
// this file at once under one fixed id would meet each other's holder.
const ID = Bun.randomUUIDv7();
const EXCLUSIVE = { OMP_SESSION_EXCLUSIVE: "1" };

interface Session {
	dir: string;
	file: string;
	cwd: string;
	config: LeaseProcessConfig;
}

/** The exit code of `process`, once it exits within `ms`. */
async function exitOf(process: LeaseProcess, ms: number): Promise<number | undefined> {
	return Promise.race([process.exited, Bun.sleep(ms).then(() => undefined)]);
}

/**
 * The row on one storage: a holder claims the session and writes a turn; a
 * process under `OMP_SESSION_EXCLUSIVE=1` then opens the session without
 * claiming it, so it loads the holder's file at its current size, and writes
 * one turn. Its first write finds the session held and stops the process.
 */
async function stopsWithoutWriting(
	session: Session,
	dirOf: (name: string) => string,
	contentOf: () => Promise<string | undefined>,
	sessionFiles: () => Promise<string[]>,
): Promise<void> {
	await using holder = await LeaseProcess.start(session.config, dirOf("holder"));
	expect((await holder.run({ op: "hold", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
	const holders = await contentOf();
	// Its store answers the stop's holder lookup after 1.5 s, as a slow database does (the stop waits at most 2 s), so
	// the process lives on after the stop long enough for any write that follows it to land.
	await using sealed = await LeaseProcess.start(
		{ ...session.config, holderLookupMs: 1500 },
		dirOf("sealed"),
		EXCLUSIVE,
	);
	expect((await sealed.run({ op: "open", file: session.file, sessionDir: session.dir })).sessionId).toBe(ID);
	// Nothing writes the file in between: the size the sealed session loaded is the holder's file's size.
	const sizeAtOpen = Buffer.byteLength((await contentOf()) ?? "", "utf8");
	// A process that exits before it answers rejects the command with its stderr; one that answers keeps it.
	const answer = await sealed.run({ op: "append", text: "a turn of the sealed session" }).then(
		done => JSON.stringify(done),
		(err: unknown) => String(err),
	);
	const exitCode = await exitOf(sealed, 20_000);
	const stderr = await sealed.stderr().catch(() => "");
	// The stop exits at once, but a write a deferred-publish store queued before it may still be landing.
	await Bun.sleep(500);
	expect({
		exitCode,
		stopped: `${answer}\n${stderr}`.includes(`Session ${ID} stops (open-elsewhere)`),
		equalSizes: sizeAtOpen === Buffer.byteLength(holders ?? "", "utf8"),
		holdersBytesUnchanged: (await contentOf()) === holders,
		files: await sessionFiles(),
	}).toEqual({
		exitCode: 1,
		stopped: true,
		equalSizes: true,
		holdersBytesUnchanged: true,
		files: [path.basename(session.file)],
	});
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(`OMP_SESSION_EXCLUSIVE=1 on a session another process holds (${adapter})`, () => {
		it("stops at its first write and writes nothing over the holder's file whose size it loaded", async () => {
			await using db = await openLeaseDb(adapter, url ?? "");
			const cwd = db.dir.path();
			const dir = db.dir.join("sessions");
			const file = path.join(dir, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
			const writer = await db.open({ claims: false });
			await writer.writeText(file, transcript(ID, "before", cwd));
			await writer.drain();
			const session = { dir, file, cwd, config: { dsn: db.dsn, table: db.table, leaseTable: db.leaseTable } };
			await stopsWithoutWriting(
				session,
				name => db.dir.join(name),
				async () => (await db.row(file))?.content,
				async () => (await db.paths()).filter(p => p.endsWith(".jsonl")).map(p => path.basename(p)),
			);
		}, 60_000);
	});
}

describe("OMP_SESSION_EXCLUSIVE=1 on a session another process holds (file storage)", () => {
	it("stops at its first write and writes nothing over the holder's file whose size it loaded", async () => {
		using dir = TempDir.createSync("@omp-exclusive-no-write-");
		const cwd = dir.path();
		const sessions = dir.join("sessions");
		const file = path.join(sessions, `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
		await Bun.write(file, transcript(ID, "before", cwd));
		const session = {
			dir: sessions,
			file,
			cwd,
			config: { dsn: "", table: "", leaseTable: "", storage: "file" as const },
		};
		await stopsWithoutWriting(
			session,
			name => dir.join(name),
			async () => (fs.existsSync(file) ? await Bun.file(file).text() : undefined),
			async () => fs.readdirSync(sessions).filter(name => name.endsWith(".jsonl")),
		);
	}, 60_000);
});
