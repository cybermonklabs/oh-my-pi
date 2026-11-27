// Measurement probe for can1357/oh-my-pi#20808. Never pushed: it rides a local commit on top of the tree under
// test, and each `it` prints PROBE lines into the Job's log. Nothing here asserts.
import { Database } from "bun:sqlite";
import { it } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import { remember } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import { openDatabase } from "@oh-my-pi/pi-mnemopi/db";

function stateFor(db: Database, sessionId: string, limit: number): BeamMemoryState {
	const state = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "a",
		authorType: "user",
		channelId: "c",
		useCloud: false,
		eventEmitter: () => {},
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: limit,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	} as unknown as BeamMemoryState;
	return state;
}

const rows = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM working_memory").get() as { n: number }).n;
const entries = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM fts_working").get() as { n: number }).n;

it("sqlite build", () => {
	const db = new Database(":memory:");
	const version = (db.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
	let lo = 1;
	let hi = 1_000_000;
	const accepts = (n: number) => {
		try {
			db.prepare(`SELECT 1 WHERE 1 IN (${Array.from({ length: n }, () => "?").join(",")})`).all(
				...Array.from({ length: n }, (_, i) => i),
			);
			return true;
		} catch {
			return false;
		}
	};
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		if (accepts(mid)) lo = mid;
		else hi = mid;
	}
	console.log(`PROBE build bun=${Bun.version} sqlite=${version} largest-accepted-parameters=${lo} first-refused=${hi}`);
	db.close();
});

it("the body's repro: three rows, a fresh row with no id, limit 2, one write", () => {
	const db = new Database(":memory:");
	initBeam(db);
	const now = new Date().toISOString();
	for (const id of ["wm-1", "wm-2", "wm-3"]) {
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run(id, `content of ${id}`, now);
	}
	db.prepare("INSERT INTO working_memory (rowid, content, timestamp, session_id) VALUES (?, ?, ?, 'default')").run(
		10 * 2 ** 37 + 1,
		"an fts5 index page read back as a memory",
		now,
	);
	remember(stateFor(db, "default", 2), "the write that runs the trim");
	console.log(`PROBE repro rows left, limit is 2: ${rows(db)}`);
	db.close();
});

it("six writes, limit 2, a row with no id: fresh timestamp and one that sorts above every write", () => {
	for (const shape of ["fresh", "9999"] as const) {
		const db = openDatabase(":memory:");
		initBeam(db);
		const now = new Date().toISOString();
		for (const id of ["wm-1", "wm-2", "wm-3"]) {
			db.run("INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 's')", [
				id,
				`content of ${id}`,
				now,
			]);
		}
		db.run("INSERT INTO working_memory (rowid, content, timestamp, session_id) VALUES (1374389534721, 'no id', ?, 's')", [
			shape === "fresh" ? now : "9999-12-31T23:59:59.999Z",
		]);
		const state = stateFor(db, "s", 2);
		const counts: number[] = [];
		for (let i = 1; i <= 6; i++) {
			remember(state, `write ${i}`);
			counts.push(rows(db));
		}
		console.log(`PROBE six ${shape}: rows after each of six writes: ${counts.join(", ")}`);
		db.close();
	}
});

// A stalled bank: limit 1000 (the default), one row with no id whose timestamp sorts above every later write,
// N rows with ids spread over `fromHours`..`toHours` ago, and one row with an id 25 hours old.
function stalledBank(n: number, fromHours: number, toHours: number, dropTrigger: boolean): Database {
	const db = openDatabase(":memory:");
	initBeam(db);
	if (dropTrigger) db.run("DROP TRIGGER wm_ad");
	const now = Date.now();
	const step = Math.floor(((fromHours - toHours) * 3_600_000) / n);
	db.run(
		`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
		 INSERT INTO working_memory (id, content, source, timestamp, session_id)
		 SELECT 'wm-' || i, 'memory ' || i, 'test', strftime('%Y-%m-%dT%H:%M:%fZ', (? - ? - (? - i) * ?) / 1000.0, 'unixepoch'), 's' FROM seq`,
		[n, now, toHours * 3_600_000, n, step],
	);
	db.run("INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES ('wm-expired', 'old', 'test', ?, 's')", [
		new Date(now - 25 * 3_600_000).toISOString(),
	]);
	db.run(
		"INSERT INTO working_memory (rowid, content, timestamp, session_id) VALUES (1374389534721, 'no id', '9999-12-31T23:59:59.999Z', 's')",
	);
	return db;
}

function drain(label: string, db: Database, calls: number): void {
	const state = stateFor(db, "s", 1000);
	const parts = [`PROBE ${label} rows before=${rows(db)} fts entries=${entries(db)}`];
	for (let call = 1; call <= calls; call++) {
		const before = rows(db);
		const t0 = performance.now();
		remember(state, `write ${call}`);
		const ms = performance.now() - t0;
		parts.push(`call ${call}: deleted=${before + 1 - rows(db)} in ${ms.toFixed(0)} ms, rows after=${rows(db)}`);
	}
	console.log(parts.join(" | "));
	db.close();
}

for (const n of [2000, 4000, 8000]) {
	it(`exposure: stalled bank, ${n} rows inside the TTL`, () => {
		drain(`exposure inside-ttl N=${n}`, stalledBank(n, 23, 0, false), 3);
	});
}

for (const n of [2000, 4000, 8000]) {
	it(`exposure: stalled bank, ${n} rows past the TTL`, () => {
		drain(`exposure past-ttl N=${n}`, stalledBank(n, 48, 25, false), 2);
	});
}

it("attribution: stalled bank, 8000 rows inside the TTL, wm_ad dropped", () => {
	drain("attribution inside-ttl N=8000 no-wm_ad", stalledBank(8000, 23, 0, true), 2);
});

for (const n of [62_501, 62_502]) {
	it(`parameter limit: limit 2, ${n} rows, graph_edges present, wm_ad dropped`, () => {
		const db = openDatabase(":memory:");
		initBeam(db);
		db.run("CREATE TABLE IF NOT EXISTS graph_edges (source TEXT, target TEXT, kind TEXT)");
		db.run("DROP TRIGGER wm_ad");
		const ts = new Date(Date.now() - 3_600_000).toISOString();
		db.run(
			`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ?)
			 INSERT INTO working_memory (id, content, source, timestamp, session_id)
			 SELECT 'wm-' || i, 'memory ' || i, 'test', ?, 's' FROM seq`,
			[n, ts],
		);
		const t0 = performance.now();
		let outcome: string;
		try {
			remember(stateFor(db, "s", 2), "the write that runs the trim");
			outcome = "returned";
		} catch (err) {
			outcome = `THREW ${String(err)}`;
		}
		console.log(
			`PROBE limit N=${n} rows to trim=${n - 1} ${outcome}; rows left=${rows(db)} in ${(performance.now() - t0).toFixed(0)} ms`,
		);
		db.close();
	});
}
