/**
 * The Agent Hub roster restores a session's parked subagents from their
 * transcripts: a short read of each one's metadata, then a read of its whole
 * history for the row's metrics. Under `session.storage: sql` both stream the
 * transcript in chunks, and another store's full rewrite between two chunks
 * fails a read with `SessionReadConflictError`. The read then starts again
 * from the transcript's start, so the row shows one body's metadata and
 * metrics, never none; a history read raced on every pass leaves that one
 * row without metrics and the others hydrated. Runs on SQLite always, and on
 * PostgreSQL and MySQL when `OMP_TEST_SQL_POSTGRES_URL` /
 * `OMP_TEST_SQL_MYSQL_URL` name a database.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { line, MiB, raceAfterFirstChunk, STILL, TIMESTAMP } from "../session/chunked-read-race";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb } from "../session/sql-session-lease-fixture";

const ID = "01a1f000-0000-7000-8000-0000000000a1";

function sessionInit(agent: string): string {
	return line({
		type: "session_init",
		id: "i1",
		parentId: null,
		timestamp: TIMESTAMP,
		systemPrompt: ["You are a worker."],
		task: "work",
		tools: ["read"],
		agent,
	});
}

/** A 1.5 MiB entry the roster reads past, as a transcript's large tool output is. */
function pad(fill: string): string {
	return line({
		type: "custom",
		customType: "pad",
		id: "pad",
		parentId: null,
		timestamp: TIMESTAMP,
		data: fill.repeat(MiB + MiB / 2),
	});
}

/** `turns` assistant turns chained after the user turn `m1`, each costing `cost`. */
function assistantTurns(turns: number, cost: number): string[] {
	return Array.from({ length: turns }, (_, n) =>
		line({
			type: "message",
			id: `a${n}`,
			parentId: n === 0 ? "m1" : `a${n - 1}`,
			timestamp: TIMESTAMP,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `turn ${n}` }],
				provider: "anthropic",
				model: "claude-sonnet-5",
				stopReason: "stop",
				usage: { input: 10, output: 20, totalTokens: 30, cost: { total: cost } },
			},
		}),
	);
}

const header = line({ type: "session", version: 3, id: "worker", timestamp: TIMESTAMP, cwd: "/project" });
const userTurn = line({
	type: "message",
	id: "m1",
	parentId: null,
	timestamp: TIMESTAMP,
	message: { role: "user", content: "work", timestamp: 1 },
});

/** A session and its subagent `Worker`'s transcript, written by one store and read through another. */
async function roster(db: LeaseDb, worker: string[]) {
	const sessionFile = path.join(db.dir.path(), "sessions", "-project-", `2026-11-17T00-00-00-000Z_${ID}.jsonl`);
	const workerFile = path.join(sessionFile.slice(0, -".jsonl".length), "Worker.jsonl");
	const holder = await db.open({ lease: STILL });
	await holder.writeText(
		sessionFile,
		line({ type: "session", version: 3, id: ID, timestamp: TIMESTAMP, cwd: "/project" }),
	);
	await holder.writeLinesAtomic(workerFile, worker);
	await holder.drain();
	const reader = await db.open({ lease: STILL });
	const rewrite = async (next: string[]) => {
		await holder.writeLinesAtomic(workerFile, next, { expectedSize: holder.statSync(workerFile).size });
		await holder.drain();
	};
	return { sessionFile, workerFile, holder, reader, rewrite, registry: new AgentRegistry() };
}

for (const { adapter, url } of LEASE_BACKENDS) {
	describe.skipIf(!url)(
		`the persisted subagent roster over SQL transcripts another store rewrites (${adapter})`,
		() => {
			it("shows one body's metrics when the history read is raced after its first chunk", async () => {
				// If this regresses, the Agent Hub row of a parked subagent whose SQL transcript another process
				// rewrote while the hub loaded shows no requests, tokens or cost.
				await using db = await openLeaseDb(adapter, url ?? "");
				const before = [header, sessionInit("task"), userTurn, pad("a"), ...assistantTurns(2, 0.25)];
				const after = [header, sessionInit("task"), userTurn, pad("b"), ...assistantTurns(3, 1)];
				const { sessionFile, workerFile, reader, rewrite, registry } = await roster(db, before);
				await registerPersistedSubagents(registry, sessionFile, { hydrateHistory: false, storage: reader });
				const race = raceAfterFirstChunk(reader, workerFile, () => rewrite(after));

				await registerPersistedSubagents(registry, sessionFile, { storage: reader });

				const metrics = registry.get("Worker")?.history?.metrics;
				expect(race.ran).toBe(true);
				expect([
					{ requests: 2, cost: 0.5 },
					{ requests: 3, cost: 3 },
				]).toContainEqual({ requests: metrics?.requests ?? 0, cost: metrics?.cost ?? 0 });
			}, 120_000);

			it("restores the subagent with one body's metadata when the metadata read is raced after its first chunk", async () => {
				// If this regresses, a parked subagent whose SQL transcript another process rewrote while the hub
				// loaded is missing from the Agent Hub: its contract line past the first chunk goes unread.
				await using db = await openLeaseDb(adapter, url ?? "");
				const body = (agent: string, fill: string) => [header, pad(fill), sessionInit(agent), userTurn];
				const { sessionFile, workerFile, reader, rewrite, registry } = await roster(db, body("scout", "a"));
				const race = raceAfterFirstChunk(reader, workerFile, () => rewrite(body("reviewer", "b")));

				await registerPersistedSubagents(registry, sessionFile, { hydrateHistory: false, storage: reader });

				expect(race.ran).toBe(true);
				expect(["scout", "reviewer"]).toContain(registry.get("Worker")?.history?.agent ?? "no row");
			}, 120_000);

			it("hydrates the other subagents' metrics when one subagent's history read is raced on every pass", async () => {
				// If this regresses, one subagent whose SQL transcript another process keeps rewriting fails the
				// whole hydration, and the Agent Hub and the status line's tree cost miss the other subagents' cost.
				await using db = await openLeaseDb(adapter, url ?? "");
				const body = (fill: string) => [
					header,
					sessionInit("task"),
					userTurn,
					pad(fill),
					...assistantTurns(2, 0.25),
				];
				const { sessionFile, workerFile, holder, reader, rewrite, registry } = await roster(db, body("a"));
				const helperFile = path.join(path.dirname(workerFile), "Zed.jsonl");
				await holder.writeLinesAtomic(helperFile, body("c"));
				await holder.drain();
				await reader.refresh();
				await registerPersistedSubagents(registry, sessionFile, { hydrateHistory: false, storage: reader });
				// Every read of Worker's transcript meets a full rewrite after its first chunk.
				const readChunks = reader.readChunks.bind(reader);
				let rewrites = 0;
				spyOn(reader, "readChunks").mockImplementation((chunkPath: string, fromByte?: number) =>
					(async function* () {
						let first = true;
						for await (const chunk of readChunks(chunkPath, fromByte)) {
							yield chunk;
							if (!first || chunkPath !== workerFile) continue;
							first = false;
							rewrites++;
							await rewrite(body(rewrites % 2 === 0 ? "a" : "b"));
						}
					})(),
				);

				await registerPersistedSubagents(registry, sessionFile, { storage: reader });

				expect({
					rewrites,
					worker: registry.get("Worker")?.history?.metrics?.requests ?? "no metrics",
					helper: registry.get("Zed")?.history?.metrics?.requests ?? "no metrics",
				}).toEqual({ rewrites: 4, worker: "no metrics", helper: 2 });
			}, 120_000);
		},
	);
}
