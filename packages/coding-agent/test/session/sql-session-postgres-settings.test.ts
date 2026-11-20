/**
 * The list module beside `SqlSessionStorage` that names every PostgreSQL
 * session setting the store's statements could depend on, and the opening
 * built from it. Read against the setting names of context `user` four
 * servers report (`fixtures/postgres-settings`): PostgreSQL 16.0, the oldest
 * the store supports, PostgreSQL 16.16, Cloud SQL for PostgreSQL 16 and
 * PostgreSQL 18. A server whose list gains a name fails here until the name
 * has an entry. No database is needed.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	PG_APPLICATION_NAME,
	PG_CONDITIONAL_PARAMETERS,
	PG_OPENING,
	PG_REPAIR_RETRIES,
	PG_SESSION_SETTINGS,
	type PgSessionSetting,
	type PgSettingKind,
	pgOpening,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-postgres-settings";

const FIXTURES = path.join(import.meta.dir, "fixtures", "postgres-settings");

/** The captured lists, each the names one server's `pg_settings` holds with context `user`. */
const CAPTURES = [
	"postgresql-16.0.txt",
	"postgresql-16.txt",
	"cloud-sql-postgresql-16.txt",
	"postgresql-18.txt",
] as const;

/** The setting names of a captured list: one per line; `#` lines say how it was captured. */
async function capturedNames(file: string): Promise<string[]> {
	const text = await Bun.file(path.join(FIXTURES, file)).text();
	return text.split("\n").filter(line => line !== "" && !line.startsWith("#"));
}

const CAPTURED = new Map(await Promise.all(CAPTURES.map(async file => [file, await capturedNames(file)] as const)));
/** The oldest server the store supports: an entry whose name it lacks is conditional. */
const POSTGRESQL_16_0 = new Set(CAPTURED.get("postgresql-16.0.txt"));
const CLOUD_SQL = new Set(CAPTURED.get("cloud-sql-postgresql-16.txt"));
const EVERY_CAPTURED = new Set([...CAPTURED.values()].flat());

/** The two entries that are no `pg_settings` name, which every server has. */
const NOT_SETTINGS: Record<string, true> = { role: true, "temporary table": true };

/** The release each name PostgreSQL 16.0 lacks came with, after the PostgreSQL 16.4, 17 and 18 release notes. */
const LATER_RELEASES: Record<string, string> = {
	restrict_nonsystem_relation_kind: "PostgreSQL 16.4 and later",
	enable_group_by_reordering: "PostgreSQL 17 and later",
	io_combine_limit: "PostgreSQL 17 and later",
	transaction_timeout: "PostgreSQL 17 and later",
	enable_distinct_reordering: "PostgreSQL 18 and later",
	enable_self_join_elimination: "PostgreSQL 18 and later",
	file_copy_method: "PostgreSQL 18 and later",
	md5_password_warnings: "PostgreSQL 18 and later",
	vacuum_max_eager_freeze_failure_rate: "PostgreSQL 18 and later",
	vacuum_truncate: "PostgreSQL 18 and later",
};

/** A reason nobody wrote: too short to say why, or a marker left for later. */
function placeholder(reason: unknown, name: string): boolean {
	if (typeof reason !== "string") return true;
	const text = reason.trim();
	return (
		text.split(/\s+/).length < 3 ||
		text === name ||
		/\b(todo|tbd|fixme|xxx|placeholder|lorem ipsum)\b/i.test(text) ||
		/^(n\/?a|none|reason|unknown|[?.-]+)$/i.test(text)
	);
}

type SetLocalSetting = PgSessionSetting & { readonly kind: Extract<PgSettingKind, { kind: "set-local" }> };

function isSetLocal(entry: PgSessionSetting): entry is SetLocalSetting {
	return entry.kind.kind === "set-local";
}

/** The opening statement of a set-local entry. */
function statementOf(entry: SetLocalSetting): string {
	return `SET LOCAL ${entry.name} ${entry.kind.value}`;
}

/** The fields each kind holds, and no other. */
const KIND_FIELDS: Record<PgSettingKind["kind"], readonly string[]> = {
	"set-local": ["kind", "value"],
	"begin-clause": ["kind"],
	"no-longer-used": ["kind", "reason"],
	exempt: ["kind", "reason"],
};

