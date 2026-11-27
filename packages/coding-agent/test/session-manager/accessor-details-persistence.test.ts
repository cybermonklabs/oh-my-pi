import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { makeAssistantMessage } from "./helpers";

/**
 * Shape of `@mendable/firecrawl-js` `SearchData`: plain own fields plus a
 * non-enumerable `data` getter that throws to steer callers to `.web`.
 * `JSON.stringify` never reads it; the persistence walk must not either.
 */
function sdkResultWithThrowingGetter(): object {
	const result = { web: [{ url: "https://example.com", title: "Example" }] };
	Object.defineProperty(result, "data", {
		get() {
			throw new Error("SearchData has no '.data'. Results are grouped by source: .web (1 results)");
		},
		enumerable: false,
	});
	return result;
}

describe("tool result details with throwing accessors", () => {
	it("persists the tool result and every later entry", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "search", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		session.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "firecrawl_search",
			content: [{ type: "text", text: "results" }],
			details: sdkResultWithThrowingGetter(),
			isError: false,
			timestamp: 2,
		});
		session.appendMessage({ role: "user", content: "after the search", timestamp: 3 });
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const lines = storage
			.readTextSync(sessionFile)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		const messages = lines.filter(line => line.type === "message").map(line => line.message);

		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
		expect(messages[2].details).toEqual({ web: [{ url: "https://example.com", title: "Example" }] });
	});

	// A field the line drops (`jsonlEvents`) makes the walk rebuild the object from the fields it read; reading a
	// getter again for the rebuilt copy wrote its second answer where `JSON.stringify` writes its first.
	it("writes a getter's first answer into an entry the walk rebuilds, reading it once", async () => {
		const storage = new MemorySessionStorage();
		const session = SessionManager.create("/work", "/sessions", storage);
		session.appendMessage({ role: "user", content: "count", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		let reads = 0;
		session.appendCustomEntry("counter", {
			get a() {
				return ++reads;
			},
			jsonlEvents: [],
		});
		await session.flush();

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		const custom = storage
			.readTextSync(sessionFile)
			.trim()
			.split("\n")
			.map(line => JSON.parse(line))
			.find(line => line.type === "custom");

		expect({ data: custom?.data, reads }).toEqual({ data: { a: 1 }, reads: 1 });
	});

	// The walk first scans an entry for a field the line changes, then rebuilds what the scan found, and scans
	// each field after that one before it rebuilds it too: a getter such a scan read on its way to a dropped
	// field deeper in the entry was read again for the rebuilt copy, once per level, which wrote a later answer
	// where `JSON.stringify` writes the first.
	it("writes the first answer of a getter a scan reads below the top level, reading it once", async () => {
		const shapes = {
			// The scan of the whole entry reads the getter.
			"on the path of the entry's scan": (counter: object) => ({
				data: { items: [counter] },
				written: { items: [{ a: 1, events: {} }] },
			}),
			// The rebuild of `data` scans `items` after the field that scan stopped at, and that scan reads the getter.
			"on the path of a scan the rebuild starts": (counter: object) => ({
				data: { dropped: { jsonlEvents: [] }, items: [counter] },
				written: { dropped: {}, items: [{ a: 1, events: {} }] },
			}),
		};
		for (const [where, shape] of Object.entries(shapes)) {
			const storage = new MemorySessionStorage();
			const session = SessionManager.create("/work", "/sessions", storage);
			session.appendMessage({ role: "user", content: "count", timestamp: 1 });
			session.appendMessage(makeAssistantMessage());
			let reads = 0;
			const { data, written } = shape({
				get a() {
					return ++reads;
				},
				events: { jsonlEvents: [] },
			});
			session.appendCustomEntry("counter", data);
			await session.flush();

			const sessionFile = session.getSessionFile();
			if (!sessionFile) throw new Error("Expected a session file");
			const custom = storage
				.readTextSync(sessionFile)
				.trim()
				.split("\n")
				.map(line => JSON.parse(line))
				.find(line => line.type === "custom");

			expect({ where, data: custom?.data, reads }).toEqual({ where, data: written, reads: 1 });
		}
	});
});

/** A session whose file exists, so the manager appends each later entry to it as it records the entry. */
function sessionWithFile(storage: MemorySessionStorage): SessionManager {
	const session = SessionManager.create("/work", "/sessions", storage);
	session.appendMessage({ role: "user", content: "start", timestamp: 1 });
	session.appendMessage(makeAssistantMessage());
	return session;
}

