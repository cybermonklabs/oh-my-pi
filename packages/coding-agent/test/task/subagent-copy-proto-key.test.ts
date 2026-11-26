/**
 * Adapted for the release from the tester's red test of round 13. A revive restores a parked subagent's settings
 * layers from the spawn spec its transcript holds: when the live session is disposed, layerWrites records the runs'
 * writes beyond the layers the spec stores, and the revive applies them on top of those layers with withLayerWrites.
 * JSON.parse makes a `__proto__` key an own data property. A copy that assigns it with `out[key] = value` swaps the
 * copy's prototype instead: the key is gone from the copy, and the copy inherits the key's fields as if the
 * transcript had set them. Each copy must keep the key as an own field and keep Object.prototype as its prototype.
 */
import { describe, expect, it } from "bun:test";
import { layerWrites, withLayerWrites } from "@oh-my-pi/pi-coding-agent/task/subagent-settings";

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

	it("keeps the key in the write set layerWrites records for a layer that holds it", () => {
		const layer = JSON.parse('{"__proto__":{"forged":true},"theme":"dark"}');
		const set = layerWrites({ theme: "light" }, layer)?.set ?? {};
		expect({ ...protoKeyOf(set), theme: set.theme }).toEqual({ ...KEPT, theme: "dark" });
	});

	it("records a layer's own __proto__ key that the baseline lacks, even when its value is {}", () => {
		// Read through the baseline, the missing key yields Object.prototype, which deep-equals `{}`; an own `{}`
		// still differs from an absent key.
		const layer = JSON.parse('{"__proto__":{},"theme":"light"}');
		const writes = layerWrites({ theme: "light" }, layer);
		const set = writes?.set ?? {};
		expect({ ...protoKeyOf(set), keys: Object.keys(set), removed: writes?.removed }).toEqual({
			...KEPT,
			value: {},
			keys: ["__proto__"],
			removed: undefined,
		});
	});
});
