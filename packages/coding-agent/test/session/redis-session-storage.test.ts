/**
 * Functional tests for {@link RedisSessionStorage}. Driven by a hand-rolled
 * fake Redis client (`test/helpers/fake-redis.ts`) so the suite runs without a
 * live server. The fake answers each script the storage sends by the marker on
 * its first line (`-- OMP_…`), doing in TypeScript what that script does; the
 * cases of titles, moves, removals and reads from an offset, the titled reads
 * and the raced rewrites also run through the storage's own scripts on a Redis
 * server when `OMP_TEST_REDIS_URL` names one.
 *
 * The harness mirrors only the surface the storage actually uses; it is *not*
 * a general-purpose mock. Each test exercises one contract:
 *
 * - the metadata index keeps `existsSync`/`statSync`/`listFilesSync`
 *   coherent with `writeText`/`writer.append`;
 * - `drain()` waits for fire-and-forget background writes;
 * - `deleteSessionWithArtifacts` removes both the JSONL key and any sidecar
 *   keys under the artifacts prefix;
 * - `refresh()` re-loads the keyspace, so a peer process's writes become
 *   visible after an explicit re-scan;
 * - a full rewrite streams in parts to a staging key of its own and swaps it
 *   in, whether or not the local spool can be used;
 * - no title is stored or read for a session whose body is gone, and a
 *   session an append starts at its path shows none;
 * - a move that fails at its title read changes neither path;
 * - title metadata without a time is none, and an empty title with one a
 *   clear.
 *
 * Each case and hook has a timeout of its own (30 s: a few writes, reads and
 * scripts, on the fake or on a server).
 */

import { RedisClient } from "bun";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import {
	RedisSessionStorage,
	type RedisSessionStorageClient,
} from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { SessionReadConflictError, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createFakeRedis, type FakeRedis, type FakeRedisCall } from "../helpers/fake-redis";

/** A session body as a full rewrite hands it over: a title slot, a header, then `count` entries carrying `text`. */
function rewriteLines(text: string, count = 3): string[] {
	return [
		serializeTitleSlot({ title: `Title ${text}`, source: "user", updatedAt: "2026-11-21T00:00:00.000Z" }),
		`${JSON.stringify({ type: "session", version: 3, id: "redis-rewrite", timestamp: "t0", cwd: "/cwd" })}\n`,
		...Array.from(
			{ length: count },
			(_, n) =>
				`${JSON.stringify({ type: "custom", customType: "n", id: `e${n}`, parentId: null, data: { text } })}\n`,
		),
	];
}

const MiB = 1024 * 1024;

/**
 * A session of about 3.2 MB: a header, then three entries of "a" and `fill`,
 * the last one with `grow` more fills. With a `fill` of three bytes, the
 * windows of a read from its start end inside a character, and two such fills
 * give two bodies of one size.
 */
function paddedBody(fill: string, grow = 0): string {
	const header = `${JSON.stringify({ type: "session", version: 3, id: "redis-chunks", timestamp: "t0", cwd: "/cwd" })}\n`;
	const pads = Array.from(
		{ length: 3 },
		(_, n) =>
			`${JSON.stringify({ type: "custom", customType: "pad", id: `p${n}`, parentId: null, data: `a${fill.repeat(350_000 + (n === 2 ? grow : 0))}` })}\n`,
	);
	return [header, ...pads].join("");
}

/** What another client writes over `paddedBody("€")` in {@link racedRewriteCases}, by the name of the race. */
const RACED_REWRITES = {
	"a rewrite to the same size": () => paddedBody("₤"),
	"a delete and a re-create": () => paddedBody("₤"),
	"a rewrite to fewer bytes": () => paddedBody("é"),
	// Only the last entry grows, so the bytes of every window but the last stay as they were.
	"a rewrite to more bytes that keeps the windows already read": () => paddedBody("€", 10_000),
	"an earlier version's rewrite to more bytes that keeps the windows already read": () => paddedBody("€", 10_000),
};

/**
 * omp's writes from before the generation hash, each in one script that sets
 * the session's bytes and its mtime and nothing else.
 */
interface EarlierVersion {
	write(path: string, body: string, mtimeMs: string): Promise<void>;
	append(path: string, line: string, mtimeMs: string): Promise<void>;
}

/**
 * Each of {@link RACED_REWRITES} landing between two windows of a read, on
 * the Redis that `open` reaches (it opens one more store on it each call),
 * then the races on a session an earlier version wrote last.
 */
function racedRewriteCases(open: () => Promise<{ storage: RedisSessionStorage }>, earlier: EarlierVersion): void {
	// If this regresses, loading, copying or checking a session another process rewrote meanwhile
	// on Redis yields its first windows from the old transcript and the rest from the new one, or
	// the new one cut at the old one's size.
	for (const [race, rewrite] of Object.entries(RACED_REWRITES)) {
		// From the start, and from inside a character with windows left to read.
		for (const fromByte of [0, MiB / 2 + 1]) {
			it(`yields one body's bytes or a read conflict when ${race} lands between two windows of a read from byte ${fromByte}`, async () => {
				const { storage } = await open();
				const other = await open();
				const before = Buffer.from(paddedBody("€"));
				const after = Buffer.from(rewrite());
				await storage.writeText("/s/raced.jsonl", before.toString("utf-8"));
				await other.storage.refresh();

				const outcome = await racedRead(
					storage,
					"/s/raced.jsonl",
					fromByte,
					async () => {
						if (race.startsWith("an earlier version's")) {
							// An earlier version's mtime, never the one this version recorded.
							await earlier.write("/s/raced.jsonl", after.toString("utf-8"), "1");
							return;
						}
						if (race === "a delete and a re-create") await other.storage.unlink("/s/raced.jsonl");
						await other.storage.writeText("/s/raced.jsonl", after.toString("utf-8"));
					},
					{ "old body": before.subarray(fromByte), "new body": after.subarray(fromByte) },
				);

				expect(["old body", "new body", "read conflict"]).toContain(outcome);
			}, 30_000);
		}
	}

	// A session an earlier version wrote last carries no generation a read can use.
	for (const fromByte of [0, MiB / 2 + 1]) {
		// If this regresses, while a fleet runs this version beside an earlier one, a read of a long
		// session that a process of the earlier version keeps appending to fails as raced on every
		// pass, and the resume, copy or gc that made it fails.
		it(`yields the body its first window saw when an earlier version appends between two windows of a read from byte ${fromByte} of a session it wrote last`, async () => {
			const { storage } = await open();
			const before = Buffer.from(paddedBody("€"));
			const line = `${JSON.stringify({ type: "custom", customType: "pad", id: "q", parentId: null, data: "c" })}\n`;
			await storage.writeText("/s/earlier.jsonl", before.toString("utf-8"));
			await earlier.write("/s/earlier.jsonl", before.toString("utf-8"), "1");

			const outcome = await racedRead(
				storage,
				"/s/earlier.jsonl",
				fromByte,
				() => earlier.append("/s/earlier.jsonl", line, "2"),
				{
					"old body": before.subarray(fromByte),
					"old body and the appended line": Buffer.concat([before, Buffer.from(line)]).subarray(fromByte),
				},
			);

			expect(outcome).toBe("old body");
		}, 30_000);

		// If this regresses, a read of a session an earlier version wrote last, which that version
		// rewrites meanwhile, yields its first windows from the old transcript and the rest from the
		// new one.
		it(`yields one body's bytes or a read conflict when an earlier version rewrites a session it wrote last to the same size between two windows of a read from byte ${fromByte}`, async () => {
			const { storage } = await open();
			const before = Buffer.from(paddedBody("€"));
			const after = Buffer.from(paddedBody("₤"));
			await storage.writeText("/s/earlier.jsonl", before.toString("utf-8"));
			await earlier.write("/s/earlier.jsonl", before.toString("utf-8"), "1");

			const outcome = await racedRead(
				storage,
				"/s/earlier.jsonl",
				fromByte,
				() => earlier.write("/s/earlier.jsonl", after.toString("utf-8"), "2"),
				{ "old body": before.subarray(fromByte), "new body": after.subarray(fromByte) },
			);

			expect(["old body", "new body", "read conflict"]).toContain(outcome);
		}, 30_000);
	}
}

