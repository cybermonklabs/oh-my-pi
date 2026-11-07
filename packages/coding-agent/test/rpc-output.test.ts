import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";
import { RpcOutputWriter } from "../src/modes/rpc/rpc-output";

afterEach(() => {
	mock.restore();
});

it("drains RPC command responses after stdin EOF while the real stdout pipe is backpressured", async () => {
	await using spoolDir = await TempDir.create("@rpc-output-pipe-");
	const child = Bun.spawn(
		[
			"bash",
			"-c",
			// Pass the ready line, then stop reading for 2 s (a real stalled pipe);
			// pipefail makes the exit status omp's, not the reader's.
			'set -o pipefail; "$0" "$@" | { IFS= read -r l; printf "%s\\n" "$l"; sleep 2; cat; }',
			process.execPath,
			path.join(import.meta.dir, "../src/cli.ts"),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--no-session",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: import.meta.dir,
			env: { ...process.env, PI_NO_TITLE: "1", TMPDIR: spoolDir.path() },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const chunks: Uint8Array[] = [];
	try {
		const ready = await reader.read();
		if (ready.done) throw new Error(`RPC exited before ready: ${await stderr}`);
		chunks.push(ready.value);
		for (let id = 0; id < 320; id++) {
			child.stdin.write(`${JSON.stringify({ type: "get_state", id: `${id}:${"x".repeat(32768)}` })}\n`);
		}
		await child.stdin.flush();
		child.stdin.end();
		// About 30 MB of replies (320 get_state responses of ~94 KB) against the 8 MiB in-flight budget: the writer must spill.
		let spooled = false;
		for (let attempt = 0; attempt < 40 && !spooled; attempt++) {
			spooled = fs.readdirSync(spoolDir.path()).some(name => name.startsWith("omp-rpc-output-"));
			if (!spooled) await Bun.sleep(50);
		}
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			chunks.push(next.value);
		}
		const output = Buffer.concat(chunks).toString();
		const replies: { id: string; type: string; success?: boolean }[] = output
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(replies.filter(reply => reply.type === "response").map(reply => reply.id.split(":")[0])).toEqual(
			Array.from({ length: 320 }, (_, id) => String(id)),
		);
		expect(spooled).toBe(true);
		expect(await child.exited).toBe(0);
	} finally {
		reader.releaseLock();
		// child is the bash wrapper; reach omp underneath it too.
		killProcessTree(child.pid);
		await child.exited.catch(() => {});
		await stderr;
	}
}, 30_000);

it("delivers ordered v1 and chunked v2 frames through a slow sink before close completes", async () => {
	const chunks: Buffer[] = [];
	const sink = new Writable({
		highWaterMark: 1024,
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			void Bun.sleep(1).then(() => callback());
		},
	});
	const errors: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => errors.push(error), 1024);
	const encoder = new RpcFrameEncoder();
	const expected: object[] = [{ type: "ready" }, { type: "response", command: "negotiate_protocol", success: true }];
	for (const frame of expected) writer.write(encoder.encodeFrames(frame));
	encoder.setProtocolVersion(2);
	for (let id = 0; id < 32; id++) {
		const frame = { type: "response", id, data: `${id}:${"🌍".repeat(id === 4 ? 300_000 : 8192)}` };
		expected.push(frame);
		writer.write(encoder.encodeFrames(frame));
	}
	const final = { type: "agent_end", messages: [] };
	expected.push(final);
	writer.write(encoder.encodeFrames(final));
	await writer.close();
	const decoder = new RpcFrameDecoder();
	const actual = Buffer.concat(chunks)
		.toString()
		.trimEnd()
		.split("\n")
		.map(line => decoder.push(JSON.parse(line)))
		.filter(frame => frame !== undefined);
	expect(actual).toEqual(expected);
	expect(errors).toEqual([]);
});

it("fails promptly and removes spilled output when the reader disconnects", async () => {
	await using dir = await TempDir.create("@rpc-output-disconnect-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failure = Promise.withResolvers<Error>();
	const writer = new RpcOutputWriter(sink, failure.resolve, 1);
	writer.write(["first\n", "pending\n"]);
	const closed = writer.close();
	sink.destroy(new Error("reader disconnected"));
	await expect(closed).rejects.toThrow("reader disconnected");
	expect((await failure.promise).message).toBe("reader disconnected");
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
});

it("reports disk exhaustion and removes the partial spool instead of silently dropping accepted output", async () => {
	await using dir = await TempDir.create("@rpc-output-enospc-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	spyOn(fs, "writeSync").mockImplementation(() => {
		throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
	});
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error), 1);
	writer.write(["first\n", "pending\n"]);
	await expect(writer.close()).rejects.toThrow("disk full");
	expect(failures.map(error => error.message)).toEqual(["disk full"]);
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
	sink.destroy();
});

it("reports a truncated spool during delivery instead of completing a partial protocol stream", async () => {
	await using dir = await TempDir.create("@rpc-output-truncated-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	let release: (() => void) | undefined;
	const sink = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, callback) {
			release = callback;
		},
	});
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error), 1);
	writer.write(["first\n", "pending\n"]);
	const closed = writer.close();
	fs.truncateSync(dir.join("output"), 0);
	release?.();
	await expect(closed).rejects.toThrow("spool ended before delivery completed");
	expect(failures.map(error => error.message)).toEqual(["RPC output spool ended before delivery completed"]);
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
	sink.destroy();
});

