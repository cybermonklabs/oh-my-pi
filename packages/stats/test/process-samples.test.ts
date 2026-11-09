import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getProcessSampleSeries, initDb } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-process-samples-");

const FOLDER_SLUG = "--tmp--process-samples";

const TS1 = "2026-11-09T19:00:00.000Z";
const TS2 = "2026-11-09T19:01:00.000Z";
const TS3 = "2026-11-09T19:02:00.000Z";
const TS4 = "2026-11-09T19:07:00.000Z";
const TS5 = "2026-11-09T19:08:00.000Z";

const CGROUP_MAX = 64 * 1024 ** 3;

const PID = 4242;
const STARTED_AT_MS = Date.parse("2026-11-09T18:30:00.000Z");

interface SampleOptions {
	entryId: string;
	timestamp: string;
	seq: number;
	reason: "start" | "interval" | "turn" | "compaction";
	rssKb: number;
	cgroupAnon?: number | null;
	cgroupMax?: number | null;
	workers?: Array<{
		thread: string;
		jscHeapBytes: number | null;
		cpuMs?: number | null;
		missing?: "timeout" | "gone" | "error";
	}>;
	toolCalls?: number;
	/**
	 * Cumulative tokens at sample time. `false` writes an older-shaped entry whose
	 * `work` carries no token fields at all.
	 */
	tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | false;
	/** Subagent worker threads in the sampled process; defaults to none. */
	subagentWorkers?: number;
	/** Which incarnation wrote the sample; omitted entirely when `identity` is false. */
	pid?: number;
	startedAtMs?: number;
	/** A sample written before the sampler carried an identity. */
	identity?: false;
}

/** One `process_sample` journal entry as the session writes it. */
function buildSampleEntry(opts: SampleOptions): unknown {
	const cgroupAnon = opts.cgroupAnon === undefined ? 8 * 1024 ** 3 : opts.cgroupAnon;
	const cgroupMax = opts.cgroupMax === undefined ? CGROUP_MAX : opts.cgroupMax;
	return {
		type: "process_sample",
		id: opts.entryId,
		parentId: null,
		timestamp: opts.timestamp,
		activeLeafId: null,
		sample: {
			...(opts.identity === false
				? {}
				: { identity: { pid: opts.pid ?? PID, startedAtMs: opts.startedAtMs ?? STARTED_AT_MS } }),
			seq: opts.seq,
			reason: opts.reason,
			uptimeMs: opts.seq * 60_000,
			cpu: { userMs: 1_000 * opts.seq, systemMs: 200 * opts.seq },
			process: { rssKb: opts.rssKb, anonKb: opts.rssKb - 1000, fileKb: 1000, threads: 12 + opts.seq },
			cgroup:
				cgroupAnon === null
					? null
					: {
							path: "/sys/fs/cgroup/user.slice",
							anon: cgroupAnon,
							file: 1024 ** 3,
							current: cgroupAnon + 1024 ** 3,
							max: cgroupMax,
						},
			main: {
				thread: "main",
				jscHeapBytes: 200_000_000 + opts.seq,
				jscFootprintBytes: 300_000_000,
				pageFaults: 50_000 * opts.seq,
				heapUsedBytes: 100,
				heapTotalBytes: 200,
				externalBytes: 300,
				cpuMs: 900 * opts.seq,
			},
			workers: opts.workers ?? [],
			work: {
				journalEntries: 100 * opts.seq,
				toolCalls: opts.toolCalls ?? 10 * opts.seq,
				topTools: [
					["read", 7 * opts.seq],
					["bash", 3 * opts.seq],
				],
				subagentDispatches: opts.seq,
				fileReads: 7 * opts.seq,
				compactions: opts.seq - 1,
				liveSubagents: 2,
				parkedSubagents: 3,
				...(opts.tokens === false
					? {}
					: {
							tokens: opts.tokens ?? {
								input: 1_000_000 * opts.seq,
								output: 20_000 * opts.seq,
								cacheRead: 500_000 * opts.seq,
								cacheWrite: 100_000 * opts.seq,
								total: 1_620_000 * opts.seq,
							},
							tokensIncludeSubagents: false,
							subagentWorkers: opts.subagentWorkers ?? 0,
						}),
			},
			costMs: 1.5,
		},
	};
}

