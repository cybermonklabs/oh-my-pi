/**
 * A full publish whose acknowledgement fails is read back from the store to
 * tell whether its body landed. Another process can rewrite the session while
 * that read-back is between two chunks, and the read then fails as a read race
 * (`SessionReadConflictError`). The read-back must read the session again from
 * its start, so a body that landed still counts as published. Each case runs
 * two SQL stores over one SQLite file, as two processes would.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

/** One custom entry's fill: twelve of them make a transcript of about 3 MiB, several chunks long. */
const PAD = "x".repeat(256 * 1024);

/** Two SQL stores over one SQLite file: `ours` runs the session, `theirs` is another process's. */
async function openStores() {
	const dir = TempDir.createSync("@omp-sql-readback-race-");
	const dsn = `sqlite://${dir.join("sessions.db")}`;
	const clients: InstanceType<typeof SQL>[] = [];
	const open = async (): Promise<SqlSessionStorage> => {
		const client = new SQL(dsn);
		clients.push(client);
		// The other store may hold the SQLite write lock for a moment.
		await client.unsafe("PRAGMA busy_timeout = 5000");
		return SqlSessionStorage.create({ client });
	};
	const ours = await open();
	const theirs = await open();
	return {
		ours,
		theirs,
		async [Symbol.asyncDispose]() {
			try {
				for (const storage of [ours, theirs]) await storage.drain().catch(() => undefined);
				for (const client of clients) await client.close();
			} finally {
				dir.removeSync();
			}
		},
	};
}

/** A session of about 3 MiB on `storage`, flushed. */
async function seededSession(storage: SessionStorage): Promise<{ manager: SessionManager; file: string }> {
	const manager = SessionManager.create("/cwd", path.resolve("/sessions/proj"), storage);
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		content: [{ type: "text", text: "seed" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	for (let n = 0; n < 12; n++) manager.appendCustomEntry("pad", { n, fill: PAD });
	await manager.flush();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a session file");
	return { manager, file };
}

/**
 * Make `ours`' next full rewrite land and then fail its acknowledgement, and
 * have `theirs` publish that same body again right after the first chunk of
 * the next chunked read of the path it landed at, the read-back, so that read
 * meets a session replaced under it.
 */
function raceReadBackOfLandedPublish(ours: SqlSessionStorage, theirs: SqlSessionStorage): { raced: boolean } {
	const readChunks = ours.readChunks.bind(ours);
	const publish = ours.writeTextAtomic.bind(ours);
	const state = { raced: false };
	let landed: { file: string; content: string } | undefined;
	// The session manager hands a full rewrite its lines; the body lands joined, as one whole write.
	spyOn(ours, "writeLinesAtomic").mockImplementationOnce(async (file, lines, options) => {
		const content = Array.from(lines).join("");
		await publish(file, content, options);
		landed = { file, content };
		throw new Error("the store's acknowledgement of the publish was lost");
	});
	spyOn(ours, "readChunks").mockImplementation((file: string, fromByte?: number) =>
		(async function* () {
			for await (const chunk of readChunks(file, fromByte)) {
				yield chunk;
				if (state.raced || landed?.file !== file) continue;
				state.raced = true;
				await theirs.refresh();
				await theirs.writeTextAtomic(landed.file, landed.content, {
					expectedSize: theirs.statSync(landed.file).size,
				});
				await theirs.drain();
			}
		})(),
	);
	return state;
}

/** The ids of the entries `storage` holds for `file`, read by another store. */
async function storedEntryIds(storage: SqlSessionStorage, file: string): Promise<string[]> {
	await storage.refresh();
	const loaded = await loadSessionFile(file, storage);
	return loaded.entries.flatMap(entry => (entry.type === "session" ? [] : [entry.id]));
}

describe("the read-back of a landed publish that another store's rewrite races", () => {
	it("counts a rewrite whose acknowledgement failed as published", async () => {
		// If this regresses, a compaction or rewrite whose body landed reports its lost acknowledgement as a
		// failed write, and the session keeps the size it had before as its durable one.
		await using stores = await openStores();
		const { manager, file } = await seededSession(stores.ours);
		const race = raceReadBackOfLandedPublish(stores.ours, stores.theirs);

		await manager.rewriteEntries();
		manager.appendCustomEntry("after", { n: 1 });
		await manager.flush();

		expect(race.raced).toBe(true);
		expect(await storedEntryIds(stores.theirs, file)).toEqual(manager.getEntries().map(entry => entry.id));
		await manager.close();
	}, 60_000);

	it("does not latch an authoritative repair whose body landed as indeterminate", async () => {
		// If this regresses, the repair fails with SessionPersistenceIndeterminateError and the session stops
		// writing, though the store holds exactly the body the repair published.
		await using stores = await openStores();
		const { manager, file } = await seededSession(stores.ours);
		const race = raceReadBackOfLandedPublish(stores.ours, stores.theirs);

		await manager.recoverPersistenceFromCurrentState();
		manager.appendCustomEntry("after", { n: 1 });
		await manager.flush();

		expect(race.raced).toBe(true);
		expect(await storedEntryIds(stores.theirs, file)).toEqual(manager.getEntries().map(entry => entry.id));
		await manager.close();
	}, 60_000);
});
