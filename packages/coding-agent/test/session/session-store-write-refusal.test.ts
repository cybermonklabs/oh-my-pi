/**
 * Which errors are the session store refusing a write, and of which kind. A refusal keeps the entries
 * in memory for a later send. An outage (a full disk, a store that is down, busy or read-only for now)
 * also waits for another session's write to land on the same store; a permission refusal waits only on
 * the session's own writes. Every other error rejects or latches as before. The SQL shapes are the ones
 * Bun 1.4.4's client gives against PostgreSQL 16, PgBouncer 1.22.0 and 1.26.1 in front of it, and
 * SQLite; PgBouncer's texts are read from its source at every release from 1.22.0 to 1.26.1.
 */
import { describe, expect, it } from "bun:test";
import { SessionPersistenceIndeterminateError } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	isSessionStoreOutage,
	isSessionStoreWriteRefusal,
	SessionLockError,
	SessionWriteConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

function shaped(fields: Record<string, unknown>, message = "store error"): Error {
	return Object.assign(new Error(message), fields);
}

/** A PostgreSQL server error as Bun's client gives it: the SQLSTATE is `errno`. */
function pgServerError(sqlState: string, message: string): Error {
	return shaped(
		{ name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: sqlState, severity: "FATAL" },
		message,
	);
}

type Kind = "outage" | "permission" | "none";

