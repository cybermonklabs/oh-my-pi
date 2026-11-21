/**
 * Which errors are the session store refusing a write (kept in memory and sent again once the store
 * accepts writes) and which are not (they reject or latch as before). The SQL shapes are the ones
 * Bun 1.4.4's client gives against PostgreSQL 16 and SQLite: a refused connection, a pooler that dies
 * mid-query, no answer, a read-only transaction, a backend the server ends, a read-only database.
 */
import { describe, expect, it } from "bun:test";
import { SessionPersistenceIndeterminateError } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	isSessionStoreWriteRefusal,
	SessionLockError,
	SessionWriteConflictError,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";

function shaped(fields: Record<string, unknown>, message = "store error"): Error {
	return Object.assign(new Error(message), fields);
}

describe("isSessionStoreWriteRefusal", () => {
	const refusals: Array<[string, Error]> = [
		["a full disk (ENOSPC)", shaped({ code: "ENOSPC" })],
		["an exceeded quota (EDQUOT)", shaped({ code: "EDQUOT" })],
		["a read-only file system (EROFS)", shaped({ code: "EROFS" })],
		["a denied write (EACCES)", shaped({ code: "EACCES" })],
		["a denied operation (EPERM)", shaped({ code: "EPERM" })],
		[
			"a refused PostgreSQL connection",
			shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" }, "Failed to connect"),
		],
		[
			"a PostgreSQL connection closed mid-query",
			shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }, "Connection closed"),
		],
		[
			"a PostgreSQL connection that is not answered",
			shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }, "Connection timeout after 2s"),
		],
		[
			"a read-only transaction (25006)",
			shaped(
				{ name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "25006" },
				"cannot execute INSERT in a read-only transaction",
			),
		],
		[
			"a backend the server ends (57P01)",
			shaped(
				{ name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "57P01" },
				"terminating connection due to administrator command",
			),
		],
		[
			"a full database disk (53100)",
			shaped({ name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "53100" }, "could not extend file"),
		],
		[
			"a read-only SQLite database",
			shaped({ name: "SQLiteError", code: "SQLITE_READONLY", errno: 8 }, "attempt to write a readonly database"),
		],
		[
			"a full SQLite database",
			shaped({ name: "SQLiteError", code: "SQLITE_FULL", errno: 13 }, "database or disk is full"),
		],
		[
			"a failed repair whose failures include a refusal",
			new SessionPersistenceIndeterminateError(
				shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_REFUSED" }, "Failed to connect"),
				[new Error("Failed to close session writer before authoritative repair.")],
			),
		],
		[
			"an uncoded store error whose cause is a refusal",
			new Error("a fence's lock read was refused within its bound", {
				cause: shaped({ name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }, "Connection closed"),
			}),
		],
	];
	for (const [what, error] of refusals) {
		it(`is a refusal: ${what}`, () => {
			expect(isSessionStoreWriteRefusal(error)).toBe(true);
		});
	}

	const others: Array<[string, unknown]> = [
		["a write conflict", new SessionWriteConflictError("/s.jsonl", 10, 12)],
		["a held publish lock", new SessionLockError("/s.jsonl", "another writer holds the publish lock")],
		[
			"a database permission error (42501)",
			shaped(
				{ name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "42501" },
				"permission denied for table probe",
			),
		],
		[
			"a missing table (42P01)",
			shaped(
				{ name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "42P01" },
				"relation does not exist",
			),
		],
		["a missing path (ENOENT)", shaped({ code: "ENOENT" })],
		["a non-directory where a directory belongs (EEXIST)", shaped({ code: "EEXIST" })],
		["a directory where the file belongs (EISDIR)", shaped({ code: "EISDIR" })],
		["an error with no code", new Error("boom")],
		["a value that is not an error", { code: "ENOSPC" }],
		[
			"a failed repair that also met a write conflict",
			new SessionPersistenceIndeterminateError(shaped({ code: "ENOSPC" }), [
				new SessionWriteConflictError("/s.jsonl", 10, 12),
			]),
		],
		[
			"a failed repair that met no refusal",
			new SessionPersistenceIndeterminateError(new Error("boom"), [new Error("the repair did not match")]),
		],
		[
			"a coded error that is not a refusal, whatever its cause",
			Object.assign(
				new Error("permission denied for table omp_session_files", { cause: shaped({ code: "ENOSPC" }) }),
				{
					name: "PostgresError",
					code: "ERR_POSTGRES_SERVER_ERROR",
					errno: "42501",
				},
			),
		],
	];
	for (const [what, error] of others) {
		it(`is not a refusal: ${what}`, () => {
			expect(isSessionStoreWriteRefusal(error)).toBe(false);
		});
	}
});
