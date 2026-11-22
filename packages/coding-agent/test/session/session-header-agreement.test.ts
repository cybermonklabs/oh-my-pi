/**
 * The session listing, the loader and a delete's check read a session file's header through one function
 * (`leadingSessionHeader`), so they name the same session: a delete accepts every session the picker lists, and the
 * loader opens a session only when that function finds its header whole (and then names the same id). A header that
 * is listed but not opened (cut short, after a `title` record that is not the written slot, or after a second byte
 * order mark) is still deleted as listed.
 *
 * Every store returns a session file's text as stored, a leading byte order mark included, and the reader drops
 * one mark at the file's start and one at the start of the line after the written title slot (the session's first
 * line): a second mark there, or one at the start of a later line, leaves that line unreadable, and a mark inside a
 * line stays. Each shape runs through the listing and both delete readers on the file store and the
 * in-memory store (which returns text as stored, as SQL and Redis do), and through the loader on the file store's
 * text path (below 8 MiB), its byte stream path (from 8 MiB) and the in-memory store: the three load alike, with the
 * file's stored size.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	leadingSessionHeader,
	loadEntriesFromFileStream,
	loadSessionFile,
	readSessionHeaderId,
	type SessionLoadResult,
	sessionHeaderIdOfHead,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

const ID = "0199c0de-0000-7000-8000-000000000001";
const MARK = "\uFEFF";
const header = (fields: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-11-21T00:00:00.000Z", cwd: "/w", ...fields });
const message = (id: string, text: string) =>
	`${JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-11-21T00:00:01.000Z", message: { role: "user", content: text, timestamp: 1 } })}\n`;
const turn = message("m1", "hi");
/** A `title` record that is not the fixed-width slot omp writes (no `v`, `updatedAt` or `pad`). */
const slot = JSON.stringify({ type: "title", title: "named" });
/** The fixed-width title slot line omp writes, newline included. */
const writtenSlot = serializeTitleSlot({ title: "named", source: "user", updatedAt: "2026-11-21T00:00:00.000Z" });

interface Shape {
	readonly content: string;
	/** The id the listing and both delete readers name; `undefined` when none does. */
	readonly id: string | undefined;
	/** Whether the loader opens it: its header parses whole as the first record after the written slot. */
	readonly opens: boolean;
	/** Whether the header reader returns the header as a whole record (default: `opens`). */
	readonly whole?: boolean;
	/** Entries the loader opens (default 2: the header and one turn). */
	readonly entries?: number;
	/** The title slot's title the loader applies. */
	readonly title?: string;
	/** Whether a byte order mark is left inside the opened entries. */
	readonly markKept?: boolean;
}