const TO_DEFAULT: PgSettingKind = { kind: "set-local", value: "TO DEFAULT" };
const BEGIN_CLAUSE: PgSettingKind = { kind: "begin-clause" };
const NO_LONGER_USED: PgSettingKind = { kind: "no-longer-used", reason: expect.any(String) };
const EXEMPT: PgSettingKind = { kind: "exempt", reason: expect.any(String) };

/** The entries whose kind the store's statements depend on, with that kind and its value. */
const FIXED_KINDS: Array<[string, PgSettingKind]> = [
	["application_name", { kind: "set-local", value: "= 'omp-session-store'" }],
	["statement_timeout", TO_DEFAULT],
	["lock_timeout", TO_DEFAULT],
	["idle_in_transaction_session_timeout", TO_DEFAULT],
	["transaction_timeout", TO_DEFAULT],
	["exit_on_error", TO_DEFAULT],
	["role", TO_DEFAULT],
	["default_tablespace", TO_DEFAULT],
	["cloudsql_session_read_only", TO_DEFAULT],
	["client_encoding", { kind: "set-local", value: "= 'UTF8'" }],
	["bytea_output", { kind: "set-local", value: "= 'hex'" }],
	["synchronous_commit", { kind: "set-local", value: "= on" }],
	["search_path", { kind: "set-local", value: "= pg_catalog, pg_temp" }],
	["default_transaction_read_only", BEGIN_CLAUSE],
	["default_transaction_isolation", BEGIN_CLAUSE],
	["transaction_read_only", BEGIN_CLAUSE],
	["transaction_isolation", BEGIN_CLAUSE],
	["quote_all_identifiers", NO_LONGER_USED],
	["temporary table", NO_LONGER_USED],
	["idle_session_timeout", EXEMPT],
	["tcp_user_timeout", EXEMPT],
	["tcp_keepalives_idle", EXEMPT],
	["tcp_keepalives_interval", EXEMPT],
	["tcp_keepalives_count", EXEMPT],
	["client_connection_check_interval", EXEMPT],
];

/** The opening's statements after `BEGIN` that come first, in this order, before every other set-local entry's. */
const OPENING_HEAD = [
	"SET LOCAL application_name = 'omp-session-store'",
	"SET LOCAL exit_on_error TO DEFAULT",
	"SET LOCAL statement_timeout TO DEFAULT",
	"SET LOCAL lock_timeout TO DEFAULT",
	"SET LOCAL idle_in_transaction_session_timeout TO DEFAULT",
];

/** The statements of the set-local entries that no supported server lacks, less the head's, in list order. */
const UNCONDITIONAL_REST = PG_SESSION_SETTINGS.filter(isSetLocal)
	.filter(entry => entry.conditional === undefined)
	.map(statementOf)
	.filter(sql => !OPENING_HEAD.includes(sql));

/**
 * The parameters of the opening's conditional statements, in its order: `transaction_timeout` and
 * `cloudsql_session_read_only`, then every other set-local entry that a supported server may lack, in list order.
 */
const CONDITIONAL_ORDER = [
	"transaction_timeout",
	"cloudsql_session_read_only",
	...PG_SESSION_SETTINGS.filter(
		entry =>
			isSetLocal(entry) &&
			entry.conditional !== undefined &&
			entry.name !== "transaction_timeout" &&
			entry.name !== "cloudsql_session_read_only",
	).map(entry => entry.name),
];