/**
 * Read `file` through `reader` from `fromByte`, running `race` once right
 * after the first chunk. What the read gave: the name of the entry of
 * `bodies` its bytes equal, "read conflict", "a short body" (the start of
 * one of `bodies`) or "a mix".
 */
async function racedRead(
	reader: RedisSessionStorage,
	file: string,
	fromByte: number,
	race: () => Promise<void>,
	bodies: Record<string, Buffer>,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	try {
		for await (const chunk of reader.readChunks(file, fromByte)) {
			chunks.push(chunk);
			if (chunks.length === 1) await race();
		}
	} catch (err) {
		if (!(err instanceof SessionReadConflictError)) throw err;
		return "read conflict";
	}
	const read = Buffer.concat(chunks);
	const named = Object.entries(bodies).find(([, body]) => body.equals(read));
	if (named) return named[0];
	return Object.values(bodies).some(body => body.subarray(0, read.length).equals(read)) ? "a short body" : "a mix";
}

/** The head line every reader of `storage` gives `path`: whole, its head slice, its head window and its first chunks. */
async function headsOf(storage: RedisSessionStorage, path: string): Promise<Record<string, string>> {
	const firstLine = (text: string): string => text.slice(0, text.indexOf("\n") + 1);
	const chunks: Uint8Array[] = [];
	for await (const chunk of storage.readChunks(path)) chunks.push(chunk);
	return {
		readText: firstLine(await storage.readText(path)),
		readTextSlices: firstLine((await storage.readTextSlices(path, 4096, 0))[0]),
		readTextFrom: firstLine((await storage.readTextFrom(path, 0, 4096)).text),
		readChunks: firstLine(Buffer.concat(chunks).toString("utf8")),
	};
}

/** `line` as the head of every reader {@link headsOf} asks. */
function everywhere(line: string): Record<string, string> {
	return { readText: line, readTextSlices: line, readTextFrom: line, readChunks: line };
}

/** What each reader of `storage` gives `path` (a path its index lists): what it read, or the code it failed with. */
async function readsOf(storage: RedisSessionStorage, path: string): Promise<Record<string, unknown>> {
	const code = (error: NodeJS.ErrnoException) => error.code;
	return {
		readText: await storage.readText(path).then(text => text, code),
		readTextSlices: await storage.readTextSlices(path, 4096, 0).then(slices => slices, code),
		readTextFrom: await storage.readTextFrom(path, 0, 4096).then(read => read, code),
		readChunks: await Array.fromAsync(storage.readChunks(path)).then(
			chunks => Buffer.concat(chunks).toString("utf8"),
			code,
		),
	};
}

/** What {@link readsOf} gives a path whose body is gone: no bytes and no title. */
const GONE_READS = { readText: "ENOENT", readTextSlices: ["", ""], readTextFrom: "ENOENT", readChunks: "ENOENT" };

/** What `storage` gives of each path: its text (the title laid over its head) and time, or the code its read fails with. */
async function sessionsOf(storage: RedisSessionStorage, paths: string[]): Promise<Record<string, unknown>> {
	const sessions: Record<string, unknown> = {};
	for (const path of paths) {
		sessions[path] = await storage.readText(path).then(
			text => ({ text, mtimeMs: storage.statSync(path).mtimeMs }),
			(error: NodeJS.ErrnoException) => error.code,
		);
	}
	return sessions;
}

/** Two stores over one Redis keyspace, and what a client of an older build does to it directly. */
interface TitledRedis {
	/** Its next title write fails before the server runs it once {@link refuseNextTitleWrite} is called. */
	readonly storage: RedisSessionStorage;
	readonly peer: RedisSessionStorage;
	/** Set `path`'s value and mtime, and no title metadata, as a build before title metadata did. */
	put(path: string, body: string): Promise<void>;
	/** Set `path`'s value in the title hash as it is. */
	putTitle(path: string, raw: string): Promise<void>;
	refuseNextTitleWrite(): void;
}

const SESSION_HEADER = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;

/** A session's header and one entry naming it, so a read shows whose body it got. */
function bodyOf(name: string): string {
	return `${SESSION_HEADER}${JSON.stringify({ type: "custom", customType: "body", data: name })}\n`;
}