const SHAPES: Record<string, Shape> = {
	"a whole header": { content: `${header()}\n${turn}`, id: ID, opens: true },
	"the written title slot, then a whole header": {
		content: `${writtenSlot}${header()}\n${turn}`,
		id: ID,
		opens: true,
		title: "named",
	},
	"a title record that is not the written slot, then a whole header": {
		content: `${slot}\n${header()}\n${turn}`,
		id: ID,
		opens: false,
		whole: true,
	},
	"blank lines, then a whole header": { content: `\n\n${header()}\n${turn}`, id: ID, opens: true },
	"a byte order mark, then a whole header": { content: `${MARK}${header()}\n${turn}`, id: ID, opens: true },
	"a byte order mark, the written title slot, then a whole header": {
		content: `${MARK}${writtenSlot}${header()}\n${turn}`,
		id: ID,
		opens: true,
		title: "named",
	},
	"a byte order mark, then a header cut short": { content: `${MARK}${header().slice(0, -12)}`, id: ID, opens: false },
	// Exactly one leading mark is dropped: the second leaves the header line unreadable, so the header is named by
	// its line (listed, deleted as listed) and not opened.
	"two byte order marks, then a whole header": { content: `${MARK}${MARK}${header()}\n${turn}`, id: ID, opens: false },
	// The second mark leaves the slot line unreadable: skipped, as any malformed line before the header.
	"two byte order marks, the written title slot, then a whole header": {
		content: `${MARK}${MARK}${writtenSlot}${header()}\n${turn}`,
		id: ID,
		opens: true,
	},
	// The line after the written title slot is the session's first line: one mark at its start is dropped too, as on
	// the file store's stream path at bbdb6d5f; a second one there leaves the header unreadable.
	"a byte order mark after the written title slot, before the header": {
		content: `${writtenSlot}${MARK}${header()}\n${turn}`,
		id: ID,
		opens: true,
		title: "named",
	},
	"a byte order mark, the written title slot, another mark, then a whole header": {
		content: `${MARK}${writtenSlot}${MARK}${header()}\n${turn}`,
		id: ID,
		opens: true,
		title: "named",
	},
	"the written title slot, two byte order marks, then a whole header": {
		content: `${writtenSlot}${MARK}${MARK}${header()}\n${turn}`,
		id: ID,
		opens: false,
	},
	// Only the start of the file and of the session's first line drop a mark: one at the start of a later line leaves
	// that line unreadable.
	"a later line that starts with a byte order mark": {
		content: `${header()}\n${turn}${MARK}${message("m2", "later")}`,
		id: ID,
		opens: true,
	},
	"a byte order mark inside a message's text": {
		content: `${header()}\n${message("m1", `a${MARK}b`)}`,
		id: ID,
		opens: true,
		markKept: true,
	},
	"a pretty-printed header": {
		content: `${JSON.stringify(JSON.parse(header()), null, 2)}\n${turn}`,
		id: ID,
		opens: true,
	},
	"a torn title slot line, then a whole header": {
		content: `{"type":"title","title":"torn\n${header()}\n${turn}`,
		id: ID,
		opens: true,
	},
	"a line of garbage, then a whole header": { content: `not json\n${header()}\n${turn}`, id: ID, opens: true },
	"a header longer than the first read (16 KiB)": {
		content: `${header({ note: "x".repeat(20_000) })}\n${turn}`,
		id: ID,
		opens: true,
	},
	"a header cut short": { content: header().slice(0, -12), id: ID, opens: false },
	"the written title slot, then a header cut short": {
		content: `${writtenSlot}${header().slice(0, -12)}`,
		id: ID,
		opens: false,
	},
	"a title record that is not the written slot, then a header cut short": {
		content: `${slot}\n${header().slice(0, -12)}`,
		id: ID,
		opens: false,
	},
	"a header with no id": {
		content: `${JSON.stringify({ type: "session", version: 3 })}\n${turn}`,
		id: undefined,
		opens: false,
	},
	"a message first": { content: turn, id: undefined, opens: false },
	"garbage only": { content: "not json\n", id: undefined, opens: false },
};

/** What a load opened: the session, its entries, its title, whether a mark is left in them, and the size read. */
function opened(loaded: SessionLoadResult) {
	const opens = !loaded.invalidHeader && loaded.entries.length > 0;
	return {
		opens,
		id: opens ? (loaded.entries[0] as { id?: string }).id : undefined,
		entries: opens ? loaded.entries.length : 0,
		title: opens ? (loaded.titleSlot?.title ?? null) : null,
		markKept: opens && JSON.stringify(loaded.entries).includes(MARK),
		size: loaded.sourceSize,
	};
}

describe("the listing, the loader and a delete read a session's header the same way", () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		it(name, async () => {
			using dir = TempDir.createSync("@omp-header-agreement-");
			const file = path.join(dir.path(), "s.jsonl");
			await Bun.write(file, shape.content);
			const files = new FileSessionStorage();
			const memory = new MemorySessionStorage();
			memory.writeTextSync(file, shape.content);

			const listedBy = async (storage: SessionStorage) =>
				(await listSessions(dir.path(), storage)).find(info => info.path === file)?.id;
			const expected = {
				opens: shape.opens,
				id: shape.opens ? shape.id : undefined,
				entries: shape.opens ? (shape.entries ?? 2) : 0,
				title: shape.opens ? (shape.title ?? null) : null,
				markKept: shape.markKept ?? false,
				size: Buffer.byteLength(shape.content),
			};

			expect({
				listed: [await listedBy(files), await listedBy(memory)],
				deleteReads: [
					await readSessionHeaderId(file, files),
					await readSessionHeaderId(file, memory),
					sessionHeaderIdOfHead(shape.content),
				],
				whole: leadingSessionHeader(shape.content)?.record !== undefined,
				textPath: opened(await loadSessionFile(file, files)),
				streamPath: opened(await loadEntriesFromFileStream(file, { storage: files })),
				memory: opened(await loadSessionFile(file, memory)),
			}).toEqual({
				listed: [shape.id, shape.id],
				deleteReads: [shape.id, shape.id, shape.id],
				whole: shape.whole ?? shape.opens,
				textPath: expected,
				streamPath: expected,
				memory: expected,
			});
		});
	}
});