describe("PG_SESSION_SETTINGS", () => {
	describe("the list holds every name of each captured server", () => {
		for (const file of CAPTURES) {
			it(file, () => {
				const listed = new Set(PG_SESSION_SETTINGS.map(entry => entry.name));
				expect((CAPTURED.get(file) ?? []).filter(name => !listed.has(name))).toEqual([]);
			});
		}
	});

	it("holds role and temporary table besides the captured names, and no two entries share a name", () => {
		const names = PG_SESSION_SETTINGS.map(entry => entry.name);
		expect(names).toContain("role");
		expect(names).toContain("temporary table");
		expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
		expect(names.filter(name => !EVERY_CAPTURED.has(name) && !Object.hasOwn(NOT_SETTINGS, name))).toEqual([]);
	});

	it("each entry has exactly one kind", () => {
		const wrong = PG_SESSION_SETTINGS.filter(entry => {
			const kind: PgSettingKind = entry.kind;
			const fields: readonly string[] | undefined = Object.hasOwn(KIND_FIELDS, kind.kind)
				? KIND_FIELDS[kind.kind]
				: undefined;
			if (!fields) return true;
			if (Object.keys(kind).sort().join(" ") !== [...fields].sort().join(" ")) return true;
			return kind.kind === "set-local" && (typeof kind.value !== "string" || kind.value.trim() === "");
		}).map(entry => entry.name);
		expect(wrong).toEqual([]);
	});

	it("each exempt and no-longer-used entry has a reason that is no placeholder", () => {
		const unreasoned = PG_SESSION_SETTINGS.filter(
			entry =>
				(entry.kind.kind === "exempt" || entry.kind.kind === "no-longer-used") &&
				placeholder(entry.kind.reason, entry.name),
		).map(entry => entry.name);
		expect(unreasoned).toEqual([]);
	});

	it("each entry has a left statement, and hostile is true or a reason", () => {
		const problems: string[] = [];
		for (const entry of PG_SESSION_SETTINGS) {
			const { left, hostile } = entry;
			if (typeof left !== "string" || left.trim() === "") problems.push(`${entry.name}: no left statement`);
			// The test leaves the setting for the session, so a later transaction of the store meets it.
			else if (/^\s*SET\s+LOCAL\b/i.test(left))
				problems.push(`${entry.name}: left statement ends with its transaction`);
			if (hostile === true) continue;
			if (
				typeof hostile !== "object" ||
				hostile === null ||
				Object.keys(hostile).join(" ") !== "none" ||
				placeholder(hostile.none, entry.name)
			) {
				problems.push(`${entry.name}: hostile is neither true nor a reason`);
			}
		}
		const role = PG_SESSION_SETTINGS.find(entry => entry.name === "role");
		const table = PG_SESSION_SETTINGS.find(entry => entry.name === "temporary table");
		// The harness fills these in: the role without rights, and each store table's name.
		if (!role?.left.includes("{role}")) problems.push("role: left statement names no {role}");
		if (!table?.left.includes("{table}")) problems.push("temporary table: left statement names no {table}");
		expect(problems).toEqual([]);
	});

	it("conditional is set exactly for the names postgresql-16.0.txt, the oldest supported server, lacks", () => {
		const expected = (name: string): string | undefined => {
			if (Object.hasOwn(NOT_SETTINGS, name) || POSTGRESQL_16_0.has(name)) return undefined;
			// A later release's name is in Cloud SQL's list too when its PostgreSQL has it.
			if (Object.hasOwn(LATER_RELEASES, name)) return LATER_RELEASES[name];
			if (CLOUD_SQL.has(name)) return "Cloud SQL only";
			return `a release this test does not name for ${name}`;
		};
		const wrong = PG_SESSION_SETTINGS.filter(entry => entry.conditional !== expected(entry.name)).map(
			entry => `${entry.name}: ${String(entry.conditional)}, not ${String(expected(entry.name))}`,
		);
		expect(wrong).toEqual([]);
	});

	describe("the kinds the store's statements depend on", () => {
		for (const [name, kind] of FIXED_KINDS) {
			it(name, () => {
				expect(PG_SESSION_SETTINGS.find(entry => entry.name === name)?.kind).toEqual(kind);
			});
		}
	});
});

