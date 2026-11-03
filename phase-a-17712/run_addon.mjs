// Runs corpus rows through pi-natives' Shell, the session API the bash tool
// calls (crates/pi-natives/src/shell.rs): one `new Shell()` per row (or per
// multi-run session), one `shell.run({command, cwd, timeoutMs})` per tool call,
// output from the chunk callback (stdout and stderr as the tool sees them).
//
// usage: bun run_addon.mjs <addon.node> <corpus.jsonl> <out.jsonl> [shard] [shards] [ids-file]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const [addonPath, corpus, out, shardArg, shardsArg, idsFile] = process.argv.slice(2);
const addon = require(addonPath);
const shard = Number(shardArg ?? 0);
const shards = Number(shardsArg ?? 1);
const ids = idsFile ? new Set(fs.readFileSync(idsFile, "utf8").split("\n").filter(Boolean)) : null;
const scratch = "/mnt/nvme/sami/scratch/SignalDeathReport/Port17712-2/rows";
fs.mkdirSync(scratch, { recursive: true });
delete process.env.PI_SHELL_PREFIX;
process.env.TMPDIR = scratch;

const rows = fs
	.readFileSync(corpus, "utf8")
	.split("\n")
	.filter(Boolean)
	.map(line => JSON.parse(line))
	.filter((row, index) => index % shards === shard && (!ids || ids.has(row.id)));
const sink = fs.openSync(out, "w");

async function runOne(shell, command, cwd, budget) {
	let output = "";
	let result;
	try {
		result = await shell.run({ command, cwd, timeoutMs: budget }, (error, chunk) => {
			if (!error) output += chunk;
		});
	} catch (error) {
		result = { exception: String(error) };
	}
	return { exit: result.exitCode ?? null, timed_out: !!result.timedOut, cancelled: !!result.cancelled, exception: result.exception, output };
}

for (const row of rows) {
	const cwd = fs.mkdtempSync(path.join(scratch, "addon-"));
	const began = performance.now();
	const shell = new addon.Shell();
	let record;
	if (row.multi) {
		const runs = [];
		for (const command of row.multi) runs.push(await runOne(shell, command, cwd, row.budget_ms ?? 30000));
		record = { id: row.id, runs, exit: runs.at(-1).exit, output: runs.map(r => r.output).join("") };
	} else {
		record = { id: row.id, ...(await runOne(shell, row.script, cwd, row.budget_ms ?? 30000)) };
	}
	try {
		for (const pid of shell.pids?.() ?? []) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	} catch {}
	record.ms = Math.round(performance.now() - began);
	record.cwd = cwd;
	fs.writeSync(sink, JSON.stringify(record) + "\n");
	fs.rmSync(cwd, { recursive: true, force: true });
}
fs.closeSync(sink);
process.exit(0);
