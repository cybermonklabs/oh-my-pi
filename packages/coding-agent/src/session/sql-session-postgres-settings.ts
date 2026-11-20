/**
 * Every PostgreSQL session setting that a login without superuser can leave on
 * a server connection of a transaction-mode pool, and what the SQL session
 * store does about each.
 *
 * A client of such a pool (PgBouncer, Cloud SQL's managed pool) can send `SET`,
 * `SET ROLE` or `CREATE TEMP TABLE` and go; the next client that gets the same
 * server connection gets that state too. {@link PG_SESSION_SETTINGS} holds one
 * entry for each setting of context `user` on PostgreSQL 16, on Cloud SQL for
 * PostgreSQL 16 and on PostgreSQL 18 (the lists in
 * `test/session/fixtures/postgres-settings`), and one for `role` and one for
 * `temporary table`. Each entry has exactly one kind:
 *
 * - `set-local`: the opening sends `SET LOCAL <name> <value>`. The transaction
 *   then runs with the store's value, or with `TO DEFAULT` with the value the
 *   login, the database and the server give it, and nothing of it stays on the
 *   connection after the transaction.
 * - `begin-clause`: the opening's `BEGIN ISOLATION LEVEL READ COMMITTED READ
 *   WRITE` (`READ ONLY` for a read) sets it.
 * - `no-longer-used`: the store depended on it before and does not now.
 * - `exempt`: it cannot change a result, an error or the durability of a store
 *   statement, or it acts only while no transaction of the store runs.
 *
 * The store builds every opening from {@link PG_OPENING} alone, through
 * {@link pgOpening}. This module imports nothing from the store, so a test can
 * copy it into an older checkout of the store.
 *
 * The entries are in the order of the lists: PostgreSQL 16's names, then the
 * names Cloud SQL adds, then the names PostgreSQL 18 adds, then `role` and
 * `temporary table`.
 */

export type PgSettingKind =
	/** `value` is the text after `SET LOCAL <name> `, for example `TO DEFAULT` or `= 'UTF8'`. */
	| { kind: "set-local"; value: string }
	| { kind: "begin-clause" }
	| { kind: "no-longer-used"; reason: string }
	| { kind: "exempt"; reason: string };

export interface PgSessionSetting {
	/** pg_settings name, or "role", or "temporary table". */
	readonly name: string;
	readonly kind: PgSettingKind;
	/** Session-level statement the test sends on a store backend; `{role}` / `{table}` are filled by the harness. */
	readonly left: string;
	/** true, or why no value of the setting is hostile. */
	readonly hostile: true | { readonly none: string };
	/**
	 * Set exactly for names PostgreSQL 16.0, the oldest server the store supports, lacks: "PostgreSQL 16.4 and
	 * later", "Cloud SQL only", "PostgreSQL 17 and later", "PostgreSQL 18 and later".
	 */
	readonly conditional?: string;
}

/** One statement of the opening; `needs` names the parameter a server must have for the store to send it. */
export interface PgOpeningStatement {
	readonly sql: string;
	readonly needs?: string;
}

/** The `application_name` of every store transaction, set by the opening. */
export const PG_APPLICATION_NAME = "omp-session-store";

/** How many more times an operation runs, each on a new connection, after one that no transaction can repair. */
export const PG_REPAIR_RETRIES = 3;

type Hostile = PgSessionSetting["hostile"];

const TO_DEFAULT: PgSettingKind = { kind: "set-local", value: "TO DEFAULT" };
const BEGIN_CLAUSE: PgSettingKind = { kind: "begin-clause" };

const POSTGRESQL_16_CONNECTION_DOCS = "https://www.postgresql.org/docs/16/runtime-config-connection.html";
const POSTGRESQL_16_CLIENT_DOCS = "https://www.postgresql.org/docs/16/runtime-config-client.html";

/** An entry whose left statement is `SET <name> = <value>`, which lasts for the session. */
function entry(name: string, kind: PgSettingKind, value: string, hostile: Hostile = true): PgSessionSetting {
	return { name, kind, left: `SET ${name} = ${value}`, hostile };
}

/** A set-local entry that the opening sets back with `TO DEFAULT`. */
function toDefault(name: string, value: string, hostile: Hostile = true): PgSessionSetting {
	return entry(name, TO_DEFAULT, value, hostile);
}