describe("PG_OPENING", () => {
	it("begins READ COMMITTED READ WRITE, marks the application, keeps exit_on_error off, then resets the timeouts", () => {
		expect(PG_OPENING.slice(0, OPENING_HEAD.length + 1)).toEqual([
			{ sql: "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE" },
			...OPENING_HEAD.map(sql => ({ sql })),
		]);
		expect(PG_OPENING[1]?.sql).toBe(`SET LOCAL application_name = '${PG_APPLICATION_NAME}'`);
	});

	it("holds one statement per set-local entry and no other, each conditional one last with the parameter it needs", () => {
		const setLocal = PG_SESSION_SETTINGS.filter(isSetLocal);
		const statements = PG_OPENING.slice(1);
		expect(statements.filter(({ sql }) => !setLocal.some(entry => statementOf(entry) === sql))).toEqual([]);
		expect(
			setLocal
				.filter(entry => statements.filter(({ sql }) => sql === statementOf(entry)).length !== 1)
				.map(e => e.name),
		).toEqual([]);
		// A statement needs the parameter of its entry exactly when a supported server may lack it.
		expect(
			setLocal
				.filter(entry => {
					const needs = statements.find(({ sql }) => sql === statementOf(entry))?.needs;
					return needs !== (entry.conditional === undefined ? undefined : entry.name);
				})
				.map(entry => entry.name),
		).toEqual([]);
		const firstConditional = PG_OPENING.findIndex(statement => statement.needs !== undefined);
		const conditional = firstConditional < 0 ? [] : PG_OPENING.slice(firstConditional);
		expect(conditional.filter(statement => statement.needs === undefined)).toEqual([]);
		expect(conditional.map(statement => statement.needs)).toEqual(
			expect.arrayContaining(["transaction_timeout", "cloudsql_session_read_only"]),
		);
		// Between the head and the conditional statements: every other set-local entry, in list order.
		const head = new Set(OPENING_HEAD);
		expect(PG_OPENING.slice(OPENING_HEAD.length + 1, firstConditional < 0 ? undefined : firstConditional)).toEqual(
			setLocal
				.filter(entry => entry.conditional === undefined && !head.has(statementOf(entry)))
				.map(entry => ({ sql: statementOf(entry) })),
		);
	});

	it("PG_CONDITIONAL_PARAMETERS: transaction_timeout, cloudsql_session_read_only, then each other conditional set-local entry in list order", () => {
		expect(PG_CONDITIONAL_PARAMETERS).toEqual(CONDITIONAL_ORDER);
	});
});

describe("pgOpening", () => {
	const BEGIN_WRITE = "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE";
	const BEGIN_READ = "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY";
	const MARK = "SET LOCAL application_name = 'omp-session-store'";
	/** The write opening on a server that has no conditional parameter. */
	const NONE = [BEGIN_WRITE, ...OPENING_HEAD, ...UNCONDITIONAL_REST].join("; ");
	/** A label, the parameters a server has, and the write opening the store must send there. */
	const cases: Array<[string, ReadonlySet<string>, string]> = [
		["no conditional parameter", new Set(), NONE],
		["only names that no conditional statement needs", new Set(["work_mem", "no_such_setting"]), NONE],
		["transaction_timeout", new Set(["transaction_timeout"]), `${NONE}; SET LOCAL transaction_timeout TO DEFAULT`],
		[
			"restrict_nonsystem_relation_kind and cloudsql_session_read_only",
			new Set(["restrict_nonsystem_relation_kind", "cloudsql_session_read_only"]),
			`${NONE}; SET LOCAL cloudsql_session_read_only TO DEFAULT; SET LOCAL restrict_nonsystem_relation_kind TO DEFAULT`,
		],
		[
			"every conditional parameter",
			new Set(CONDITIONAL_ORDER),
			[NONE, ...CONDITIONAL_ORDER.map(name => `SET LOCAL ${name} TO DEFAULT`)].join("; "),
		],
	];

	it("begins READ ONLY for a read and READ WRITE for a write, then marks the application", () => {
		expect(pgOpening("read", new Set())).toStartWith(`${BEGIN_READ}; ${MARK}; `);
		expect(pgOpening("write", new Set())).toStartWith(`${BEGIN_WRITE}; ${MARK}; `);
	});

	it("with no conditional parameter, holds no conditional statement and ends with work_mem and role", () => {
		const opening = pgOpening("write", new Set());
		expect(CONDITIONAL_ORDER.filter(name => opening.includes(`SET LOCAL ${name} `))).toEqual([]);
		expect(opening).toEndWith("; SET LOCAL work_mem TO DEFAULT; SET LOCAL role TO DEFAULT");
	});

	for (const [label, present, write] of cases) {
		it(`the server having ${label}: the write opening, and the read opening with READ ONLY`, () => {
			expect(pgOpening("write", present)).toBe(write);
			expect(pgOpening("read", present)).toBe(`${BEGIN_READ}${write.slice(BEGIN_WRITE.length)}`);
		});
	}
});

it("an operation runs again on at most 3 more connections it cannot repair", () => {
	expect(PG_REPAIR_RETRIES).toBe(3);
});
