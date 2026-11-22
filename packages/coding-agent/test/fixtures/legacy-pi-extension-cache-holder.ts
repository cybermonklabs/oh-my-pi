/**
 * Plays an omp process that started through the CLI: installs the SQLite lock shim (#15586), opens the
 * legacy extension parse cache, writes `READY`, and keeps the cache open until its stdin closes.
 */
import { ensureSqliteLockShim } from "@oh-my-pi/pi-utils";
import { __isExtensionParseCacheAvailableForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

ensureSqliteLockShim();
if (!__isExtensionParseCacheAvailableForTests()) throw new Error("the holder could not open the parse cache");
process.stdout.write("READY\n");
for await (const _ of process.stdin) {
	// Hold the cache until the test closes stdin.
}
