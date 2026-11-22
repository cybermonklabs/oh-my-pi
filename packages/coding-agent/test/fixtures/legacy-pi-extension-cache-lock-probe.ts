/**
 * Opens the legacy extension parse cache, as a legacy extension load does first, in a process that never
 * ran the CLI entry, and prints the kinds of record lock `/proc/locks` lists on the cache's database and
 * `-shm` files while it is open: `OFDLCK` for open-file-description locks, `POSIX` for this process's
 * POSIX locks.
 */
import * as fs from "node:fs";
import { getLegacyPiExtensionCacheDbPath } from "@oh-my-pi/pi-utils";
import { __isExtensionParseCacheAvailableForTests } from "../../src/extensibility/plugins/legacy-pi-compat";

if (!__isExtensionParseCacheAvailableForTests()) throw new Error("the parse cache did not open");
const cachePath = getLegacyPiExtensionCacheDbPath();
const inodes = new Set([cachePath, `${cachePath}-shm`].map(file => String(fs.statSync(file).ino)));
const kinds = new Set<string>();
// Each line: `<id>: <kind> <ADVISORY|MANDATORY> <READ|WRITE> <pid> <major>:<minor>:<inode> <start> <end>`.
for (const line of fs.readFileSync("/proc/locks", "utf8").split("\n")) {
	const fields = line.trim().split(/\s+/);
	if (fields.length < 6 || fields[1] === "->") continue;
	const [kind, , , pid, device] = fields.slice(1);
	const inode = device?.split(":").at(-1);
	if (!inode || !inodes.has(inode)) continue;
	// OFD locks list no owner (-1); POSIX locks list their process.
	if (kind === "OFDLCK" || (kind === "POSIX" && pid === String(process.pid))) kinds.add(kind);
}
process.stdout.write(JSON.stringify({ kinds: [...kinds].sort() }));