it("keeps a large-frame burst in memory while the reader keeps up", async () => {
	// Regression: v18.4.7 spilled every frame written while a sink write was
	// pending, so a large-frame burst went through the disk even though the
	// reader drained promptly — a 50 KB streamed reply wrote ~10 MB of spool.
	const createSpool = spyOn(TempDir, "createSync");
	const chunks: Buffer[] = [];
	const sink = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			queueMicrotask(() => callback());
		},
	});
	const errors: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => errors.push(error));
	const encoder = new RpcFrameEncoder();
	const expected = [
		{ type: "message_update", text: "x".repeat(64 * 1024) },
		{ type: "message_end", text: "y".repeat(64 * 1024) },
		{ type: "turn_end" },
		{ type: "agent_end", messages: [] },
	];
	for (const frame of expected) writer.write(encoder.encodeFrames(frame));
	await writer.close();

	expect(createSpool).not.toHaveBeenCalled();
	const decoder = new RpcFrameDecoder();
	const actual = Buffer.concat(chunks)
		.toString()
		.trimEnd()
		.split("\n")
		.map(line => decoder.push(JSON.parse(line)))
		.filter(frame => frame !== undefined);
	expect(actual).toEqual(expected);
	expect(errors).toEqual([]);
});

/**
 * Run the stdout-writer fixture on a real pipe. "acked": the child writes each
 * frame only after this process has read the previous one. "burst": the child
 * writes every frame in one synchronous loop, so no write callback fires until
 * it ends; to the writer that is a reader that has taken nothing.
 */
async function runStdoutWriter(args: { frames: number; frameBytes: number; budget: number; mode: "acked" | "burst" }) {
	await using tmp = await TempDir.create("@rpc-output-stdout-");
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/rpc-output-stdout-writer.ts"),
			String(args.frames),
			String(args.frameBytes),
			String(args.budget),
			args.mode,
		],
		{ env: { ...process.env, TMPDIR: tmp.path() }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const stderr = child.stderr.getReader();
	const readReport = async (): Promise<{ spooled: boolean; retainedBytes: number }> => {
		let text = "";
		while (!text.includes("\n")) {
			const next = await stderr.read();
			if (next.done) throw new Error(`fixture exited without a report: ${text}`);
			text += new TextDecoder().decode(next.value);
		}
		return JSON.parse(text.slice(0, text.indexOf("\n")));
	};
	// Acknowledge each frame as it arrives; the acked child writes the next one only then.
	const readAcked = async (): Promise<string> => {
		const chunks: Uint8Array[] = [];
		for await (const chunk of child.stdout) {
			chunks.push(chunk);
			for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) child.stdin.write("\n");
			await child.stdin.flush();
		}
		return Buffer.concat(chunks).toString();
	};
	const stdout = args.mode === "acked" ? readAcked() : new Response(child.stdout).text();
	const report = await readReport();
	const output = await stdout;
	child.stdin.end();
	stderr.releaseLock();
	expect(await child.exited).toBe(0);
	const order = output
		.trimEnd()
		.split("\n")
		.map(line => (JSON.parse(line) as { i: number }).i);
	return { report, order };
}

it("spills to disk with bounded memory when a real stdout reader stalls", async () => {
	// Regression: Bun's process.stdout never charges writableLength, so a
	// budget read from the stream never fired — a stalled reader grew the
	// writer's queue without bound and nothing spilled.
	const { report, order } = await runStdoutWriter({
		frames: 512,
		frameBytes: 256 * 1024,
		budget: 4 * 1024 * 1024,
		mode: "burst",
	});
	expect(report.spooled).toBe(true);
	// 128 MiB of frames pass through; only the 4 MiB budget may stay queued in memory.
	expect(report.retainedBytes).toBeLessThan(80 * 1024 * 1024);
	expect(order).toEqual(Array.from({ length: 512 }, (_, i) => i));
}, 60_000);

it("writes straight to a real stdout pipe while its reader keeps up", async () => {
	// 16 MiB through a 4 MiB budget, each frame written only after this reader took
	// the previous one: a writer that counts lifetime bytes instead of in-flight
	// bytes spills here, and any spill fails this.
	// Can't model a stalled reader: Bun drains a child's stdout unread. The burst and cli.ts tests cover stalls.
	const { report, order } = await runStdoutWriter({
		frames: 256,
		frameBytes: 64 * 1024,
		budget: 4 * 1024 * 1024,
		mode: "acked",
	});
	expect(report.spooled).toBe(false);
	expect(order).toEqual(Array.from({ length: 256 }, (_, i) => i));
}, 60_000);

it("delivers a spool opened while the sink still accepts writes", async () => {
	// A budget below the sink's high-water mark spills after a write() that
	// returned true, so no `drain` follows; close() used to wait forever.
	const chunks: Buffer[] = [];
	const sink = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			queueMicrotask(() => callback());
		},
	});
	const writer = new RpcOutputWriter(sink, () => {}, 1);
	writer.write(["first\n", "second\n", "third\n"]);
	await writer.close();
	expect(Buffer.concat(chunks).toString()).toBe("first\nsecond\nthird\n");
}, 5_000);

/** Kill a process and its descendants (Linux /proc; elsewhere just the process). */
function killProcessTree(pid: number): void {
	let children: number[] = [];
	try {
		children = fs
			.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(Number);
	} catch {}
	for (const child of children) killProcessTree(child);
	try {
		process.kill(pid, "SIGKILL");
	} catch {}
}