/**
 * A planner, parallel-query or JIT setting, set back with `TO DEFAULT`. It
 * changes no row a statement returns, but it changes the plan and so how long
 * a statement runs and holds its row locks: one left value can make each read
 * of a large store scan a whole table. The store bounds its waits (the claim's
 * 5 s and the fence's 2 s lock bounds, the release's 2 s statement bound, the
 * lease's expiry), and the login's own `statement_timeout` applies too.
 */
function plan(name: string, value: string): PgSessionSetting {
	return toDefault(name, value);
}

/**
 * A setting of how much memory a sort, a hash or an index build may use, or
 * where it writes what does not fit, set back with `TO DEFAULT`: a small value
 * sends a store statement to temporary files, which `temp_file_limit` bounds
 * and which take time while the statement holds its locks.
 */
function memory(name: string, value: string, hostile: Hostile = true): PgSessionSetting {
	return toDefault(name, value, hostile);
}

function exempt(name: string, reason: string, value: string, hostile: Hostile = true): PgSessionSetting {
	return entry(name, { kind: "exempt", reason }, value, hostile);
}

/**
 * A Cloud SQL setting of the index advisor or the job scheduler. Google's
 * Cloud SQL documentation (https://cloud.google.com/sql/docs/postgres/flags and
 * the pages it links) does not say what these settings do, so the opening sets
 * each back with `TO DEFAULT` on a server that has it.
 */
function cloudSqlUndocumented(name: string, value: string): PgSessionSetting {
	return toDefault(name, value);
}

const VACUUM_ONLY = "It acts only in VACUUM and ANALYZE, and the store sends neither.";
const NO_DATE_VALUES =
	"It acts only on date, time and interval values, and the store sends and reads none: it keeps times as " +
	"bigint milliseconds and reads the clock only as the epoch of clock_timestamp(), which this setting does not change.";
const NO_LOCALE_FORMATTING =
	"It acts only on the to_char family of functions and on money values, and the store uses neither.";
const NO_BACKSLASH_LITERAL =
	"The store binds its values, so no string literal it sends holds a backslash, " +
	"and each literal reads the same under every value.";
const PASSWORD_ONLY = "It acts only when CREATE ROLE or ALTER ROLE sets a password, and the store sends neither.";
const LOGICAL_DECODING_ONLY = "It acts only in logical decoding and logical replication, which the store never runs.";
const NO_XML = "It acts only on XML values, and the store sends and reads none.";
const IO_ONLY_HOSTILE: Hostile = { none: "every value reads and writes the same data" };
const UNANSWERED_CONNECTION: Hostile = { none: "acts only on a connection whose client does not answer" };
const TCP_KEEPALIVE =
	'It acts only on keepalive messages after "time with no network activity" that the client does not acknowledge; ' +
	`on a connection whose client answers it ends nothing (PostgreSQL 16 documentation, ${POSTGRESQL_16_CONNECTION_DOCS}).`;

