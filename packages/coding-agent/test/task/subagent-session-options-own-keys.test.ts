/**
 * A subagent's park copies the fields a fixed key list names out of its spawn options and wake inputs into the revive
 * record it writes (`withoutUndefinedFields`). The copy holds only the fields the source holds itself.
 */
import { describe, expect, it } from "bun:test";
import { withoutUndefinedFields } from "@oh-my-pi/pi-coding-agent/task/subagent-session-options";

describe("withoutUndefinedFields with a key list", () => {
	// If this regresses, a key list naming `__proto__` copies Object.prototype, which every source without that key
	// inherits, into an own `__proto__` field, and a revive record written from the copy holds `"__proto__":{}`.
	it("leaves out a key the source only inherits", () => {
		const fields: Record<string, unknown> = { a: 1 };
		const keys: readonly string[] = ["a", "__proto__"];
		const copy = withoutUndefinedFields(fields, keys);
		expect(Object.hasOwn(copy, "__proto__")).toBe(false);
		expect(copy).toEqual({ a: 1 });
	});
});
