/**
 * The session listing, the loader and a delete's check read a session file's header through one function
 * (`leadingSessionHeader`), so they name the same session: a delete accepts every session the picker lists, and the
 * loader opens a session only when that function finds its header whole (and then names the same id). A header that
 * is listed but not opened (cut short, or after a `title` record that is not the written slot) is still deleted as
 * listed. Each shape below runs through the three, read through the file store (which decodes the file) and the
 * in-memory store (which returns the text as stored, a leading byte order mark included, as SQL and Redis do).
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import {
	parseSessionContent,
	readSessionHeaderId,
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
const header = (fields: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "session", version: 3, id: ID, timestamp: "2026-11-21T00:00:00.000Z", cwd: "/w", ...fields });
const turn = `${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-21T00:00:01.000Z", message: { role: "user", content: "hi", timestamp: 1 } })}\n`;
/** A `title` record that is not the fixed-width slot omp writes (no `v`, `updatedAt` or `pad`). */
const slot = JSON.stringify({ type: "title", title: "named" });
/** The fixed-width title slot line omp writes, newline included. */
const writtenSlot = serializeTitleSlot({ title: "named", source: "user", updatedAt: "2026-11-21T00:00:00.000Z" });

interface Shape {
	readonly content: string;
	/** The id all three readers name; `undefined` when none does. */
	readonly id: string | undefined;
	/** Whether the loader opens it: its header parses whole as the first record after the written slot. */
	readonly opens: boolean;
}

const SHAPES: Record<string, Shape> = {
	"a whole header": { content: `${header()}\n${turn}`, id: ID, opens: true },
	"the written title slot, then a whole header": {
		content: `${writtenSlot}${header()}\n${turn}`,
		id: ID,
		opens: true,
	},
	"a title record that is not the written slot, then a whole header": {
		content: `${slot}\n${header()}\n${turn}`,
		id: ID,
		opens: false,
	},
	"blank lines, then a whole header": { content: `\n\n${header()}\n${turn}`, id: ID, opens: true },
	// A SQL or Redis store returns a leading byte order mark as stored; the file store's decoder drops it.
	"a byte order mark, then a whole header": { content: `\uFEFF${header()}\n${turn}`, id: ID, opens: true },
	"a byte order mark, the written title slot, then a whole header": {
		content: `\uFEFF${writtenSlot}${header()}\n${turn}`,
		id: ID,
		opens: true,
	},
	"a byte order mark, then a header cut short": { content: `\uFEFF${header().slice(0, -12)}`, id: ID, opens: false },
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

describe("the listing, the loader and a delete read a session's header the same way", () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		it(name, async () => {
			using dir = TempDir.createSync("@omp-header-agreement-");
			const file = path.join(dir.path(), "s.jsonl");
			await Bun.write(file, shape.content);
			// The file store decodes the file (a leading byte order mark dropped); the in-memory store returns the
			// text as stored, as a SQL or Redis store does.
			const memory = new MemorySessionStorage();
			memory.writeTextSync(file, shape.content);

			const listedBy = async (storage: SessionStorage) =>
				(await listSessions(dir.path(), storage)).find(info => info.path === file)?.id;
			const listed = [await listedBy(new FileSessionStorage()), await listedBy(memory)];
			const deleteReads = [
				await readSessionHeaderId(file, new FileSessionStorage()),
				await readSessionHeaderId(file, memory),
				sessionHeaderIdOfHead(shape.content),
			];
			const loaded = parseSessionContent(shape.content);
			const opens = !loaded.invalidHeader && loaded.entries.length > 0;

			expect({
				listed,
				deleteReads,
				opens,
				openedId: opens ? (loaded.entries[0] as { id?: string }).id : undefined,
			}).toEqual({
				listed: [shape.id, shape.id],
				deleteReads: [shape.id, shape.id, shape.id],
				opens: shape.opens,
				openedId: shape.opens ? shape.id : undefined,
			});
		});
	}
});