const POSTGRESQL_16_SETTINGS: readonly PgSessionSetting[] = [
	entry("application_name", { kind: "set-local", value: `= '${PG_APPLICATION_NAME}'` }, "'another-client'"),
	// Off, an unquoted NULL in an array value the store binds reads as the string NULL.
	toDefault("array_nulls", "off"),
	exempt(
		"backend_flush_after",
		"It sets only how soon the server asks the kernel to write out data pages; " +
			"a commit is durable through its WAL flush whatever the value.",
		"256",
		IO_ONLY_HOSTILE,
	),
	exempt("backslash_quote", NO_BACKSLASH_LITERAL, "off"),
	entry("bytea_output", { kind: "set-local", value: "= 'hex'" }, "'escape'"),
	exempt(
		"check_function_bodies",
		"It acts only on CREATE FUNCTION and CREATE PROCEDURE, and the store sends neither.",
		"off",
	),
	exempt(
		"client_connection_check_interval",
		'It checks only "that the client is still connected, while running queries"; on a connection whose client ' +
			`answers it ends nothing (PostgreSQL 16 documentation, ${POSTGRESQL_16_CONNECTION_DOCS}).`,
		"'10ms'",
		UNANSWERED_CONNECTION,
	),
	entry("client_encoding", { kind: "set-local", value: "= 'UTF8'" }, "'LATIN1'"),
	// It decides which notices reach the client; the debug levels send many with each statement.
	toDefault("client_min_messages", "debug5"),
	exempt(
		"commit_siblings",
		"It only decides whether a commit first waits commit_delay, which only a superuser sets, " +
			"so that other commits share its WAL flush; the commit is as durable either way.",
		"0",
		{ none: "every value commits with the same durability" },
	),
	plan("constraint_exclusion", "on"),
	plan("cpu_index_tuple_cost", "1000"),
	plan("cpu_operator_cost", "1000"),
	plan("cpu_tuple_cost", "1000"),
	exempt(
		"createrole_self_grant",
		"It acts only when CREATE ROLE runs, and the store sends no CREATE ROLE.",
		"'set, inherit'",
	),
	exempt(
		"cursor_tuple_fraction",
		"It plans only cursors, and the store declares none: it reads every row of each statement.",
		"0.0001",
	),
	exempt("DateStyle", NO_DATE_VALUES, "'SQL, DMY'"),
	exempt("debug_logical_replication_streaming", LOGICAL_DECODING_ONLY, "immediate"),
	plan("debug_parallel_query", "on"),
	exempt(
		"debug_pretty_print",
		"It only indents the trees that the debug_print settings write to the server log.",
		"off",
		{ none: "it only changes the layout of log lines" },
	),
	exempt(
		"debug_print_parse",
		"It only writes each statement's parse tree to the server log, where a bound value shows as a parameter.",
		"on",
		{ none: "it only writes parse trees to the server log" },
	),
	// A custom plan holds each bound value: a 512 MiB blob's printed plan can pass 1 GB, and then its INSERT fails.
	toDefault("debug_print_plan", "on"),
	exempt(
		"debug_print_rewritten",
		"It only writes each statement's rewritten parse tree to the server log, where a bound value shows as a parameter.",
		"on",
		{ none: "it only writes parse trees to the server log" },
	),
	exempt(
		"default_statistics_target",
		"It acts only when ANALYZE gathers statistics, and the store sends no ANALYZE.",
		"1",
	),
	// It picks the access method of each table the store creates.
	toDefault("default_table_access_method", "'heap'", { none: "PostgreSQL 16 has one table access method, heap" }),
	toDefault("default_tablespace", "'pg_global'"),
	exempt(
		"default_text_search_config",
		"It acts only on text search functions, and the store calls none.",
		"'pg_catalog.german'",
	),
	exempt(
		"default_toast_compression",
		"It chooses only how the server compresses a long value it stores; every method gives back the same value.",
		"'lz4'",
		{ none: "every method gives back the same value" },
	),
	entry("default_transaction_deferrable", BEGIN_CLAUSE, "on"),
	entry("default_transaction_isolation", BEGIN_CLAUSE, "'serializable'"),
	entry("default_transaction_read_only", BEGIN_CLAUSE, "on"),
	plan("effective_cache_size", "'8kB'"),
	exempt(
		"effective_io_concurrency",
		"It sets only how many reads a bitmap heap scan asks the kernel to prefetch; every value reads the same rows.",
		"0",
		IO_ONLY_HOSTILE,
	),
	plan("enable_async_append", "off"),
	plan("enable_bitmapscan", "off"),
	plan("enable_gathermerge", "off"),
	plan("enable_hashagg", "off"),
	plan("enable_hashjoin", "off"),
	plan("enable_incremental_sort", "off"),
	plan("enable_indexonlyscan", "off"),
	plan("enable_indexscan", "off"),
	plan("enable_material", "off"),
	plan("enable_memoize", "off"),
	plan("enable_mergejoin", "off"),
	plan("enable_nestloop", "off"),
	plan("enable_parallel_append", "off"),
	plan("enable_parallel_hash", "off"),
	plan("enable_partition_pruning", "off"),
	plan("enable_partitionwise_aggregate", "on"),
	plan("enable_partitionwise_join", "on"),
	plan("enable_presorted_aggregate", "off"),
	plan("enable_seqscan", "off"),
	plan("enable_sort", "off"),
	plan("enable_tidscan", "off"),
	exempt(
		"escape_string_warning",
		"It only adds a warning for a backslash in a string literal, and no literal the store sends holds one.",
		"off",
		{ none: "it only adds or drops a warning" },
	),
	toDefault("exit_on_error", "on"),
	exempt(
		"extra_float_digits",
		"It formats only floating-point output, and the store reads no floating-point value.",
		"-15",
	),
	plan("from_collapse_limit", "1"),
	plan("geqo", "off"),
	plan("geqo_effort", "1"),
	plan("geqo_generations", "1"),
	plan("geqo_pool_size", "2"),
	plan("geqo_seed", "1"),
	plan("geqo_selection_bias", "1.5"),
	plan("geqo_threshold", "2"),
	// A GIN index scan returns about this many rows at most: a read through a GIN index on a store table can miss rows.
	toDefault("gin_fuzzy_search_limit", "1"),
	// A store write into a table with a GIN index moves the pending list into the index when it passes this size.
	toDefault("gin_pending_list_limit", "'64kB'"),
	memory("hash_mem_multiplier", "1"),
	exempt(
		"icu_validation_level",
		"It acts only when CREATE COLLATION or CREATE DATABASE checks an ICU locale, and the store sends neither.",
		"error",
	),
	toDefault("idle_in_transaction_session_timeout", "'1ms'"),
	exempt(
		"idle_session_timeout",
		'It acts only while no transaction of the store runs: it ends a session that is idle "but not within an open ' +
			`transaction" (PostgreSQL 16 documentation, ${POSTGRESQL_16_CLIENT_DOCS}).`,
		"'5s'",
		{ none: "acts only between transactions" },
	),
	exempt("IntervalStyle", NO_DATE_VALUES, "iso_8601"),
	plan("jit", "off"),
	plan("jit_above_cost", "0"),
	plan("jit_expressions", "off"),
	plan("jit_inline_above_cost", "0"),
	plan("jit_optimize_above_cost", "0"),
	plan("jit_tuple_deforming", "off"),
	plan("join_collapse_limit", "1"),
	exempt("lc_monetary", NO_LOCALE_FORMATTING, "'C'"),
	exempt("lc_numeric", NO_LOCALE_FORMATTING, "'C'"),
	exempt("lc_time", NO_LOCALE_FORMATTING, "'C'"),
	exempt(
		"local_preload_libraries",
		"The server loads these libraries only when a connection starts, so a value set later in a session loads nothing.",
		"''",
		{ none: "a value set in a session loads nothing" },
	),
	toDefault("lock_timeout", "'1ms'"),
	exempt("logical_decoding_work_mem", LOGICAL_DECODING_ONLY, "'64kB'"),
	// At -1 the server keeps a text copy of each bound value: a 512 MiB blob's copy passes 1 GB, and its INSERT fails.
	toDefault("log_parameter_max_length_on_error", "-1"),
	exempt(
		"maintenance_io_concurrency",
		"It sets only how many reads maintenance work asks the kernel to prefetch; every value reads the same rows.",
		"0",
		IO_ONLY_HOSTILE,
	),
	// The store's CREATE INDEX builds its index within this memory.
	memory("maintenance_work_mem", "'1MB'"),
	// The store's CREATE INDEX can build its index in parallel workers.
	plan("max_parallel_maintenance_workers", "8"),
	plan("max_parallel_workers", "0"),
	plan("max_parallel_workers_per_gather", "8"),
	plan("min_parallel_index_scan_size", "0"),
	plan("min_parallel_table_scan_size", "0"),
	plan("parallel_leader_participation", "off"),
	plan("parallel_setup_cost", "0"),
	plan("parallel_tuple_cost", "0"),
	exempt("password_encryption", PASSWORD_ONLY, "md5"),
	plan("plan_cache_mode", "force_generic_plan"),
	{
		name: "quote_all_identifiers",
		kind: {
			kind: "no-longer-used",
			reason:
				"The table check compares column types by their OIDs, and quoted names appear only in refusal messages, " +
				"so no statement the store sends depends on it.",
		},
		left: "SET quote_all_identifiers = on",
		hostile: true,
	},
	plan("random_page_cost", "1000"),
	exempt("recursive_worktable_factor", "It plans only WITH RECURSIVE queries, and the store sends none.", "0.001"),
	// It refuses each read of a view or a foreign table, as a store table replaced by one after the open check would be.
	// PostgreSQL 16.4 added it (the fix of CVE-2024-7348); PostgreSQL 16.0 to 16.3 lack it.
	{
		...toDefault("restrict_nonsystem_relation_kind", "'view, foreign-table'"),
		conditional: "PostgreSQL 16.4 and later",
	},
	// Off, a statement on a table with a row security policy fails instead of seeing the policy's rows.
	toDefault("row_security", "off"),
	exempt("scram_iterations", PASSWORD_ONLY, "1"),
	entry("search_path", { kind: "set-local", value: "= pg_catalog, pg_temp" }, "''"),
	plan("seq_page_cost", "1000"),
	exempt("standard_conforming_strings", NO_BACKSLASH_LITERAL, "off"),
	toDefault("statement_timeout", "'50ms'"),
	exempt(
		"stats_fetch_consistency",
		"It acts only on reads of the cumulative statistics views, and the store reads none.",
		"snapshot",
	),
	exempt(
		"synchronize_seqscans",
		"It changes only the order of the rows a large table scan returns, and the store orders each read " +
			"whose order it uses, in SQL or in code.",
		"off",
		{ none: "every value returns the same rows of a scan" },
	),
	entry("synchronous_commit", { kind: "set-local", value: "= on" }, "off"),
	exempt("tcp_keepalives_count", TCP_KEEPALIVE, "1", UNANSWERED_CONNECTION),
	exempt("tcp_keepalives_idle", TCP_KEEPALIVE, "1", UNANSWERED_CONNECTION),
	exempt("tcp_keepalives_interval", TCP_KEEPALIVE, "1", UNANSWERED_CONNECTION),
	exempt(
		"tcp_user_timeout",
		'It acts only on "transmitted data [that] may remain unacknowledged"; on a connection whose client answers ' +
			`it ends nothing (PostgreSQL 16 documentation, ${POSTGRESQL_16_CONNECTION_DOCS}).`,
		"'10s'",
		UNANSWERED_CONNECTION,
	),
	exempt(
		"temp_buffers",
		"It sizes only the buffers of temporary tables, and the store reads and writes none: " +
			"it names each of its tables with their schema.",
		"100",
		{ none: "every value keeps the same temporary table data" },
	),
	memory("temp_tablespaces", "'pg_default'", {
		none: "a login without CREATE on a tablespace can name only its database's own",
	}),
	exempt("TimeZone", NO_DATE_VALUES, "'Pacific/Kiritimati'"),
	exempt("timezone_abbreviations", NO_DATE_VALUES, "'India'"),
	exempt("trace_notify", "It only writes debug output for LISTEN and NOTIFY, and the store sends neither.", "on", {
		none: "it only writes debug output",
	}),
	exempt("trace_sort", "It only writes a line about each sort's resource use to the server log.", "on", {
		none: "it only writes sort statistics to the server log",
	}),
	// A plain SET of these three outside a transaction does not last; SET SESSION CHARACTERISTICS does.
	{
		name: "transaction_deferrable",
		kind: BEGIN_CLAUSE,
		left: "SET SESSION CHARACTERISTICS AS TRANSACTION DEFERRABLE",
		hostile: true,
	},
	{
		name: "transaction_isolation",
		kind: BEGIN_CLAUSE,
		left: "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE",
		hostile: true,
	},
	{
		name: "transaction_read_only",
		kind: BEGIN_CLAUSE,
		left: "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
		hostile: true,
	},
	// On, the parser reads `x = NULL` in a statement's text as `x IS NULL`.
	toDefault("transform_null_equals", "on"),
	exempt("vacuum_buffer_usage_limit", VACUUM_ONLY, "'128kB'"),
	exempt("vacuum_cost_delay", VACUUM_ONLY, "100"),
	exempt("vacuum_cost_limit", VACUUM_ONLY, "1"),
	exempt("vacuum_cost_page_dirty", VACUUM_ONLY, "10000"),
	exempt("vacuum_cost_page_hit", VACUUM_ONLY, "10000"),
	exempt("vacuum_cost_page_miss", VACUUM_ONLY, "10000"),
	exempt("vacuum_failsafe_age", VACUUM_ONLY, "0"),
	exempt("vacuum_freeze_min_age", VACUUM_ONLY, "0"),
	exempt("vacuum_freeze_table_age", VACUUM_ONLY, "0"),
	exempt("vacuum_multixact_failsafe_age", VACUUM_ONLY, "0"),
	exempt("vacuum_multixact_freeze_min_age", VACUUM_ONLY, "0"),
	exempt("vacuum_multixact_freeze_table_age", VACUUM_ONLY, "0"),
	exempt(
		"wal_sender_timeout",
		"It acts only on replication connections, and the store's connection is not one.",
		"'1ms'",
	),
	exempt(
		"wal_skip_threshold",
		"It acts only when wal_level is minimal, where it chooses between WAL and an fsync " +
			"to make a new table's data durable at commit; the data is durable either way.",
		"0",
		{ none: "every value makes the new data durable at commit" },
	),
	memory("work_mem", "'64kB'"),
	exempt("xmlbinary", NO_XML, "hex"),
	exempt("xmloption", NO_XML, "document"),
];

