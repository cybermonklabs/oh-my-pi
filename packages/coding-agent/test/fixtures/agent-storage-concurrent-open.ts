/**
 * Opens `AgentStorage` on the given agent.db as soon as the start file appears, so several processes
 * create the same fresh database at once. Prints `OK` or the error.
 *
 * Usage: agent-storage-concurrent-open.ts <agent.db path> <start file>
 */
import * as fs from "node:fs";
import { AgentStorage } from "../../src/session/agent-storage";

const [dbPath, startFile] = process.argv.slice(2);
if (!dbPath || !startFile) throw new Error("usage: agent-storage-concurrent-open <agent.db path> <start file>");

process.stdout.write("READY\n");
while (!fs.existsSync(startFile)) await Bun.sleep(1);
try {
	await AgentStorage.open(dbPath);
	AgentStorage.close();
	process.stdout.write("OK\n");
} catch (error) {
	process.stdout.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
}
process.exit(0);