/** What the title metadata a Redis store reads with a session's bytes makes its readers give, on the store `open` opens. */
function titleMetadataCases(open: () => Promise<TitledRedis>): void {
	// If this regresses, a store that opened a session before another store renamed or cleared its title shows the
	// old title until it refreshes, a key an older build wrote shows a title it never had, a cleared title shows
	// the one the stored head carries, or a title hash value the decoder refuses is laid over the head anyway.
	it("reads another store's rename and clear without a refresh, a key without title metadata as stored, and malformed metadata as none", async () => {
		const { storage, peer, put, putTitle } = await open();
		const path = "/s/peer.jsonl";
		const old: SessionTitleUpdate = { title: "Old", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(old)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = await headsOf(peer, path);
		const renamed: SessionTitleUpdate = { title: "New", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const afterRename = await headsOf(peer, path);
		const cleared: SessionTitleUpdate = { title: "", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, cleared);
		const afterClear = await headsOf(peer, path);

		const storedSlot = `${serializeTitleSlot({ title: "Stored", source: "auto", updatedAt: "t0" })}${SESSION_HEADER}`;
		await put("/s/stored-slot.jsonl", storedSlot);
		await put("/s/legacy.jsonl", SESSION_HEADER);
		await put("/s/malformed.jsonl", storedSlot);
		await putTitle("/s/malformed.jsonl", '{"title":"Not decoded"');
		await peer.refresh();
		expect({
			before,
			afterRename,
			afterClear,
			storedSlot: await headsOf(peer, "/s/stored-slot.jsonl"),
			legacy: await peer.readText("/s/legacy.jsonl"),
			legacyHeads: await headsOf(peer, "/s/legacy.jsonl"),
			malformed: await headsOf(peer, "/s/malformed.jsonl"),
		}).toEqual({
			before: everywhere(serializeTitleSlot(old)),
			afterRename: everywhere(serializeTitleSlot(renamed)),
			afterClear: everywhere(serializeTitleSlot(cleared)),
			storedSlot: everywhere(storedSlot.slice(0, storedSlot.indexOf("\n") + 1)),
			legacy: SESSION_HEADER,
			legacyHeads: everywhere(SESSION_HEADER),
			malformed: everywhere(storedSlot.slice(0, storedSlot.indexOf("\n") + 1)),
		});
	}, 30_000);

	// If this regresses, the title of what a path held before shows over what it holds next: after a rewrite with
	// no title slot, after its writer empties it, or on the path a session was moved onto.
	it("carries no earlier title over a rewrite without one, a truncation, or a move onto a titled path", async () => {
		const { storage, peer } = await open();
		const titled = `${serializeTitleSlot({ title: "Before", source: "user", updatedAt: "t1" })}${SESSION_HEADER}`;
		for (const path of ["/s/rewritten.jsonl", "/s/truncated.jsonl", "/s/target.jsonl"]) {
			await storage.writeText(path, titled);
			await storage.updateSessionTitle(path, { title: "Renamed before", source: "user", updatedAt: "t2" });
		}
		await storage.writeText("/s/moved.jsonl", SESSION_HEADER);

		await storage.writeText("/s/rewritten.jsonl", SESSION_HEADER);
		await using cleanup = new AsyncDisposableStack();
		const writer = storage.openWriter("/s/truncated.jsonl", { flags: "w" });
		// Closed whatever the append does; a second close does nothing.
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		await storage.rename("/s/moved.jsonl", "/s/target.jsonl");
		await storage.drain();

		await peer.refresh();
		for (const view of [storage, peer]) {
			expect({
				rewritten: await headsOf(view, "/s/rewritten.jsonl"),
				truncated: await headsOf(view, "/s/truncated.jsonl"),
				target: await headsOf(view, "/s/target.jsonl"),
			}).toEqual({
				rewritten: everywhere(SESSION_HEADER),
				truncated: everywhere(SESSION_HEADER),
				target: everywhere(SESSION_HEADER),
			});
		}
	}, 30_000);

	// If this regresses, a move drops the title a session was given after its body was written: another store shows
	// the moved session under the title its body was written with, or the destination's, instead of its current one.
	it("carries the title a session was given after its body onto the titled path it moves over, for another store", async () => {
		const { storage, peer } = await open();
		const src = "/s/retitled.jsonl";
		const dst = "/s/replaced.jsonl";
		const written = serializeTitleSlot({ title: "Written", source: "auto", updatedAt: "t1" });
		await storage.writeText(src, `${written}${bodyOf("source")}`);
		const updated: SessionTitleUpdate = { title: "Updated", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(src, updated);
		const destination = serializeTitleSlot({ title: "Destination", source: "user", updatedAt: "t3" });
		await storage.writeText(dst, `${destination}${bodyOf("destination")}`);
		await peer.refresh();

		await storage.rename(src, dst);
		expect({ text: await peer.readText(dst), heads: await headsOf(peer, dst) }).toEqual({
			text: `${serializeTitleSlot(updated)}${bodyOf("source")}`,
			heads: everywhere(serializeTitleSlot(updated)),
		});
	}, 30_000);

	// If this regresses, a store whose index still lists a session another store deleted stores its title update for
	// the missing body: its head read shows that title for a session `readText` reports missing, and a session an
	// append starts at the path later shows the deleted session's title over its own head.
	it("refuses a title update for a session another store deleted, and reads the path as gone, then as what an append starts there", async () => {
		const { storage, peer } = await open();
		const path = "/s/deleted.jsonl";
		const deleted = serializeTitleSlot({ title: "Deleted", source: "user", updatedAt: "t1" });
		await storage.writeText(path, `${deleted}${SESSION_HEADER}`);
		await peer.refresh();
		await storage.unlink(path);

		const update = await peer.updateSessionTitle(path, { title: "Stale", source: "user", updatedAt: "t2" }).then(
			() => "stored",
			(error: NodeJS.ErrnoException) => error.code,
		);
		const gone = await readsOf(peer, path);
		await using cleanup = new AsyncDisposableStack();
		const writer = storage.openWriter(path);
		// Closed whatever the append does; a second close does nothing.
		cleanup.defer(() => writer.close());
		await writer.append(SESSION_HEADER);
		await writer.close();
		expect({ update, gone, recreated: await headsOf(peer, path) }).toEqual({
			update: "ENOENT",
			gone: GONE_READS,
			recreated: everywhere(SESSION_HEADER),
		});
	}, 30_000);

	// If this regresses, title metadata a path holds for no body (an older build's title update after another store
	// deleted the session there) shows: a head read gives it for the missing session, and a session an append starts
	// at the path shows it over its own head.
	it("shows no title a path holds for a missing body, on the missing session or on one an append starts there", async () => {
		const { storage, peer, putTitle } = await open();
		const path = "/s/orphaned.jsonl";
		await storage.writeText(path, SESSION_HEADER);
		await peer.refresh();
		await storage.unlink(path);
		// What an older build's title update stores for a path whose session is gone.
		await putTitle(path, JSON.stringify({ title: "Orphaned", source: "user", updatedAt: "t2" }));

		const gone = await readsOf(peer, path);
		const writer = storage.openWriter(path);
		await writer.append(SESSION_HEADER);
		await writer.close();
		expect({ gone, recreated: await headsOf(peer, path) }).toEqual({
			gone: GONE_READS,
			recreated: everywhere(SESSION_HEADER),
		});
	}, 30_000);

	// If this regresses, title metadata without a time, which SQL session stores and earlier builds ignore, is laid
	// over the head of a body without a title slot: every reader gives up to its first 256 bytes as a made-up slot.
	it("reads a legacy body as stored under title metadata without a time, and an empty title with a time as a clear", async () => {
		const { peer, put, putTitle } = await open();
		const untimed = "/s/untimed.jsonl";
		const cleared = "/s/cleared.jsonl";
		const clear: SessionTitleUpdate = { title: "", updatedAt: "2026-01-01T00:00:00.000Z" };
		for (const path of [untimed, cleared]) await put(path, bodyOf("legacy"));
		await putTitle(untimed, JSON.stringify({ title: "Ignored", updatedAt: "" }));
		await putTitle(cleared, JSON.stringify(clear));
		await peer.refresh();
		const viewOf = async (path: string) => {
			const lines: string[] = [];
			await peer.scanLines(path, line => {
				lines.push(line);
				return false;
			});
			return { text: await peer.readText(path), heads: await headsOf(peer, path), scanned: lines.join("\n") };
		};

		const slot = serializeTitleSlot(clear);
		expect({ untimed: await viewOf(untimed), cleared: await viewOf(cleared) }).toEqual({
			untimed: { text: bodyOf("legacy"), heads: everywhere(SESSION_HEADER), scanned: bodyOf("legacy") },
			// The body is shorter than the slot, so the clear's slot is the whole text.
			cleared: { text: slot, heads: everywhere(slot), scanned: slot },
		});
	}, 30_000);

	// If this regresses, a title update the server never stored shows on this store (or its time does) until a
	// refresh, or a later update after a failed one is lost on another store.
	it("keeps the durable title and time on this store and another when a title write fails before it runs, and a later one wins", async () => {
		const { storage, peer, refuseNextTitleWrite } = await open();
		const path = "/s/failed-title.jsonl";
		const durable: SessionTitleUpdate = { title: "Durable", source: "auto", updatedAt: "t1" };
		await storage.writeText(path, `${serializeTitleSlot(durable)}${SESSION_HEADER}`);
		await peer.refresh();
		const before = storage.statSync(path).mtimeMs;

		refuseNextTitleWrite();
		await expect(
			storage.updateSessionTitle(path, { title: "Lost", source: "user", updatedAt: "t2" }),
		).rejects.toThrow("title write refused before it ran");
		const afterFailure = {
			local: await headsOf(storage, path),
			peer: await headsOf(peer, path),
			time: storage.statSync(path).mtimeMs,
		};
		const later: SessionTitleUpdate = { title: "Later", source: "user", updatedAt: "t3" };
		await storage.updateSessionTitle(path, later);
		expect({
			afterFailure,
			afterLater: { local: await headsOf(storage, path), peer: await headsOf(peer, path) },
		}).toEqual({
			afterFailure: {
				local: everywhere(serializeTitleSlot(durable)),
				peer: everywhere(serializeTitleSlot(durable)),
				time: before,
			},
			afterLater: { local: everywhere(serializeTitleSlot(later)), peer: everywhere(serializeTitleSlot(later)) },
		});
	}, 30_000);
}

/**
 * The titled-window case on the store `open` opens: windows, slices, chunked reads and line scans of a renamed
 * session, and of a renamed one whose stored body is empty, as readText gives them.
 */
function titledReadCases(open: () => Promise<RedisSessionStorage>): void {
	// If this regresses, a tail, a page, a chunked read or a line scan of a renamed Redis session that starts at,
	// inside or past its title slot shows other bytes or another size than the session's text, or the old title.
	it("reads a renamed session's windows, slices, chunks and lines as readText gives them, from inside the title slot or past it", async () => {
		const storage = await open();
		const path = "/s/titled-windows.jsonl";
		// Past 2 MiB of four-byte characters: windows of 1 MiB end inside one.
		const body = `${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${SESSION_HEADER}${"😀".repeat(600_000)}\ntail\n`;
		await storage.writeText(path, body);
		await storage.updateSessionTitle(path, { title: "New", source: "user", updatedAt: "t2" });
		const whole = Buffer.from(await storage.readText(path));
		const offsets = [
			[0, undefined],
			[0, 0],
			[0, 40],
			[20, 30],
			[100, 0],
			[200, 100],
			[255, 1],
			[256, undefined],
			[256, 0],
			[300, 5],
			[whole.byteLength, 4],
		] as const;
		const windows: unknown[] = [];
		for (const [offset, maxBytes] of offsets) {
			windows.push({ offset, maxBytes, read: await storage.readTextFrom(path, offset, maxBytes) });
		}
		const chunks: Array<{ from: number; equal: boolean }> = [];
		for (const from of [0, 10, 255, 256, 300, MiB + 1]) {
			chunks.push({
				from,
				equal: Buffer.concat(await Array.fromAsync(storage.readChunks(path, from))).equals(whole.subarray(from)),
			});
		}
		const lines: string[] = [];
		await storage.scanLines(path, line => {
			lines.push(line);
			return false;
		});

		await storage.writeText("/s/empty-titled.jsonl", "");
		const emptyTitle = { title: "Titled but empty", source: "user" as const, updatedAt: "t3" };
		await storage.updateSessionTitle("/s/empty-titled.jsonl", emptyTitle);
		const slot = serializeTitleSlot(emptyTitle);
		expect({
			windows,
			headSlice: (await storage.readTextSlices(path, 300, 0))[0],
			suffix: (await storage.readTextSlices(path, 0, 20))[1],
			chunks,
			scanned: lines.join("\n") === whole.toString("utf8"),
			empty: {
				text: await storage.readText("/s/empty-titled.jsonl"),
				head: await storage.readTextFrom("/s/empty-titled.jsonl", 100),
				past: await storage.readTextFrom("/s/empty-titled.jsonl", 256),
				slices: await storage.readTextSlices("/s/empty-titled.jsonl", 300, 10),
				chunks: Buffer.concat(await Array.fromAsync(storage.readChunks("/s/empty-titled.jsonl"))).toString("utf8"),
			},
		}).toEqual({
			windows: offsets.map(([offset, maxBytes]) => ({
				offset,
				maxBytes,
				read: {
					text: whole.subarray(offset, maxBytes === undefined ? undefined : offset + maxBytes).toString("utf8"),
					size: whole.byteLength,
				},
			})),
			headSlice: whole.subarray(0, 300).toString("utf8"),
			suffix: whole.subarray(whole.byteLength - 20).toString("utf8"),
			chunks: chunks.map(({ from }) => ({ from, equal: true })),
			scanned: true,
			empty: {
				text: slot,
				head: { text: slot.slice(100), size: 256 },
				past: { text: "", size: 256 },
				// The suffix is the stored one.
				slices: [slot, ""],
				chunks: slot,
			},
		});
	}, 30_000);
}

/** A client of the Redis a case runs on: what the store uses, and the reads and writes a case makes as another client. */
type CaseClient = RedisSessionStorageClient & Pick<FakeRedis, "exists" | "del" | "hget" | "hset">;

/** The Redis a case runs on: a client of it, a key prefix of the case's own for its stores, and more clients of it. */
interface CaseRedis {
	readonly client: CaseClient;
	readonly prefix: string;
	/** Another client of the same Redis, as another process holds one. */
	connect(): CaseClient;
}

/** Whether the hash `key` holds `field`, read by `client`. */
async function hasField(client: CaseClient, key: string, field: string): Promise<boolean> {
	return (await client.hget(key, field)) !== null;
}

/** `client`, with each call a store makes through it recorded in `calls`, as the fake records the calls it gets. */
function recording(client: RedisSessionStorageClient, calls: FakeRedisCall[]): RedisSessionStorageClient {
	const record = <T>(method: string, args: unknown[], call: () => Promise<T>): Promise<T> => {
		calls.push({ method, args });
		return call();
	};
	return {
		send: (command, args) => record("send", [command, args], () => client.send(command, args)),
		get: key => record("get", [key], () => client.get(key)),
		getrange: (key, start, end) => record("getrange", [key, start, end], () => client.getrange(key, start, end)),
		strlen: key => record("strlen", [key], () => client.strlen(key)),
		set: (key, value) => record("set", [key, value], () => client.set(key, value)),
		append: (key, value) => record("append", [key, value], () => client.append(key, value)),
		scan: (cursor, ...args) => record("scan", [cursor, ...args], () => client.scan(cursor, ...args)),
		hgetall: key => record("hgetall", [key], () => client.hgetall(key)),
	};
}

/**
 * The cases of titles, moves, removals and reads from an offset, on the Redis `open` gives each case. A case writes
 * the keys of another client with the client's own `set`, `hset` and `del`, and reads them with `get`, `exists`,
 * `hget` and `hgetall`.
 */
function scriptCases(open: (cleanup: AsyncDisposableStack) => CaseRedis): void {
	it("persists title updates as indexed fields across storage reloads", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await RedisSessionStorage.create({ client, prefix });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
	}, 30_000);

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);
		expect(await client.exists(`${prefix}file:/sessions/p/s1.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/sessions/p/s1/draft.txt`)).toBe(false);
		expect(await client.exists(`${prefix}file:/sessions/p/other.jsonl`)).toBe(true);
	}, 30_000);

	it("rename moves content and meta atomically inside the index", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);
		expect(await client.get(`${prefix}file:/sessions/p/renamed.jsonl`)).toBe("payload\n");
		expect(await client.exists(`${prefix}file:/sessions/p/orig.jsonl`)).toBe(false);
	}, 30_000);

	it("renameNoReplace refuses a destination key another client set, leaving both keys", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		// Another process sets the destination after this store loaded its index.
		await client.set(`${prefix}file:/sessions/p/b.jsonl`, "theirs\n");

		const error = await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl").then(
			() => undefined,
			(err: unknown) => err,
		);

		expect(error).toMatchObject({ code: "EEXIST", path: "/sessions/p/b.jsonl" });
		expect(await client.get(`${prefix}file:/sessions/p/a.jsonl`)).toBe("ours\n");
		expect(await client.get(`${prefix}file:/sessions/p/b.jsonl`)).toBe("theirs\n");
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("ours\n");
	}, 30_000);

	it("renameNoReplace moves to a free key", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/c.jsonl");

		expect(await client.exists(`${prefix}file:/sessions/p/a.jsonl`)).toBe(false);
		expect(await storage.readText("/sessions/p/c.jsonl")).toBe("ours\n");
	}, 30_000);

	it("moves a key with its mtime and title in one script, dropping a stale title at the destination", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: FakeRedisCall[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		await storage.writeText("/sessions/p/a.jsonl", "ours\n");
		await client.hset(`${prefix}title`, "/sessions/p/a.jsonl", JSON.stringify({ title: "Ours", updatedAt: "t1" }));
		await client.hset(`${prefix}title`, "/sessions/p/b.jsonl", JSON.stringify({ title: "Stale", updatedAt: "t0" }));
		calls.length = 0;

		await storage.renameNoReplace("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");

		// Nothing runs after the script, so no other client's write can land between the parts.
		expect(calls.map(call => call.method)).toEqual(["send"]);
		expect(await client.hget(`${prefix}title`, "/sessions/p/b.jsonl")).toBe(
			JSON.stringify({ title: "Ours", updatedAt: "t1" }),
		);
		expect(await hasField(client, `${prefix}title`, "/sessions/p/a.jsonl")).toBe(false);
		expect(await hasField(client, `${prefix}meta`, "/sessions/p/a.jsonl")).toBe(false);
		expect(await hasField(client, `${prefix}meta`, "/sessions/p/b.jsonl")).toBe(true);
	}, 30_000);

	it("deleteSessionWithArtifacts removes a child key another client set after the refresh", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		const refresh = storage.refresh.bind(storage);
		let injected = false;
		storage.refresh = async () => {
			await refresh();
			// Another process commits a subagent transcript once this view is loaded.
			await client.set(`${prefix}file:/sessions/p/s1/Late.jsonl`, "late\n");
			injected = true;
		};

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(injected).toBe(true);
		expect(await client.exists(`${prefix}file:/sessions/p/s1.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/sessions/p/s1/Late.jsonl`)).toBe(false);
	}, 30_000);

	// If this regresses, a head read of a long Redis session fetches its whole value, or reads its windows without
	// the title metadata the store holds, showing the title its stored head carries. The red control for a title
	// read from another version than the bytes is the gated rewrite case in session-title-same-snapshot.test.ts.
	it("readTextSlices reads both windows and the title metadata in one script, never the whole value", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: FakeRedisCall[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		const path = "/sessions/p/big.jsonl";
		const stored = `${serializeTitleSlot({ title: "Stored title", source: "auto", updatedAt: "t1" })}${bodyOf("big")}`;
		await storage.writeText(path, stored);
		const renamed: SessionTitleUpdate = { title: "Renamed title", source: "user", updatedAt: "t2" };
		await storage.updateSessionTitle(path, renamed);
		const slot = Buffer.from(serializeTitleSlot(renamed), "utf-8");
		const text = Buffer.concat([slot, Buffer.from(stored, "utf-8").subarray(slot.length)]);

		calls.length = 0;
		expect({
			slices: await storage.readTextSlices(path, 300, 20),
			commands: calls.map(call => (call.method === "send" ? call.args[0] : call.method)),
		}).toEqual({
			slices: [
				text.subarray(0, 300).toString("utf-8"),
				Buffer.from(stored, "utf-8").subarray(-20).toString("utf-8"),
			],
			commands: ["EVAL"],
		});
	}, 30_000);

	it("readTextFrom reads a byte window and the size in one script, never the whole value", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: FakeRedisCall[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		const path = "/sessions/p/window.jsonl";
		const body = "line one\nline two €\nline three\n";
		const bytes = Buffer.from(body);
		await storage.writeText(path, body);

		calls.length = 0;
		expect(await storage.readTextFrom(path, 9, 13)).toEqual({ text: "line two €\n", size: bytes.length });
		expect(await storage.readTextFrom(path, 9)).toEqual({ text: bytes.subarray(9).toString(), size: bytes.length });
		expect(await storage.readTextFrom(path, 9, 0)).toEqual({ text: "", size: bytes.length });
		expect(await storage.readTextFrom(path, bytes.length + 4, 8)).toEqual({ text: "", size: bytes.length });
		expect(calls.map(call => [call.method, String((call.args[1] as string[])[0]).split("\n")[0]])).toEqual(
			Array.from({ length: 4 }, () => ["send", "-- OMP_READ_FROM"]),
		);
	}, 30_000);

	it("readTextFrom rejects with ENOENT for a key another client deleted", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/sessions/p/gone.jsonl", "gone\n");
		await client.del(`${prefix}file:/sessions/p/gone.jsonl`);

		await expect(storage.readTextFrom("/sessions/p/gone.jsonl", 0, 4)).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	// If this regresses, resuming, scanning or checking a long session on Redis storage reads its
	// whole transcript as one value, or splits a character between two chunks and corrupts it.
	it("reads in windows of at most 1 MiB by script, each between characters, never GETting the whole value", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const calls: FakeRedisCall[] = [];
		const storage = await RedisSessionStorage.create({ client: recording(client, calls), prefix });
		const path = "/sessions/p/chunked.jsonl";
		// One byte, then 2.4 MB of four-byte characters: a window of 1 MiB from the start ends inside one.
		const body = `a${"😀".repeat(600_000)}\n`;
		const bytes = Buffer.from(body);
		await storage.writeText(path, body);
		calls.length = 0;

		const chunks = await Array.fromAsync(storage.readChunks(path));
		// From inside the first character: its last three bytes, then the rest.
		const fromInside = Buffer.concat(await Array.fromAsync(storage.readChunks(path, 2)));

		expect({
			equal: Buffer.concat(chunks).equals(bytes),
			sizes: chunks.map(chunk => chunk.byteLength),
			decodeWhole: chunks.map(chunk => Buffer.from(new TextDecoder().decode(chunk)).equals(chunk)),
			fromInside: fromInside.equals(bytes.subarray(2)),
		}).toEqual({
			equal: true,
			sizes: [MiB - 3, MiB, bytes.length - 2 * MiB + 3],
			decodeWhole: [true, true, true],
			fromInside: true,
		});
		expect(calls.map(call => [call.method, String((call.args[1] as string[])[0]).split("\n")[0]])).toEqual(
			Array.from({ length: 6 }, () => ["send", "-- OMP_READ_WINDOW"]),
		);
	}, 30_000);

	it("unlink on a missing key throws ENOENT", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	it("a refused move leaves both keys and both hashes as they were", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix, connect } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const other = await RedisSessionStorage.create({ client: connect(), prefix });
		await storage.writeText("/s/a.jsonl", "ours\n");
		await other.writeText("/s/b.jsonl", "theirs\n");
		const before = [await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)];

		await expect(storage.renameNoReplace("/s/a.jsonl", "/s/b.jsonl")).rejects.toMatchObject({
			code: "EEXIST",
			path: "/s/b.jsonl",
		});

		expect(await client.get(`${prefix}file:/s/a.jsonl`)).toBe("ours\n");
		expect(await client.get(`${prefix}file:/s/b.jsonl`)).toBe("theirs\n");
		expect([await client.hgetall(`${prefix}meta`), await client.hgetall(`${prefix}title`)]).toEqual(before);
	}, 30_000);

	it("a move carries the title metadata and drops a stale title at the destination", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/s/a.jsonl", "ours\n");
		await client.hset(`${prefix}title`, "/s/a.jsonl", '{"title":"Ours","updatedAt":"t1"}');
		await client.hset(`${prefix}title`, "/s/c.jsonl", '{"title":"Stale","updatedAt":"t0"}');

		await storage.renameNoReplace("/s/a.jsonl", "/s/c.jsonl");

		expect(await client.get(`${prefix}file:/s/c.jsonl`)).toBe("ours\n");
		expect(await client.hget(`${prefix}title`, "/s/c.jsonl")).toBe('{"title":"Ours","updatedAt":"t1"}');
		expect(await client.hget(`${prefix}title`, "/s/a.jsonl")).toBeNull();
		expect(await client.hget(`${prefix}meta`, "/s/a.jsonl")).toBeNull();
		expect(await client.hget(`${prefix}meta`, "/s/c.jsonl")).not.toBeNull();
	}, 30_000);

	it("deleting a session removes, in one command, every key and its metadata under the directory", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix, connect } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const other = await RedisSessionStorage.create({ client: connect(), prefix });
		await storage.writeText("/s/p.jsonl", "parent\n");
		// Set by another client after this store loaded its view, and never refreshed into it.
		await other.writeText("/s/p/Late*[x].jsonl", "late\n");
		await other.writeText("/s/p-sibling.jsonl", "sibling\n");
		const send = client.send.bind(client);
		const commands: string[] = [];
		client.send = (command: string, args: string[]) => {
			commands.push(command);
			return send(command, args);
		};
		storage.refresh = async () => {};

		await storage.deleteSessionWithArtifacts("/s/p.jsonl");

		expect(commands).toEqual(["EVAL"]);
		expect(await client.exists(`${prefix}file:/s/p.jsonl`)).toBe(false);
		expect(await client.exists(`${prefix}file:/s/p/Late*[x].jsonl`)).toBe(false);
		expect(await client.hget(`${prefix}meta`, "/s/p/Late*[x].jsonl")).toBeNull();
		expect(await client.get(`${prefix}file:/s/p-sibling.jsonl`)).toBe("sibling\n");
	}, 30_000);

	it("reads a byte window and the size in one script, and nothing of a deleted key", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const body = "line one\nline two €\nline three\n";
		const bytes = Buffer.from(body);
		await storage.writeText("/s/w.jsonl", body);

		expect(await storage.readTextFrom("/s/w.jsonl", 9, 13)).toEqual({ text: "line two €\n", size: bytes.length });
		expect(await storage.readTextFrom("/s/w.jsonl", 9)).toEqual({
			text: bytes.subarray(9).toString(),
			size: bytes.length,
		});
		expect(await storage.readTextFrom("/s/w.jsonl", 9, 0)).toEqual({ text: "", size: bytes.length });
		await client.del(`${prefix}file:/s/w.jsonl`);
		await expect(storage.readTextFrom("/s/w.jsonl", 0, 4)).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);

	// If this regresses, a long session's bytes on Redis come back with a character split between two
	// chunks (the loaders then decode it wrong), or from the wrong offset.
	it("reads the stored bytes in windows of at most 1 MiB that start and end between characters, from any byte", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		const results: unknown[] = [];
		const expected: unknown[] = [];
		for (const lead of [0, 1, 2, 3]) {
			// Four-byte characters after `lead` bytes: a window of 1 MiB ends inside one at each of its bytes.
			const body = `${"a".repeat(lead)}${"😀".repeat(600_000)}\n`;
			const bytes = Buffer.from(body);
			const file = `/s/chars-${lead}.jsonl`;
			await storage.writeText(file, body);
			for (const fromByte of [
				0,
				1,
				2,
				3,
				4,
				5,
				MiB + 1,
				MiB + 2,
				bytes.length - 2,
				bytes.length,
				bytes.length + 5,
			]) {
				const chunks = await Array.fromAsync(storage.readChunks(file, fromByte));
				results.push({
					lead,
					fromByte,
					equal: Buffer.concat(chunks).equals(bytes.subarray(fromByte)),
					bounded: chunks.every(chunk => chunk.byteLength <= MiB),
					// Every chunk after the first starts between characters, as every chunk ends.
					decodeWhole: chunks.slice(1).every(chunk => Buffer.from(new TextDecoder().decode(chunk)).equals(chunk)),
				});
				expected.push({ lead, fromByte, equal: true, bounded: true, decodeWhole: true });
			}
		}
		expect(results).toEqual(expected);
	}, 30_000);

	it("rejects a chunked read with ENOENT for a key another client deleted", async () => {
		await using cleanup = new AsyncDisposableStack();
		const { client, prefix } = open(cleanup);
		const storage = await RedisSessionStorage.create({ client, prefix });
		await storage.writeText("/s/gone.jsonl", paddedBody("€"));
		await client.del(`${prefix}file:/s/gone.jsonl`);

		await expect(Array.fromAsync(storage.readChunks("/s/gone.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
	}, 30_000);
}

/**
 * A key prefix of the case's own on `url`'s server, and clients of it. `cleanup` closes each client as it is made,
 * then deletes the prefix's keys on a client of its own.
 */
function serverRedis(url: string, cleanup: AsyncDisposableStack): CaseRedis {
	const prefix = `omp-test:redis-session:${crypto.randomUUID()}:`;
	// Registered before any client, so it runs after they close.
	cleanup.defer(async () => {
		const cleaner = new RedisClient(url);
		try {
			const keys = (await cleaner.send("KEYS", [`${prefix}*`])) as string[];
			if (keys.length > 0) await cleaner.send("DEL", keys);
		} finally {
			cleaner.close();
		}
	});
	const connect = (): CaseClient => {
		const client = new RedisClient(url);
		cleanup.defer(() => client.close());
		return client;
	};
	return { client: connect(), prefix, connect };
}

describe("RedisSessionStorage", () => {
	let redis: FakeRedis;

	beforeEach(() => {
		redis = createFakeRedis();
	}, 30_000);

	it("indexes writeText metadata and reads content asynchronously", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
	}, 30_000);

	it("commits file content and metadata through one atomic Redis script", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/atomic.jsonl";
		await storage.writeText(sessionPath, "old\n");
		const oldMtime = redis.hashes.get("omp:sessions:meta")?.get(sessionPath);
		redis.failNext("send", new Error("EVAL transport failed"));

		await expect(storage.writeTextAtomic(sessionPath, "new\n")).rejects.toThrow("EVAL transport failed");

		expect(redis.strings.get(`omp:sessions:file:${sessionPath}`)).toBe("old\n");
		expect(redis.hashes.get("omp:sessions:meta")?.get(sessionPath)).toBe(oldMtime);
		expect(storage.statSync(sessionPath).size).toBe(4);
		expect(redis.calls.some(call => call.method === "send" && call.args[0] === "EVAL")).toBe(true);
	}, 30_000);

	it("create() warms the metadata index with STRLEN and never GETs full content", async () => {
		redis.strings.set("omp:sessions:file:/sessions/p/huge.jsonl", "0123456789");
		redis.hashes.set("omp:sessions:meta", new Map([["/sessions/p/huge.jsonl", String(Date.now())]]));

		const storage = await RedisSessionStorage.create({ client: redis });
		expect(storage.statSync("/sessions/p/huge.jsonl").size).toBe(10);
		expect(redis.calls.some(call => call.method === "get")).toBe(false);
		expect(redis.calls.some(call => call.method === "strlen")).toBe(true);
	}, 30_000);

	it("listFilesSync returns only direct children matching the glob", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		const jsonl = storage.listFilesSync("/dir", "*.jsonl").sort();
		expect(jsonl).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);

		const bak = storage.listFilesSync("/dir", "*.bak");
		expect(bak).toEqual(["/dir/note.bak"]);
	}, 30_000);

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");

		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	}, 30_000);

	it("writer.append appends to Redis after drain", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from Redis.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		// Redis has not necessarily caught up yet — drain to force.
		await storage.drain();
		expect(redis.strings.get("omp:sessions:file:/sessions/p/session.jsonl")).toBe(
			'{"type":"session"}\n{"type":"message"}\n',
		);

		await writer.close();
	}, 30_000);

	it("flags='w' truncates both index metadata and Redis", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		expect(redis.strings.get("omp:sessions:file:/sessions/p/keep.jsonl")).toBe("fresh\n");
	}, 30_000);

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");
		redis.failNext("append", new Error("redis exploded"));
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow("redis exploded");
		expect(writer.getError()?.message).toBe("redis exploded");
	}, 30_000);

	it("rename rolls back the index when Redis RENAME fails", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/a.jsonl", "keep\n");
		redis.failNext("rename", new Error("ERR redis rejected rename"));

		await expect(storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl")).rejects.toThrow(
			"ERR redis rejected rename",
		);

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(storage.existsSync("/sessions/p/b.jsonl")).toBe(false);
	}, 30_000);

	// If this regresses, a move whose title read Redis refuses (an account without HGET) has moved the body before the
	// script fails: `rename()` rejects, yet the destination session is lost under the source's body and the source is
	// gone, on this store and on any other.
	it("leaves both sessions, their times and titles as they were when Redis refuses a move's title read", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const src = "/s/moving.jsonl";
		const dst = "/s/staying.jsonl";
		for (const [path, name] of [
			[src, "Source"],
			[dst, "Destination"],
		]) {
			const written = serializeTitleSlot({ title: `${name} as written`, source: "auto", updatedAt: "t1" });
			await storage.writeText(path, `${written}${bodyOf(name)}`);
			await storage.updateSessionTitle(path, { title: `${name} renamed`, source: "user", updatedAt: "t2" });
		}
		const before = await sessionsOf(await RedisSessionStorage.create({ client: redis }), [src, dst]);

		redis.failNext("hget", new Error("NOPERM this user has no permissions to run the 'hget' command"));
		await expect(storage.rename(src, dst)).rejects.toThrow("NOPERM");
		expect({
			stored: await sessionsOf(await RedisSessionStorage.create({ client: redis }), [src, dst]),
			local: await sessionsOf(storage, [src, dst]),
		}).toEqual({ stored: before, local: before });
	}, 30_000);

	it("refresh() reloads the metadata index from Redis after out-of-band writes", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		// Simulate a peer process writing directly to Redis.
		redis.strings.set("omp:sessions:file:/peer/x.jsonl", "from peer\n");
		const peerHash = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
		peerHash.set("/peer/x.jsonl", String(Date.now() + 5_000));
		redis.hashes.set("omp:sessions:meta", peerHash);

		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);
		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
	}, 30_000);

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
	}, 30_000);

	it("custom prefix isolates keyspaces", async () => {
		const storage = await RedisSessionStorage.create({ client: redis, prefix: "proj-a:" });
		await storage.writeText("/sessions/x.jsonl", "hello\n");
		expect(redis.strings.has("proj-a:file:/sessions/x.jsonl")).toBe(true);
		expect(redis.strings.has("omp:sessions:file:/sessions/x.jsonl")).toBe(false);
	}, 30_000);

	// If this regresses, a full rewrite on Redis storage holds the whole transcript as one string
	// (read back from the spool, or joined when the spool cannot be used), or leaves staging keys
	// behind, and a long session's memory grows with its age.
	it("streams a full rewrite to a staging key of its own and swaps it in, with the spool and without it", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/rewrite.jsonl";
		await storage.writeText(sessionPath, "old\n");
		const scripts = (): string[] =>
			redis.calls
				.filter(call => call.method === "send")
				.map(call => String((call.args[1] as string[])[0]).split("\n")[0] ?? "");
		const stagingKeys = (): string[] =>
			redis.calls
				.filter(call => call.method === "send" && String((call.args[1] as string[])[0]).includes("OMP_STAGE_PART"))
				.map(call => String((call.args[1] as string[])[2]));
		const withSpool = rewriteLines("with the spool");
		const withoutSpool = rewriteLines("without the spool");
		redis.calls.length = 0;

		await storage.writeLinesAtomic(sessionPath, withSpool, { expectedSize: 4 });
		const spooled = { scripts: scripts(), stored: redis.strings.get(`omp:sessions:file:${sessionPath}`) };
		const firstStaging = stagingKeys();
		redis.calls.length = 0;
		using tmp = TempDir.createSync("@omp-redis-rewrite-tmp-");
		fs.writeFileSync(tmp.join("not-a-directory"), "a regular file\n");
		const originalTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = tmp.join("not-a-directory", "tmp");
		try {
			storage.writeLinesSync(sessionPath, withoutSpool, { expectedSize: Buffer.byteLength(withSpool.join("")) });
			await storage.drain();
		} finally {
			if (originalTmpdir === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = originalTmpdir;
		}
		const streamed = { scripts: scripts(), stored: redis.strings.get(`omp:sessions:file:${sessionPath}`) };

		expect({ spooled, streamed }).toEqual({
			spooled: { scripts: ["-- OMP_STAGE_PART", "-- OMP_WRITE_STAGED"], stored: withSpool.join("") },
			streamed: { scripts: ["-- OMP_STAGE_PART", "-- OMP_WRITE_STAGED"], stored: withoutSpool.join("") },
		});
		expect(JSON.parse(redis.hashes.get("omp:sessions:title")?.get(sessionPath) ?? "{}")).toMatchObject({
			title: "Title without the spool",
		});
		// Each write staged under a key of its own, and none is left.
		expect(new Set([...firstStaging, ...stagingKeys()]).size).toBe(2);
		expect([...redis.strings.keys()].filter(key => key.includes(":staging:"))).toEqual([]);
	}, 30_000);

	// If this regresses, a full rewrite on Redis storage that another client's write made stale
	// replaces that client's session anyway, or leaves its staging key behind.
	it("refuses a staged rewrite whose size check fails, deleting its staging key and leaving the session", async () => {
		const storage = await RedisSessionStorage.create({ client: redis });
		const peer = await RedisSessionStorage.create({ client: redis });
		const sessionPath = "/sessions/p/stale.jsonl";
		await storage.writeText(sessionPath, "ours\n");
		await peer.refresh();
		await peer.writeText(sessionPath, "theirs, longer\n");

		await expect(
			storage.writeLinesAtomic(sessionPath, rewriteLines("stale"), { expectedSize: Buffer.byteLength("ours\n") }),
		).rejects.toBeInstanceOf(SessionWriteConflictError);

		expect(redis.strings.get(`omp:sessions:file:${sessionPath}`)).toBe("theirs, longer\n");
		expect([...redis.strings.keys()].filter(key => key.includes(":staging:"))).toEqual([]);
	}, 30_000);

	racedRewriteCases(async () => ({ storage: await RedisSessionStorage.create({ client: redis }) }), {
		async write(path, body, mtimeMs) {
			redis.strings.set(`omp:sessions:file:${path}`, body);
			redis.hashes.get("omp:sessions:meta")?.set(path, mtimeMs);
		},
		async append(path, line, mtimeMs) {
			redis.strings.set(`omp:sessions:file:${path}`, (redis.strings.get(`omp:sessions:file:${path}`) ?? "") + line);
			redis.hashes.get("omp:sessions:meta")?.set(path, mtimeMs);
		},
	});

	titleMetadataCases(async () => ({
		storage: await RedisSessionStorage.create({ client: redis }),
		peer: await RedisSessionStorage.create({ client: redis }),
		async put(path, body) {
			redis.strings.set(`omp:sessions:file:${path}`, body);
			const meta = redis.hashes.get("omp:sessions:meta") ?? new Map<string, string>();
			meta.set(path, "1");
			redis.hashes.set("omp:sessions:meta", meta);
		},
		async putTitle(path, raw) {
			const titles = redis.hashes.get("omp:sessions:title") ?? new Map<string, string>();
			titles.set(path, raw);
			redis.hashes.set("omp:sessions:title", titles);
		},
		refuseNextTitleWrite() {
			// The title script's first write: the script fails there, before it changes anything.
			redis.failNext("hset", new Error("title write refused before it ran"));
		},
	}));

	titledReadCases(() => RedisSessionStorage.create({ client: redis }));
});