const CLOUD_SQL_SETTINGS: readonly PgSessionSetting[] = [
	exempt(
		"cloudsql.enable_google_ml_integration",
		"It lets the functions of the google_ml_integration extension call Vertex AI, and the store calls none of them.",
		"off",
	),
	toDefault("cloudsql_session_read_only", "on"),
	cloudSqlUndocumented("google_db_advisor.ai_rewritten_query_return_count", "10"),
	cloudSqlUndocumented("google_db_advisor.debug_option", "1"),
	cloudSqlUndocumented("google_db_advisor.enable_ai_perfagent_advice", "on"),
	cloudSqlUndocumented("google_db_advisor.enable_ai_tune_sql", "on"),
	cloudSqlUndocumented("google_db_advisor.enable_llm_call_in_background_job", "on"),
	cloudSqlUndocumented("google_db_advisor.enable_workload_capture", "off"),
	cloudSqlUndocumented("google_db_advisor.flash_llm_model_id", "'another-model'"),
	cloudSqlUndocumented("google_db_advisor.llm_model_id", "'another-model'"),
	cloudSqlUndocumented("google_db_advisor.max_index_width", "1"),
	cloudSqlUndocumented("google_db_advisor.max_num_cached_query_costs", "200000"),
	cloudSqlUndocumented("google_db_advisor.max_num_indexable_columns", "1"),
	cloudSqlUndocumented("google_db_advisor.max_statement_length", "0"),
	cloudSqlUndocumented("google_db_advisor.max_storage_size_in_mb", "1"),
	cloudSqlUndocumented("google_db_advisor.min_workload_cost_saving_ratio", "0"),
	cloudSqlUndocumented("google_db_advisor.recommendation_max_time_in_seconds", "0"),
	cloudSqlUndocumented("google_db_advisor.recommend_indexes_on_partitions", "on"),
	cloudSqlUndocumented("google_db_advisor.reset_query_rewrite_stats", "on"),
	cloudSqlUndocumented("google_db_advisor.test_hook", "1"),
	cloudSqlUndocumented("google_db_advisor.top_k_slowest_statements", "1"),
	cloudSqlUndocumented("google_db_advisor.without_cost_comparison", "on"),
	cloudSqlUndocumented("google_db_advisor.without_rewrite_rules", "on"),
	cloudSqlUndocumented("google_job_scheduler.debug_option", "1"),
	cloudSqlUndocumented("google_job_scheduler.enable_task_scheduler", "on"),
	cloudSqlUndocumented("google_job_scheduler.max_parallel_workers_per_job", "0"),
	exempt(
		"google_ml_integration.enable_model_support",
		"It turns on model endpoint management in the google_ml_integration extension, whose functions the store never calls.",
		"off",
	),
].map(setting => ({ ...setting, conditional: "Cloud SQL only" }));