/** The custom entries `session`'s file holds, as a reader parses them, without the fields the manager gives each. */
function storedCustomEntries(session: SessionManager, storage: MemorySessionStorage): unknown[] {
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Expected a session file");
	return storage
		.readTextSync(sessionFile)
		.trim()
		.split("\n")
		.map(line => JSON.parse(line))
		.filter(line => line.type === "custom")
		.map(({ id: _id, parentId: _parentId, timestamp: _timestamp, runtime: _runtime, ...fields }) => fields);
}

/**
 * How many of `refs` still reach their target after collections across a few event-loop turns. Bun's conservative
 * stack scan can pin the most recently dropped object in a stale native stack slot, so callers tolerate one.
 */
async function liveAfterGc(refs: WeakRef<object>[]): Promise<number> {
	let live = refs.length;
	for (let turn = 0; turn < 20; turn++) {
		Bun.gc(true);
		live = refs.filter(ref => ref.deref() !== undefined).length;
		if (live === 0) break;
		// A WeakRef keeps its target alive until the task that made or read it ends: a zero-length sleep yields one
		// task so the next collection can clear it (no wall-clock wait; fake timers cannot end a task).
		await Bun.sleep(0);
	}
	return live;
}

describe("persistence scans a getter interrupts", () => {
	// A getter the scan of an entry reads can persist another session's entry, which is scanned in turn. On one
	// trail shared by every scan, the inner scan dropped what the outer scan had read, so the outer entry's rebuild
	// took the wrong values for its fields: its line kept the `jsonlEvents` it drops, and writing it called the
	// getter again, which wrote the other session's entry twice.
	it("writes each entry's own fields when a getter its scan reads persists another session's entry", async () => {
		const outerStorage = new MemorySessionStorage();
		const innerStorage = new MemorySessionStorage();
		const outer = sessionWithFile(outerStorage);
		const inner = sessionWithFile(innerStorage);
		let reads = 0;
		outer.appendCustomEntry("outer", {
			before: { note: "outer before" },
			get nested() {
				reads++;
				inner.appendCustomEntry("inner", { before: { note: "inner before" }, dropped: { jsonlEvents: [] } });
				return { note: "outer nested" };
			},
			dropped: { jsonlEvents: [] },
		});
		await outer.flush();
		await inner.flush();

		expect({
			outer: storedCustomEntries(outer, outerStorage),
			inner: storedCustomEntries(inner, innerStorage),
			reads,
		}).toEqual({
			outer: [
				{
					type: "custom",
					customType: "outer",
					data: { before: { note: "outer before" }, nested: { note: "outer nested" }, dropped: {} },
				},
			],
			inner: [{ type: "custom", customType: "inner", data: { before: { note: "inner before" }, dropped: {} } }],
			reads: 1,
		});
	});

	// A getter that throws ends the scan that reads it, and the write fails with that error. On one trail shared by
	// every scan, what the failed scan had read stayed reachable until the next scan began; the next scan must still
	// start on an empty trail, or its entry's rebuild takes the failed scan's values for its fields.
	it("lets go of what a scan a getter's throw ended read, and the next entry writes its own fields", async () => {
		const failing = sessionWithFile(new MemorySessionStorage());
		const failures: Error[] = [];
		failing.onPersistenceError(error => failures.push(error));
		const thrown: Error[] = [];
		const read: WeakRef<object>[] = [];
		const data = {};
		for (let index = 0; index < 8; index++) {
			Object.defineProperty(data, `field${index}`, {
				enumerable: true,
				get() {
					const value = { index };
					read.push(new WeakRef(value));
					return value;
				},
			});
		}
		Object.defineProperty(data, "broken", {
			enumerable: true,
			get() {
				const error = new Error("broken getter");
				thrown.push(error);
				throw error;
			},
		});
		failing.appendCustomEntry("broken", data);

		// The scan reads the getter first; the write's retry on the entry's JSON reads it again and keeps the
		// first error, the scan's.
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBe(thrown[0]);
		expect(await liveAfterGc(read)).toBeLessThanOrEqual(1);

		const storage = new MemorySessionStorage();
		const next = sessionWithFile(storage);
		next.appendCustomEntry("next", { before: { note: "next before" }, dropped: { jsonlEvents: [] } });
		await next.flush();
		expect(storedCustomEntries(next, storage)).toEqual([
			{ type: "custom", customType: "next", data: { before: { note: "next before" }, dropped: {} } },
		]);
	});
});

