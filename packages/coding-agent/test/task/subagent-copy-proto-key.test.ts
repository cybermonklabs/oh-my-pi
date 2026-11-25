/**
 * The tester's red test, round 13: a revive copies a parked subagent's settings layers and spawn options
 * out of values its transcript holds (subagent-revive.ts reads record.options, record.wake and
 * record.settingsWrites). JSON.parse makes a `__proto__` key an own data property. A copy that assigns it with
 * `out[key] = value` swaps the copy's prototype instead: the key is gone from the copy, and the copy inherits
 * the key's fields as if the transcript had set them. Each copy must keep the key as an own field and keep
 * Object.prototype as its prototype, as rpc-frame.ts's shrink now does.
 */
import { describe, expect, it } from "bun:test";
import { withoutUndefinedFields } from "@oh-my-pi/pi-coding-agent/task/subagent-session-options";
import { withLayerWrites } from "@oh-my-pi/pi-coding-agent/task/subagent-settings";

/** What a copy holds for a `__proto__` key: whether it is its own, its value, and what the copy inherits. */
function protoKeyOf(copy: object): { own: boolean; value: unknown; plainPrototype: boolean; inherited: unknown } {
	return {
		own: Object.hasOwn(copy, "__proto__"),
		value: Object.getOwnPropertyDescriptor(copy, "__proto__")?.value,
		plainPrototype: Object.getPrototypeOf(copy) === Object.prototype,
		inherited: (copy as Record<string, unknown>).forged,
	};
}

const KEPT = { own: true, value: { forged: true }, plainPrototype: true, inherited: undefined };

describe("a revive's copy of a transcript value holding a __proto__ key", () => {
	it("keeps the key when withLayerWrites applies a write set that names it", () => {
		const writes = JSON.parse('{"set":{"__proto__":{"forged":true},"theme":"dark"}}');
		const written = withLayerWrites({ theme: "light" }, writes);
		expect({ ...protoKeyOf(written), theme: written.theme }).toEqual({ ...KEPT, theme: "dark" });
	});

	it("keeps the key of a layer that withLayerWrites copies", () => {
		const layer = JSON.parse('{"__proto__":{"forged":true},"theme":"light"}');
		const written = withLayerWrites(layer, { set: { theme: "dark" } });
		expect({ ...protoKeyOf(written), theme: written.theme }).toEqual({ ...KEPT, theme: "dark" });
	});

	it("keeps the key when withoutUndefinedFields copies recorded options", () => {
		const options = JSON.parse('{"__proto__":{"forged":true},"agent":"task","skipped":null}');
		const defined = withoutUndefinedFields(options as Record<string, unknown>);
		expect({ ...protoKeyOf(defined), agent: defined.agent }).toEqual({ ...KEPT, agent: "task" });
	});
});