// The fake above answers each script in TypeScript; these run the storage's
// own scripts on a real server when `OMP_TEST_REDIS_URL` names a throwaway
// one.
describe.skipIf(!process.env.OMP_TEST_REDIS_URL)("RedisSessionStorage on a Redis server", () => {
	const url = process.env.OMP_TEST_REDIS_URL ?? "";
	// Each case's clients and keys, released after it, each release tried whatever the others did.
	let cleanup = new AsyncDisposableStack();
	let prefix = "";
	const open = async (): Promise<{ client: RedisClient; storage: RedisSessionStorage }> => {
		const client = new RedisClient(url);
		cleanup.defer(() => client.close());
		return { client, storage: await RedisSessionStorage.create({ client, prefix }) };
	};
	const hget = async (client: RedisClient, hash: string, field: string) =>
		client.send("HGET", [`${prefix}${hash}`, field]);

	beforeEach(() => {
		const keys = `omp-test:${process.pid}:${Date.now().toString(36)}:`;
		prefix = keys;
		cleanup = new AsyncDisposableStack();
		// Registered first, so it runs after the case's clients close, on a client of its own.
		cleanup.defer(async () => {
			const cleaner = new RedisClient(url);
			try {
				const found = (await cleaner.send("KEYS", [`${keys}*`])) as string[];
				if (found.length > 0) await cleaner.send("DEL", found);
			} finally {
				cleaner.close();
			}
		});
	}, 30_000);
	afterEach(() => cleanup.disposeAsync(), 30_000);

	titledReadCases(async () => (await open()).storage);

	titleMetadataCases(async () => {
		const { client, storage: peer } = await open();
		const refuse = { next: false };
		const storageClient = new RedisClient(url);
		cleanup.defer(() => storageClient.close());
		const send = storageClient.send.bind(storageClient);
		storageClient.send = (command: string, args: string[]) => {
			if (refuse.next && command === "EVAL" && String(args[0]).startsWith("-- OMP_UPDATE_TITLE")) {
				refuse.next = false;
				return Promise.reject(new Error("title write refused before it ran"));
			}
			return send(command, args);
		};
		return {
			storage: await RedisSessionStorage.create({ client: storageClient, prefix }),
			peer,
			async put(path, body) {
				await client.send("SET", [`${prefix}file:${path}`, body]);
				await client.send("HSET", [`${prefix}meta`, path, "1"]);
			},
			async putTitle(path, raw) {
				await client.send("HSET", [`${prefix}title`, path, raw]);
			},
			refuseNextTitleWrite() {
				refuse.next = true;
			},
		};
	});

	// If this regresses, a full rewrite on a Redis server leaves its session expiring with the
	// staging key's time to live, splits a character between parts, leaves staging keys behind, or
	// replaces a session another client changed meanwhile.
	it("swaps a streamed rewrite in from its staging key, and a refused one deletes the key and leaves the session", async () => {
		const { client, storage } = await open();
		const other = await open();
		// About 2.7 MB of three-byte characters: several parts, cut between characters.
		const lines = rewriteLines("€".repeat(300_000), 3);
		const body = lines.join("");
		await storage.writeText("/s/r.jsonl", "old\n");

		await storage.writeLinesAtomic("/s/r.jsonl", lines, { expectedSize: 4 });

		expect({
			stored: await client.get(`${prefix}file:/s/r.jsonl`),
			ttl: await client.send("PTTL", [`${prefix}file:/s/r.jsonl`]),
			title: JSON.parse(String(await hget(client, "title", "/s/r.jsonl"))).title,
			staging: await client.send("KEYS", [`${prefix}staging:*`]),
		}).toEqual({ stored: body, ttl: -1, title: JSON.parse(lines[0] ?? "{}").title, staging: [] });

		await other.storage.refresh();
		await other.storage.writeText("/s/r.jsonl", "theirs\n");
		await expect(
			storage.writeLinesAtomic("/s/r.jsonl", rewriteLines("stale"), { expectedSize: Buffer.byteLength(body) }),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect({
			stored: await client.get(`${prefix}file:/s/r.jsonl`),
			staging: await client.send("KEYS", [`${prefix}staging:*`]),
		}).toEqual({ stored: "theirs\n", staging: [] });
	}, 30_000);

	// If this regresses, a resume of a session another process keeps appending to fails as raced,
	// or ends inside a line the read never finished.
	it("yields exactly the body its first window saw when another client appends between two windows", async () => {
		const { storage } = await open();
		const other = await open();
		const before = paddedBody("€");
		await storage.writeText("/s/grow.jsonl", before);
		await other.storage.refresh();
		const later = `${JSON.stringify({ type: "custom", customType: "pad", id: "q", parentId: null, data: "c".repeat(MiB) })}\n`;

		const outcome = await racedRead(
			storage,
			"/s/grow.jsonl",
			0,
			async () => {
				const writer = other.storage.openWriter("/s/grow.jsonl", { flags: "a" });
				await writer.append(later);
				await writer.close();
				await other.storage.drain();
			},
			{ "old body": Buffer.from(before), "old body and the appended line": Buffer.from(before + later) },
		);

		expect(outcome).toBe("old body");
	}, 30_000);

	// The scripts of omp's writes before the generation hash.
	const earlierScript = async (script: string, path: string, value: string, mtimeMs: string): Promise<void> => {
		const { client } = await open();
		await client.send("EVAL", [script, "2", `${prefix}file:${path}`, `${prefix}meta`, value, path, mtimeMs]);
	};
	racedRewriteCases(open, {
		write: (path, body, mtimeMs) =>
			earlierScript(
				'redis.call("SET", KEYS[1], ARGV[1]) redis.call("HSET", KEYS[2], ARGV[2], ARGV[3]) return 1',
				path,
				body,
				mtimeMs,
			),
		append: (path, line, mtimeMs) =>
			earlierScript(
				'local size = redis.call("APPEND", KEYS[1], ARGV[1]) redis.call("HSET", KEYS[2], ARGV[2], ARGV[3]) return size',
				path,
				line,
				mtimeMs,
			),
	});

	// If this regresses, a reader that stops early (a header probe, the Agent Hub roster) keeps
	// the head of one body and the next window of another without a word.
	it("fails a read meant to stop after two windows at the second, before yielding it, when a rewrite lands between them", async () => {
		const { storage } = await open();
		const other = await open();
		await storage.writeText("/s/stopped.jsonl", paddedBody("€"));
		await other.storage.refresh();

		const chunks: Uint8Array[] = [];
		const error = await (async () => {
			for await (const chunk of storage.readChunks("/s/stopped.jsonl")) {
				chunks.push(chunk);
				if (chunks.length === 1) await other.storage.writeText("/s/stopped.jsonl", paddedBody("₤"));
				if (chunks.length === 2) break;
			}
		})().then(
			() => undefined,
			(err: unknown) => err,
		);

		expect({ chunks: chunks.length, error }).toEqual({ chunks: 1, error: expect.any(SessionReadConflictError) });
	}, 30_000);
});

const REDIS_URL = process.env.OMP_TEST_REDIS_URL;

describe("RedisSessionStorage titles, moves, removals and reads from an offset (fake)", () => {
	scriptCases(() => {
		const fake = createFakeRedis();
		return { client: fake, prefix: "omp:sessions:", connect: () => fake };
	});
});

describe.skipIf(!REDIS_URL)(
	"RedisSessionStorage titles, moves, removals and reads from an offset (Redis server)",
	() => {
		scriptCases(cleanup => serverRedis(REDIS_URL ?? "", cleanup));
	},
);