async function writeSessionFile(fileName: string, entries: unknown[]): Promise<string> {
	const sessionDir = path.join(getSessionsDir(), FOLDER_SLUG);
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionFile = path.join(sessionDir, fileName);
	const header = {
		type: "session",
		version: 3,
		id: "sess-samples",
		timestamp: TS1,
		cwd: "/tmp/project",
	};
	const lines = [header, ...entries].map(entry => JSON.stringify(entry)).join("\n");
	await Bun.write(sessionFile, `${lines}\n`);
	return sessionFile;
}

describe("process sample ingestion", () => {
	it("stores every sample's scalars and serves the session series in time order", async () => {
		const sessionFile = await writeSessionFile("session.jsonl", [
			buildSampleEntry({ entryId: "ps-1", timestamp: TS1, seq: 1, reason: "start", rssKb: 400_000 }),
			buildSampleEntry({
				entryId: "ps-2",
				timestamp: TS2,
				seq: 2,
				reason: "interval",
				rssKb: 900_000,
				workers: [
					{ thread: "w1", jscHeapBytes: 50_000_000, cpuMs: 1_200 },
					{ thread: "w2", jscHeapBytes: 30_000_000, cpuMs: 800 },
					{ thread: "w3", jscHeapBytes: null, cpuMs: null, missing: "timeout" },
				],
			}),
			// Same millisecond as ps-2's successor would be: uniqueness rides on the entry id.
			buildSampleEntry({
				entryId: "ps-3",
				timestamp: TS3,
				seq: 3,
				reason: "turn",
				rssKb: 1_500_000,
				cgroupMax: null,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const series = await getProcessSampleSeries(sessionFile);
		if (!series) throw new Error("expected a process sample series");
		expect(series.sessionFile).toBe(sessionFile);
		expect(series.folder).toBe("/tmp/process-samples");
		// One live process wrote every sample, so the series is one segment.
		expect(series.segments).toHaveLength(1);
		expect(series.segments[0].pid).toBe(PID);
		expect(series.segments[0].startedAtMs).toBe(STARTED_AT_MS);
		expect(series.segments[0].points.map(point => point.seq)).toEqual([1, 2, 3]);

		const [first, second, third] = series.segments[0].points;
		expect(first.reason).toBe("start");
		expect(first.timestamp).toBe(Date.parse(TS1));
		expect(first.rssKb).toBe(400_000);
		expect(first.anonKb).toBe(399_000);
		expect(first.threads).toBe(13);
		expect(first.uptimeMs).toBe(60_000);
		expect(first.costMs).toBeCloseTo(1.5, 6);
		expect(first.mainJscHeapBytes).toBe(200_000_001);
		expect(first.cpuUserMs).toBe(1_000);
		expect(first.cpuSystemMs).toBe(200);
		expect(first.mainCpuMs).toBe(900);
		expect(first.mainPageFaults).toBe(50_000);
		// Diagnostic only: stored because the gap to rssKb is the signal.
		expect(first.mainHeapUsedBytes).toBe(100);
		expect(first.workerCount).toBe(0);
		expect(first.workerJscHeapBytes).toBeNull();
		expect(first.workerCpuMs).toBeNull();
		expect(first.journalEntries).toBe(100);
		expect(first.toolCalls).toBe(10);
		expect(first.subagentDispatches).toBe(1);
		expect(first.fileReads).toBe(7);
		expect(first.compactions).toBe(0);
		expect(first.liveSubagents).toBe(2);
		expect(first.parkedSubagents).toBe(3);
		expect(first.topTools).toEqual([
			["read", 7],
			["bash", 3],
		]);
		// anon / max, computed server-side.
		expect(first.cgroupAnon).toBe(8 * 1024 ** 3);
		expect(first.cgroupCurrent).toBe(9 * 1024 ** 3);
		expect(first.cgroupMax).toBe(CGROUP_MAX);
		expect(first.cgroupRatio).toBeCloseTo(0.125, 9);

		// The token counters, and the ratio the retention hypothesis is stated in.
		expect(first.tokensInput).toBe(1_000_000);
		expect(first.tokensOutput).toBe(20_000);
		expect(first.tokensCacheRead).toBe(500_000);
		expect(first.tokensCacheWrite).toBe(100_000);
		expect(first.tokensTotal).toBe(1_620_000);
		expect(first.tokensIncludeSubagents).toBe(false);
		expect(first.subagentWorkers).toBe(0);
		// anon_kb * 1024 / tokens_total, computed server-side so every reader agrees.
		expect(first.bytesPerToken).toBeCloseTo((399_000 * 1024) / 1_620_000, 9);
		expect(third.bytesPerToken).toBeCloseTo((1_499_000 * 1024) / 4_860_000, 9);

		// A worker that did not answer is counted but contributes no heap and no CPU.
		expect(second.workerCount).toBe(3);
		expect(second.workerJscHeapBytes).toBe(80_000_000);
		expect(second.workerCpuMs).toBe(2_000);
		expect(second.reason).toBe("interval");

		// An unlimited cgroup has no wall, so no ratio.
		expect(third.cgroupMax).toBeNull();
		expect(third.cgroupRatio).toBeNull();
		expect(third.rssKb).toBe(1_500_000);

		const database = await initDb();
		expect(
			database
				.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM process_samples WHERE session_file = ?")
				.get(sessionFile)?.n,
		).toBe(3);
		// Stored, not only derived: the columns are the table's most important data.
		expect(
			database
				.query<
					{
						tokens_input: number | null;
						tokens_output: number | null;
						tokens_cache_read: number | null;
						tokens_cache_write: number | null;
						tokens_total: number | null;
						tokens_include_subagents: number | null;
						subagent_workers: number | null;
					},
					[string]
				>(
					`SELECT tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
						tokens_total, tokens_include_subagents, subagent_workers
					FROM process_samples WHERE session_file = ? AND entry_id = 'ps-2'`,
				)
				.get(sessionFile),
		).toEqual({
			tokens_input: 2_000_000,
			tokens_output: 40_000,
			tokens_cache_read: 1_000_000,
			tokens_cache_write: 200_000,
			tokens_total: 3_240_000,
			tokens_include_subagents: 0,
			subagent_workers: 0,
		});
	});

	it("returns null for a session that wrote no samples", async () => {
		const sessionFile = await writeSessionFile("empty.jsonl", []);
		await syncAllSessions({ workers: 1 });
		expect(await getProcessSampleSeries(sessionFile)).toBeNull();
	});

	it("replaces a rewritten transcript's samples instead of accumulating them", async () => {
		const sessionFile = await writeSessionFile("replaced.jsonl", [
			buildSampleEntry({ entryId: "ps-1", timestamp: TS1, seq: 1, reason: "start", rssKb: 400_000 }),
			buildSampleEntry({ entryId: "ps-2", timestamp: TS2, seq: 2, reason: "interval", rssKb: 900_000 }),
		]);
		await syncAllSessions({ workers: 1 });
		expect((await getProcessSampleSeries(sessionFile))?.segments[0].points).toHaveLength(2);

		// A shorter replacement at the same path: the old samples must not survive it.
		await writeSessionFile("replaced.jsonl", [
			buildSampleEntry({ entryId: "ps-9", timestamp: TS3, seq: 1, reason: "start", rssKb: 123_000 }),
		]);
		await syncAllSessions({ workers: 1 });

		const series = await getProcessSampleSeries(sessionFile);
		expect(series?.segments.flatMap(segment => segment.points).map(point => point.entryId)).toEqual(["ps-9"]);
		expect(series?.segments[0].points[0].rssKb).toBe(123_000);
	});

	it("breaks one journal's samples into a segment per incarnation", async () => {
		// One session, killed after three samples and restarted five minutes later. The
		// journal marks the restart nowhere: only the identity change does.
		const restartPid = 5150;
		const restartStartedAtMs = Date.parse("2026-11-09T19:06:30.000Z");
		const sessionFile = await writeSessionFile("restarted.jsonl", [
			buildSampleEntry({ entryId: "ps-1", timestamp: TS1, seq: 1, reason: "start", rssKb: 400_000 }),
			buildSampleEntry({ entryId: "ps-2", timestamp: TS2, seq: 2, reason: "interval", rssKb: 900_000 }),
			buildSampleEntry({ entryId: "ps-3", timestamp: TS3, seq: 3, reason: "turn", rssKb: 1_500_000 }),
			buildSampleEntry({
				entryId: "ps-4",
				timestamp: TS4,
				seq: 1,
				reason: "start",
				rssKb: 300_000,
				pid: restartPid,
				startedAtMs: restartStartedAtMs,
			}),
			buildSampleEntry({
				entryId: "ps-5",
				timestamp: TS5,
				seq: 2,
				reason: "interval",
				rssKb: 350_000,
				pid: restartPid,
				startedAtMs: restartStartedAtMs,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const series = await getProcessSampleSeries(sessionFile);
		if (!series) throw new Error("expected a process sample series");
		// Two runs, never one: a curve drawn across them would fall 1.5 GiB to 300 MiB
		// at a cliff no process experienced.
		expect(series.segments).toHaveLength(2);
		expect(series.segments.map(segment => segment.pid)).toEqual([PID, restartPid]);
		expect(series.segments.map(segment => segment.startedAtMs)).toEqual([STARTED_AT_MS, restartStartedAtMs]);
		expect(series.segments[0].points.map(point => point.entryId)).toEqual(["ps-1", "ps-2", "ps-3"]);
		expect(series.segments[1].points.map(point => point.entryId)).toEqual(["ps-4", "ps-5"]);
		// The restart resets seq, so seq alone cannot order the journal; the segments can.
		expect(series.segments[1].points.map(point => point.seq)).toEqual([1, 2]);
		expect(series.segments[0].points.at(-1)?.rssKb).toBe(1_500_000);
		expect(series.segments[1].points[0].rssKb).toBe(300_000);

		// The identity is stored, not only derived: a query can ask for one incarnation.
		const database = await initDb();
		expect(
			database
				.query<{ n: number }, [string, number, number]>(
					"SELECT COUNT(*) AS n FROM process_samples WHERE session_file = ? AND pid = ? AND started_at_ms = ?",
				)
				.get(sessionFile, restartPid, restartStartedAtMs)?.n,
		).toBe(2);
	});

	it("keeps samples that carry no identity in one segment rather than splitting them", async () => {
		const sessionFile = await writeSessionFile("no-identity.jsonl", [
			buildSampleEntry({
				entryId: "ps-1",
				timestamp: TS1,
				seq: 1,
				reason: "start",
				rssKb: 400_000,
				identity: false,
			}),
			buildSampleEntry({
				entryId: "ps-2",
				timestamp: TS2,
				seq: 2,
				reason: "interval",
				rssKb: 900_000,
				identity: false,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const series = await getProcessSampleSeries(sessionFile);
		expect(series?.segments).toHaveLength(1);
		expect(series?.segments[0].pid).toBeNull();
		expect(series?.segments[0].startedAtMs).toBeNull();
		expect(series?.segments[0].points).toHaveLength(2);
	});

	it("leaves the token columns null on an older entry that carries none", async () => {
		const sessionFile = await writeSessionFile("no-tokens.jsonl", [
			buildSampleEntry({
				entryId: "ps-1",
				timestamp: TS1,
				seq: 1,
				reason: "start",
				rssKb: 400_000,
				tokens: false,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const point = (await getProcessSampleSeries(sessionFile))?.segments[0].points[0];
		if (!point) throw new Error("expected a point");
		// Null and never zero: an unknown count must not read as a session that sent nothing.
		expect(point.tokensInput).toBeNull();
		expect(point.tokensOutput).toBeNull();
		expect(point.tokensCacheRead).toBeNull();
		expect(point.tokensCacheWrite).toBeNull();
		expect(point.tokensTotal).toBeNull();
		expect(point.tokensIncludeSubagents).toBeNull();
		expect(point.subagentWorkers).toBeNull();
		expect(point.bytesPerToken).toBeNull();
		// The rest of the sample is stored as before.
		expect(point.rssKb).toBe(400_000);
		expect(point.journalEntries).toBe(100);
	});

	it("reports no bytes-per-token for a sample with zero tokens counted", async () => {
		const sessionFile = await writeSessionFile("zero-tokens.jsonl", [
			buildSampleEntry({
				entryId: "ps-1",
				timestamp: TS1,
				seq: 1,
				reason: "start",
				rssKb: 400_000,
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				subagentWorkers: 4,
			}),
		]);
		await syncAllSessions({ workers: 1 });

		const point = (await getProcessSampleSeries(sessionFile))?.segments[0].points[0];
		if (!point) throw new Error("expected a point");
		// A real zero is stored as a zero; it is only the ratio that has no value.
		expect(point.tokensTotal).toBe(0);
		expect(point.tokensInput).toBe(0);
		expect(point.tokensIncludeSubagents).toBe(false);
		expect(point.subagentWorkers).toBe(4);
		expect(point.bytesPerToken).toBeNull();
	});
});