const POSTGRESQL_17 = "PostgreSQL 17 and later";
const POSTGRESQL_18 = "PostgreSQL 18 and later";

const LATER_SETTINGS: readonly PgSessionSetting[] = [
	{
		...exempt("enable_distinct_reordering", "It plans only DISTINCT, and the store sends no DISTINCT.", "off"),
		conditional: POSTGRESQL_18,
	},
	{
		...exempt("enable_group_by_reordering", "It plans only GROUP BY, and the store sends no GROUP BY.", "off"),
		conditional: POSTGRESQL_17,
	},
	{
		...exempt(
			"enable_self_join_elimination",
			"It acts only on a join of a table with itself, and no statement the store sends joins one.",
			"off",
		),
		conditional: POSTGRESQL_18,
	},
	{
		...exempt(
			"file_copy_method",
			"It acts only on CREATE DATABASE and ALTER DATABASE SET TABLESPACE, and the store sends neither.",
			"clone",
		),
		conditional: POSTGRESQL_18,
	},
	{
		...exempt(
			"io_combine_limit",
			"It sets only how many blocks one read or write combines; every value reads and writes the same data.",
			"1",
			IO_ONLY_HOSTILE,
		),
		conditional: POSTGRESQL_17,
	},
	{
		...exempt(
			"md5_password_warnings",
			"It only adds a warning when CREATE ROLE or ALTER ROLE sets an MD5 password, and the store sends neither.",
			"off",
			{ none: "it only adds or drops a warning" },
		),
		conditional: POSTGRESQL_18,
	},
	{ ...toDefault("transaction_timeout", "'100ms'"), conditional: POSTGRESQL_17 },
	{ ...exempt("vacuum_max_eager_freeze_failure_rate", VACUUM_ONLY, "0"), conditional: POSTGRESQL_18 },
	{ ...exempt("vacuum_truncate", VACUUM_ONLY, "off"), conditional: POSTGRESQL_18 },
];

