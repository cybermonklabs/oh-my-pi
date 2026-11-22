/**
 * Defines lazy proxy properties on a wrapper so it forwards to the underlying tool.
 */
import { isArkSchema } from "@oh-my-pi/pi-ai/utils/schema";

export function applyToolProxy<TTool extends object>(tool: TTool, wrapper: object): void {
	const visited = new Set<PropertyKey>();
	let current: object | null = tool;

	while (current && current !== Object.prototype) {
		for (const key of Reflect.ownKeys(current)) {
			if (key === "constructor" || visited.has(key) || key in wrapper) {
				continue;
			}
			visited.add(key);
			// The bound method for the function it was bound from: reads hand back the same function while the tool
			// keeps the same one, so a consumer that keys on it (the agent's per-tool keys key on `intent`) sees it stay.
			let boundFrom: unknown;
			let bound: unknown;
			Object.defineProperty(wrapper, key, {
				get() {
					const value = (tool as Record<PropertyKey, unknown>)[key];
					if (typeof value !== "function") return value;
					// Callable schema values (ArkType `Type`, e.g. the `parameters` schema)
					// must pass through untouched: `bind()` returns a bare bound function
					// that drops the schema surface (`toJsonSchema`/`assert`/own keys), so a
					// bound schema later stringifies to `undefined` and poisons wire-schema
					// and token accounting. Only genuine methods are bound so `this` is
					// preserved through the wrapper.
					if (isArkSchema(value) || typeof value.bind !== "function") return value;
					if (value !== boundFrom) {
						bound = value.bind(tool);
						boundFrom = value;
					}
					return bound;
				},
				enumerable: true,
				configurable: true,
			});
		}
		current = Object.getPrototypeOf(current);
	}
}
