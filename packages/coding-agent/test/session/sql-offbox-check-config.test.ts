/**
 * `session.sql.offboxCheck` / `OMP_SESSION_SQL_OFFBOX_CHECK` as the start-up
 * install (`resolveSessionStorage`) reads them, on SQLite: set, a session the
 * check refuses stays in local files and writes no row, and the environment
 * wins over the setting; unset or empty, `sql` is unchanged; malformed, the
 * process refuses to start rather than send every session to the database.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
	resolveSessionStorage,
	SessionStorageConfigError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage-config";
import { sessionRowKey } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { converse, OffboxFixture } from "../helpers/offbox-check";

/** `sql` on a SQLite file in `tmp`, plus `extra` settings. */
function sqliteSettings(tmp: TempDir, extra: Record<string, unknown> = {}): Settings {
	const dsnFile = tmp.join("dsn");
	fs.writeFileSync(dsnFile, `sqlite://${tmp.join("sessions.db")}\n`);
	return Settings.isolated({ "session.storage": "sql", "session.sql.dsnFile": dsnFile, ...extra });
}

/** The row keys of the default session table in `tmp`'s database, sorted. */
async function storedKeys(tmp: TempDir): Promise<string[]> {
	const client = new SQL(`sqlite://${tmp.join("sessions.db")}`);
	try {
		const rows = (await client.unsafe("SELECT path FROM omp_session_files")) as Array<{ path: string }>;
		return rows.map(row => String(row.path)).sort();
	} finally {
		await client.end();
	}
}

/** One conversation in a new session of `cwd`, persisted through `storage`; its transcript path. */
async function writeSession(
	storage: SessionStorage,
	cwd: string,
	sessionsRoot: string,
	reply: string,
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(sessionsRoot, path.basename(cwd)), storage);
	converse(manager, reply);
	await manager.flush();
	await manager.close();
	await storage.drain();
	return manager.getSessionFile() as string;
}

/** These two tests run the check program twice; starting it takes seconds on a loaded box. */
const PROCESS_TEST_TIMEOUT_MS = 60_000;

describe("session.sql.offboxCheck at start-up", () => {
	it("leaves sql unchanged when no check is set", async () => {
		using tmp = TempDir.createSync("@omp-offbox-config-");
		const fx = new OffboxFixture(tmp);
		const storage = await resolveSessionStorage({ settings: sqliteSettings(tmp), env: {} });

		const file = await writeSession(storage, fx.refusedCwd, fx.sessionsRoot, "unchecked reply");

		expect(await storedKeys(tmp)).toEqual([sessionRowKey(file)]);
		expect(fs.existsSync(file)).toBe(false);
		expect(fx.runs()).toEqual([]);
	});

	it("leaves sql unchanged when the check is an empty array, or the variable is blank", async () => {
		using tmp = TempDir.createSync("@omp-offbox-config-");
		const fx = new OffboxFixture(tmp);
		const storage = await resolveSessionStorage({
			settings: sqliteSettings(tmp, { "session.sql.offboxCheck": [] }),
			env: { OMP_SESSION_SQL_OFFBOX_CHECK: " " },
		});

		const file = await writeSession(storage, fx.refusedCwd, fx.sessionsRoot, "unchecked reply");

		expect(await storedKeys(tmp)).toEqual([sessionRowKey(file)]);
		expect(fx.runs()).toEqual([]);
	});

	it(
		"keeps a session the check in OMP_SESSION_SQL_OFFBOX_CHECK refuses in local files, with no row",
		async () => {
			using tmp = TempDir.createSync("@omp-offbox-config-");
			const fx = new OffboxFixture(tmp);
			const storage = await resolveSessionStorage({
				settings: sqliteSettings(tmp),
				env: { OMP_SESSION_SQL_OFFBOX_CHECK: JSON.stringify(fx.check().argv) },
			});

			const refused = await writeSession(storage, fx.refusedCwd, fx.sessionsRoot, "refused reply");
			const allowed = await writeSession(storage, fx.allowedCwd, fx.sessionsRoot, "allowed reply");

			expect(await storedKeys(tmp)).toEqual([sessionRowKey(allowed)]);
			expect(fs.readFileSync(refused, "utf-8")).toContain("refused reply");
			expect(fs.existsSync(allowed)).toBe(false);
			expect(fx.runs().map(run => run.sessionFile)).toEqual([refused, allowed]);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"reads the check from session.sql.offboxCheck, the variable winning over it",
		async () => {
			using tmp = TempDir.createSync("@omp-offbox-config-");
			const fx = new OffboxFixture(tmp);
			const fromSetting = await resolveSessionStorage({
				settings: sqliteSettings(tmp, { "session.sql.offboxCheck": [...fx.check().argv] }),
				env: {},
			});
			// The setting names a program that does not exist, which would refuse every session.
			const fromEnv = await resolveSessionStorage({
				settings: sqliteSettings(tmp, { "session.sql.offboxCheck": [...fx.missingCheck().argv] }),
				env: { OMP_SESSION_SQL_OFFBOX_CHECK: JSON.stringify(fx.check().argv) },
			});

			const refused = await writeSession(fromSetting, fx.refusedCwd, fx.sessionsRoot, "refused reply");
			const allowed = await writeSession(fromEnv, fx.allowedCwd, fx.sessionsRoot, "allowed reply");

			expect(await storedKeys(tmp)).toEqual([sessionRowKey(allowed)]);
			expect(fs.readFileSync(refused, "utf-8")).toContain("refused reply");
			expect(fx.runs().map(run => run.sessionFile)).toEqual([refused, allowed]);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it("refuses to start on a malformed check or timeout, naming where it came from", async () => {
		using tmp = TempDir.createSync("@omp-offbox-config-");
		const refusal = async (settings: Settings, env: NodeJS.ProcessEnv): Promise<string> => {
			try {
				await resolveSessionStorage({ settings, env });
			} catch (err) {
				expect(err).toBeInstanceOf(SessionStorageConfigError);
				return (err as Error).message;
			}
			throw new Error("resolveSessionStorage started with a malformed off-box check");
		};

		expect(await refusal(sqliteSettings(tmp, { "session.sql.offboxCheck": ["", "{cwd}"] }), {})).toContain(
			"session.sql.offboxCheck must be a command",
		);
		expect(await refusal(sqliteSettings(tmp, { "session.sql.offboxCheck": ["check", 7] }), {})).toContain(
			"session.sql.offboxCheck must be a command",
		);
		expect(await refusal(sqliteSettings(tmp), { OMP_SESSION_SQL_OFFBOX_CHECK: "no-offbox {cwd}" })).toContain(
			"OMP_SESSION_SQL_OFFBOX_CHECK is not a JSON array",
		);
		expect(
			await refusal(sqliteSettings(tmp), {
				OMP_SESSION_SQL_OFFBOX_CHECK: '["no-offbox"]',
				OMP_SESSION_SQL_OFFBOX_CHECK_TIMEOUT_MS: "0",
			}),
		).toContain("OMP_SESSION_SQL_OFFBOX_CHECK_TIMEOUT_MS must be a positive number");
		expect(
			await refusal(
				sqliteSettings(tmp, { "session.sql.offboxCheck": ["no-offbox"], "session.sql.offboxCheckTimeoutMs": -5 }),
				{},
			),
		).toContain("session.sql.offboxCheckTimeoutMs must be a positive number");
	});
});