describe("an entry the write rebuilds", () => {
	// A field the scan finds clean was kept by reference in the rebuilt entry, so the line's `JSON.stringify` called
	// a getter in it a second time and wrote that second answer: beside a dropped `jsonlEvents` (in either order),
	// where the rebuild scans the field, and beside a field on the scan's path to a dropped one, where the scan of
	// the whole entry read it.
	it("writes the first answer of a getter in a field the line keeps as it is, reading it once", async () => {
		const shapes = {
			"before a dropped jsonlEvents": (kept: object) => ({
				data: { kept, jsonlEvents: [] },
				written: { kept: { a: 1 } },
			}),
			"after a dropped jsonlEvents": (kept: object) => ({
				data: { jsonlEvents: [], kept },
				written: { kept: { a: 1 } },
			}),
			"before a field holding a dropped jsonlEvents": (kept: object) => ({
				data: { kept, dropped: { jsonlEvents: [] } },
				written: { kept: { a: 1 }, dropped: {} },
			}),
		};
		for (const [where, shape] of Object.entries(shapes)) {
			const storage = new MemorySessionStorage();
			const session = sessionWithFile(storage);
			let reads = 0;
			const { data, written } = shape({
				get a() {
					return ++reads;
				},
			});
			session.appendCustomEntry("kept", data);
			await session.flush();

			expect({ where, entries: storedCustomEntries(session, storage), reads }).toEqual({
				where,
				entries: [{ type: "custom", customType: "kept", data: written }],
				reads: 1,
			});
		}
	});

	// The rebuild took the values the scan read by position, in a second pass over the object's keys, so a getter
	// that changed its own object's keys during the scan moved each later value onto another key: an oversized
	// string was written whole, a dropped `jsonlEvents` was written, and an integer key the getter added took its
	// answer. The line holds the keys the object holds, each with the first value read under it.
	it("writes each field under its own key when a getter the scan reads changes its object's keys", async () => {
		const notice = "\n\n[Session persistence truncated large content]";
		const shapes = {
			"deletes an earlier key, beside an oversized string": (count: () => number) => {
				const data: Record<string, unknown> = { a: "a" };
				Object.defineProperty(data, "b", {
					enumerable: true,
					configurable: true,
					get() {
						delete data.a;
						return `b${count()}`;
					},
				});
				data.d = "x".repeat(600_000);
				return { data, written: { b: "b1", d: "500000 characters, cut" } };
			},
			"deletes an earlier key, beside a dropped jsonlEvents": (count: () => number) => {
				const data: Record<string, unknown> = { a: "a" };
				Object.defineProperty(data, "b", {
					enumerable: true,
					configurable: true,
					get() {
						delete data.a;
						return `b${count()}`;
					},
				});
				data.d = { jsonlEvents: [{ type: "event" }] };
				return { data, written: { b: "b1", d: {} } };
			},
			"adds an integer key": (count: () => number) => {
				const data: Record<string, unknown> = {};
				Object.defineProperty(data, "a", {
					enumerable: true,
					configurable: true,
					get() {
						data[0] = "zero";
						return `a${count()}`;
					},
				});
				data.d = { jsonlEvents: [] };
				return { data, written: { 0: "zero", a: "a1", d: {} } };
			},
		};
		// Writes a long string as its length, and whether the line cut it, so a failure prints no 600,000 characters.
		const shortened = (_key: string, field: unknown): unknown =>
			typeof field === "string" && field.length > 1_000
				? `${field.length} characters${field.endsWith(notice) ? ", cut" : ""}`
				: field;
		for (const [where, shape] of Object.entries(shapes)) {
			const storage = new MemorySessionStorage();
			const session = sessionWithFile(storage);
			let reads = 0;
			const { data, written } = shape(() => ++reads);
			session.appendCustomEntry("keys", data);
			await session.flush();

			const entries = JSON.parse(JSON.stringify(storedCustomEntries(session, storage), shortened));
			expect({ where, entries, reads }).toEqual({
				where,
				entries: [{ type: "custom", customType: "keys", data: written }],
				reads: 1,
			});
		}
	});
});
