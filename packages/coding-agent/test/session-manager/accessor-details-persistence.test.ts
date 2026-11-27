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
