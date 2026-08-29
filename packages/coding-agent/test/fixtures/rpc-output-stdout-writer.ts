// Child for rpc-output.test.ts: writes JSONL frames through RpcOutputWriter on
// the real process.stdout, then reports on stderr whether a spool appeared and
// how much memory stayed retained. argv: <frames> <frameBytes> <budget> <acked|burst>
// "acked" writes each frame only after the parent acknowledges the previous one
// on stdin; "burst" writes every frame in one synchronous loop.
import * as fs from "node:fs";
import * as os from "node:os";
import { RpcOutputWriter } from "../../src/modes/rpc/rpc-output";

const [frames, frameBytes, budget] = process.argv.slice(2, 5).map(Number);
const acks = process.argv[5] === "acked" ? Bun.stdin.stream().getReader() : undefined;
const writer = new RpcOutputWriter(
	process.stdout,
	error => {
		process.stderr.write(`${JSON.stringify({ failure: error.message })}\n`);
		process.exit(2);
	},
	budget,
);
const payload = "x".repeat(frameBytes);
Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
let spooled = false;
for (let i = 0; i < frames; i++) {
	writer.write([`${JSON.stringify({ i, payload })}\n`]);
	// A delivered spool is deleted, so look while the frame that spilled still sits in it.
	spooled ||= fs.readdirSync(os.tmpdir()).some(name => name.startsWith("omp-rpc-output-"));
	if (acks) await acks.read();
}
// An open stdin reader keeps the process alive; the parent closes stdin only after stdout ends.
await acks?.cancel();
Bun.gc(true);
const retainedBytes = process.memoryUsage().rss - rssBefore;
process.stderr.write(`${JSON.stringify({ spooled, retainedBytes })}\n`);
await writer.close();
