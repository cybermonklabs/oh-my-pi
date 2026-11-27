import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

/** The data of the first custom entry `manager` holds. */
function customData(manager: SessionManager): unknown {
	const entry = manager.getEntries().find(candidate => candidate.type === "custom");
	return entry?.type === "custom" ? entry.data : undefined;
}

// A session copied to a new id (an imported foreign session, say) is the one the caller goes on working in: its
// entries must come back as `structuredClone` copies them, at any depth a transcript line holds.
describe("SessionManager.persistCopy", () => {
	it("copies a custom entry's Date and Map as they are, apart from the source", async () => {
		const storage = new MemorySessionStorage();
		const source = SessionManager.create("/work", "/sessions", storage);
		const data = { date: new Date(0), map: new Map([["x", 1]]) };
		source.appendCustomEntry("probe", data);

		const copy = await source.persistCopy({ sessionDir: "/copies", suppressBreadcrumb: true }, storage);
		data.map.set("x", 2);

		const copied = customData(copy);
		expect(copied).toEqual({ date: new Date(0), map: new Map([["x", 1]]) });
		expect(typeof copied === "object" && copied !== null && "date" in copied && copied.date).toBeInstanceOf(Date);
		expect(typeof copied === "object" && copied !== null && "map" in copied && copied.map).toBeInstanceOf(Map);
	});

	it("copies a custom entry nested 50,000 levels with the Map beside it", async () => {
		const storage = new MemorySessionStorage();
		const source = SessionManager.create("/work", "/sessions", storage);
		let deep: Record<string, unknown> = { leaf: "bottom" };
		for (let level = 0; level < 50_000; level++) deep = { next: deep };
		source.appendCustomEntry("probe", { deep, map: new Map([["x", 1]]) });

		const copy = await source.persistCopy({ sessionDir: "/copies", suppressBreadcrumb: true }, storage);

		const copied = customData(copy);
		expect(typeof copied === "object" && copied !== null && "map" in copied && copied.map).toEqual(
			new Map([["x", 1]]),
		);
		let node = typeof copied === "object" && copied !== null && "deep" in copied ? copied.deep : undefined;
		let levels = 0;
		while (typeof node === "object" && node !== null && "next" in node) {
			node = node.next;
			levels++;
		}
		expect(levels).toBe(50_000);
		expect(node).toEqual({ leaf: "bottom" });
	}, 30_000);
});