const STATE_SETTINGS: readonly PgSessionSetting[] = [
	{ name: "role", kind: TO_DEFAULT, left: "SET ROLE {role}", hostile: true },
	{
		name: "temporary table",
		kind: {
			kind: "no-longer-used",
			reason:
				"The store names each of its tables with their schema and puts pg_temp last in search_path, " +
				"so it never reads or writes a temporary table that has a store table's name.",
		},
		// It holds the key columns of every store table and takes no row.
		left: "CREATE TEMP TABLE {table} (path text, session_id text, sha256 text, CHECK (false))",
		hostile: true,
	},
];

/** Every session setting of context `user` on the servers the store supports, with `role` and `temporary table`. */
export const PG_SESSION_SETTINGS: readonly PgSessionSetting[] = [
	...POSTGRESQL_16_SETTINGS,
	...CLOUD_SQL_SETTINGS,
	...LATER_SETTINGS,
	...STATE_SETTINGS,
];

/** The `BEGIN` of every opening, before its `READ WRITE` or `READ ONLY`. */
const READ_COMMITTED_BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";

/**
 * The statements after `BEGIN` that come first, in this order: `exit_on_error`
 * right after the mark, so a refusal later in the opening does not also end
 * the backend.
 */
const OPENING_HEAD = [
	"application_name",
	"exit_on_error",
	"statement_timeout",
	"lock_timeout",
	"idle_in_transaction_session_timeout",
];