const cases: Array<[string, unknown, Kind]> = [
	["a full disk (ENOSPC)", shaped({ code: "ENOSPC" }), "outage"],
	["an exceeded quota (EDQUOT)", shaped({ code: "EDQUOT" }), "outage"],
	["a read-only file system (EROFS)", shaped({ code: "EROFS" }), "permission"],
	["a denied write (EACCES)", shaped({ code: "EACCES" }), "permission"],
	["a denied operation (EPERM)", shaped({ code: "EPERM" }), "permission"],
	[
		"a refused PostgreSQL connection",
		shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" }, "Failed to connect"),
		"outage",
	],
	[
		"a PostgreSQL connection closed mid-query",
		shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }, "Connection closed"),
		"outage",
	],
	[
		"a PostgreSQL connection that is not answered",
		shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }, "Connection timeout after 2s"),
		"outage",
	],
	[
		"a read-only transaction (25006)",
		pgServerError("25006", "cannot execute INSERT in a read-only transaction"),
		"outage",
	],
	[
		"a backend the server ends (57P01)",
		pgServerError("57P01", "terminating connection due to administrator command"),
		"outage",
	],
	["a full database disk (53100)", pgServerError("53100", "could not extend file"), "outage"],
	["PgBouncer with PostgreSQL down, the first query (08P01)", pgServerError("08P01", "query_wait_timeout"), "outage"],
	[
		"PgBouncer with PostgreSQL down, after a failed login (08P01)",
		pgServerError("08P01", "server login has been failing, try again later (server_login_retry)"),
		"outage",
	],
	[
		"PgBouncer at its client limit (08P01)",
		pgServerError("08P01", "no more connections allowed (max_client_conn)"),
		"outage",
	],
	[
		"PgBouncer, a login waiting for a server that is down (08P01)",
		pgServerError("08P01", "client_login_timeout (server down)"),
		"outage",
	],
	[
		"PgBouncer losing the server connection mid-query (08P01)",
		pgServerError("08P01", "server conn crashed?"),
		"outage",
	],
	[
		"PgBouncer 1.24 or later with PostgreSQL down, after a failed connect (08P01)",
		pgServerError("08P01", "server login has been failing, cached error: connect failed (server_login_retry)"),
		"outage",
	],
	[
		"PgBouncer 1.24 or later, after a server connect that timed out (08P01)",
		pgServerError("08P01", "server login has been failing, cached error: connect timeout (server_login_retry)"),
		"outage",
	],
	[
		"PgBouncer 1.24 or later, after a server login the server rejected: a wrong password (08P01)",
		pgServerError(
			"08P01",
			'server login has been failing, cached error: password authentication failed for user "app" (server_login_retry)',
		),
		"outage",
	],
	[
		"PgBouncer 1.24 or later, after a failed server DNS lookup (08P01)",
		pgServerError(
			"08P01",
			"server login has been failing, cached error: server DNS lookup failed (server_login_retry)",
		),
		"outage",
	],
	[
		"PgBouncer 1.24 or later, a login retry text cut at PgBouncer's 127 characters (08P01)",
		pgServerError("08P01", `server login has been failing, cached error: ${"r".repeat(200)}`.slice(0, 127)),
		"outage",
	],
	[
		"PgBouncer 1.24 or later at its per-database client limit (08P01)",
		pgServerError("08P01", "client connections exceeded (max_db_client_connections)"),
		"outage",
	],
	[
		"PgBouncer 1.24 or later at its per-user client limit (08P01)",
		pgServerError("08P01", "client connections exceeded (max_user_client_connections)"),
		"outage",
	],
	[
		"PgBouncer 1.23 or later shutting down after its servers, a client waiting for one (08P01)",
		pgServerError("08P01", "server shutting down"),
		"outage",
	],
	[
		"PgBouncer 1.25 or later shutting down, a new login (08P01)",
		pgServerError("08P01", "pooler is shutting down"),
		"outage",
	],
	[
		"a PgBouncer text with the login retry words later in it (08P01)",
		pgServerError("08P01", "unsupported startup parameter: server login has been failing"),
		"none",
	],
	["PgBouncer's own query limit, query_timeout (08P01)", pgServerError("08P01", "query_timeout"), "none"],
	[
		"PostgreSQL at max_connections, direct or forwarded by PgBouncer (53300)",
		pgServerError("53300", "remaining connection slots are reserved for roles with the SUPERUSER attribute"),
		"outage",
	],
	["PostgreSQL shutting down (57P03)", pgServerError("57P03", "the database system is shutting down"), "outage"],
	[
		"PostgreSQL's own protocol violation (08P01)",
		pgServerError("08P01", "invalid startup packet layout: expected terminator as last byte"),
		"none",
	],
	["another PgBouncer error (08P01)", pgServerError("08P01", "no such database: sessions"), "none"],
	[
		"a read-only SQLite database",
		shaped({ name: "SQLiteError", code: "SQLITE_READONLY", errno: 8 }, "attempt to write a readonly database"),
		"permission",
	],
	[
		"a full SQLite database",
		shaped({ name: "SQLiteError", code: "SQLITE_FULL", errno: 13 }, "database or disk is full"),
		"outage",
	],
	[
		"a failed repair whose failures include an outage",
		new SessionPersistenceIndeterminateError(
			shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" }, "Failed to connect"),
			[new Error("Failed to close session writer before authoritative repair.")],
		),
		"outage",
	],
	[
		"a failed repair whose only refusal is a permission refusal",
		new SessionPersistenceIndeterminateError(shaped({ code: "EACCES" }), [new Error("the repair did not match")]),
		"permission",
	],
	[
		"a failed repair that met an outage and a permission refusal",
		new SessionPersistenceIndeterminateError(shaped({ code: "EACCES" }), [shaped({ code: "ENOSPC" })]),
		"outage",
	],
	[
		"an uncoded store error whose cause is an outage",
		new Error("a fence's lock read was refused within its bound", {
			cause: shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }, "Connection closed"),
		}),
		"outage",
	],
	["a write conflict", new SessionWriteConflictError("/s.jsonl", 10, 12), "none"],
	["a held publish lock", new SessionLockError("/s.jsonl", "another writer holds the publish lock"), "none"],
	["a database permission error (42501)", pgServerError("42501", "permission denied for table probe"), "none"],
	["a missing table (42P01)", pgServerError("42P01", "relation does not exist"), "none"],
	["a missing path (ENOENT)", shaped({ code: "ENOENT" }), "none"],
	["a non-directory where a directory belongs (EEXIST)", shaped({ code: "EEXIST" }), "none"],
	["a directory where the file belongs (EISDIR)", shaped({ code: "EISDIR" }), "none"],
	["an error with no code", new Error("boom"), "none"],
	["a value that is not an error", { code: "ENOSPC" }, "none"],
	[
		"a failed repair that also met a write conflict",
		new SessionPersistenceIndeterminateError(shaped({ code: "ENOSPC" }), [
			new SessionWriteConflictError("/s.jsonl", 10, 12),
		]),
		"none",
	],
	[
		"a failed repair that met no refusal",
		new SessionPersistenceIndeterminateError(new Error("boom"), [new Error("the repair did not match")]),
		"none",
	],
	[
		"a coded error that is not a refusal, whatever its cause",
		Object.assign(new Error("permission denied for table omp_session_files", { cause: shaped({ code: "ENOSPC" }) }), {
			name: "PostgresError",
			code: "ERR_POSTGRES_SERVER_ERROR",
			errno: "42501",
		}),
		"none",
	],
];

describe("isSessionStoreWriteRefusal and isSessionStoreOutage", () => {
	for (const [what, error, kind] of cases) {
		it(`${kind === "none" ? "is not a refusal" : kind === "outage" ? "is an outage" : "is a permission refusal"}: ${what}`, () => {
			expect({ refusal: isSessionStoreWriteRefusal(error), outage: isSessionStoreOutage(error) }).toEqual({
				refusal: kind !== "none",
				outage: kind === "outage",
			});
		});
	}
});
