/**
 * Opens `AgentStorage` on the given agent.db as soon as the start file appears, so several processes
 * create the same fresh database at once. Prints `OK` or the error. Gives up after 60 s without the
 * start file, so a test that dies early leaves no process behind.
 *
 * Usage: agent-storage-concurrent-open.ts <agent.db path> <start file>
 */
import * as fs from "node:fs";
import { AgentStorage } from "../../src/session/agent-storage";

const [dbPath, startFile] = process.argv.slice(2);
if (!dbPath || !startFile) throw new Error("usage: agent-storage-concurrent-open <agent.db path> <start file>");

process.stdout.write("READY\n");
const deadline = Date.now() + 60_000;
while (!fs.existsSync(startFile)) {
	if (Date.now() > deadline) {
		process.stdout.write("ERROR no start file within 60 s\n");
		process.exit(1);
	}
	await Bun.sleep(1);
}
try {
	await AgentStorage.open(dbPath);
	AgentStorage.close();
	process.stdout.write("OK\n");
} catch (error) {
	process.stdout.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
}
process.exit(0);