/** The conditional statements that come first among the conditional ones. */
const CONDITIONAL_HEAD = ["transaction_timeout", "cloudsql_session_read_only"];

function buildOpening(): PgOpeningStatement[] {
	const statements = new Map<string, PgOpeningStatement>();
	for (const setting of PG_SESSION_SETTINGS) {
		if (setting.kind.kind !== "set-local") continue;
		const sql = `SET LOCAL ${setting.name} ${setting.kind.value}`;
		statements.set(setting.name, setting.conditional === undefined ? { sql } : { sql, needs: setting.name });
	}
	const take = (name: string): PgOpeningStatement => {
		const statement = statements.get(name);
		if (!statement) throw new Error(`sql-session-postgres-settings: no set-local entry for ${name}`);
		statements.delete(name);
		return statement;
	};
	const head = OPENING_HEAD.map(take);
	const conditionalHead = CONDITIONAL_HEAD.map(take);
	const rest = [...statements.values()];
	return [
		{ sql: `${READ_COMMITTED_BEGIN} READ WRITE` },
		...head,
		...rest.filter(statement => statement.needs === undefined),
		...conditionalHead,
		...rest.filter(statement => statement.needs !== undefined),
	];
}

/**
 * The write opening's statements in the order the store sends them: `BEGIN`,
 * the `application_name` mark, `exit_on_error`, the three timeouts, every
 * other set-local entry in list order, and last the statements that need a
 * parameter some supported server lacks, each with that parameter.
 */
export const PG_OPENING: readonly PgOpeningStatement[] = buildOpening();

/** The parameters the conditional statements of {@link PG_OPENING} need, in its order; the store's probe reads them. */
export const PG_CONDITIONAL_PARAMETERS: readonly string[] = PG_OPENING.flatMap(statement =>
	statement.needs === undefined ? [] : [statement.needs],
);

const READ_BEGIN = `${READ_COMMITTED_BEGIN} READ ONLY`;

/**
 * The opening the store sends as one simple query: the statements of
 * {@link PG_OPENING} joined with `"; "`, without each statement whose
 * parameter is not in `present`, and with `READ ONLY` for a read.
 */
export function pgOpening(mode: "write" | "read", present: ReadonlySet<string>): string {
	const statements = PG_OPENING.filter(({ needs }) => needs === undefined || present.has(needs)).map(({ sql }) => sql);
	if (mode === "read") statements[0] = READ_BEGIN;
	return statements.join("; ");
}
