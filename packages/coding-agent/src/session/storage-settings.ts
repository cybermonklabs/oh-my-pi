/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Session storage — where session transcripts persist. `file` is the JSONL tree under the
// sessions directory; `sql` stores each session as a row in a PostgreSQL, MySQL, or SQLite
// table through `SqlSessionStorage`, connecting with the connection string read from the file
// `session.sql.dsnFile` names. Hidden from the UI; populate via env vars or hand-edited
// config.yml. Env takes precedence. The storage itself is resolved once at start-up by
// `session-storage-config.ts` from the explicit environment and the configured value, so an
// unknown `OMP_SESSION_STORAGE` or `session.storage` refuses to start instead of reading as the
// `file` default; these definitions own validation, CLI, and `cfg://` display.
export const cfgSessionStorage = register({
	id: "session.storage",
	type: "enum",
	values: ["file", "sql"] as const,
	default: "file",
	env: "OMP_SESSION_STORAGE",
});

export const cfgSessionSqlDsnFile = register({
	id: "session.sql.dsnFile",
	type: "string",
	default: undefined,
	env: "OMP_SESSION_SQL_DSN_FILE",
});

// Off-box check for `sql`: a command run (no shell) before a session's first database write and
// for every subagent transcript. Exit 0 lets the session go to the database; any other outcome
// keeps it, and its whole subtree, in local files. Unset (the default) leaves `sql` unchanged.
// Like the rest of this domain, resolved once at start-up by `session-storage-config.ts`, which
// refuses a malformed value instead of reading it as unset.
export const cfgSessionSqlOffboxCheck = register({
	id: "session.sql.offboxCheck",
	type: "array",
	default: [] as readonly string[],
	env: "OMP_SESSION_SQL_OFFBOX_CHECK",
});

export const cfgSessionSqlOffboxCheckTimeoutMs = register({
	id: "session.sql.offboxCheckTimeoutMs",
	type: "number",
	default: 60_000,
	env: "OMP_SESSION_SQL_OFFBOX_CHECK_TIMEOUT_MS",
});
