/**
 * V8 heap-snapshot counting helpers for retention tests.
 *
 * Uses `Bun.generateHeapSnapshot("v8")` after explicit GC rounds so tests can
 * verify that dropped keys or redundant metadata fields are gone from the live
 * heap without reading private fields by name.
 */

export interface V8HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: Array<string | string[]>;
			edge_fields: string[];
			edge_types: Array<string | string[]>;
		};
	};
	nodes: number[];
	edges: number[];
	strings: string[];
}

/**
 * Run several full GC cycles, each from a fresh macrotask turn so bindings
 * from the previous turn and pending microtasks can be collected.
 */
export async function collectGarbage(rounds = 4): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
}

/** Capture and parse a V8-format heap snapshot of the current JS thread. */
export function takeV8HeapSnapshot(): V8HeapSnapshot {
	return JSON.parse(Bun.generateHeapSnapshot("v8")) as V8HeapSnapshot;
}

/**
 * Count string nodes in `snapshot` whose text satisfies `predicate`.
 * Callers that search for a unique marker should assemble the needle inside
 * `predicate` (or after {@link takeV8HeapSnapshot}) so the needle itself is
 * never present in the snapshot.
 */
export function countHeapStringsMatching(snapshot: V8HeapSnapshot, predicate: (text: string) => boolean): number {
	const { node_fields: nodeFields, node_types: nodeTypes } = snapshot.snapshot.meta;
	const typeOffset = nodeFields.indexOf("type");
	const nameOffset = nodeFields.indexOf("name");
	const typeNames = nodeTypes[typeOffset];
	if (typeOffset < 0 || nameOffset < 0 || !Array.isArray(typeNames)) {
		throw new Error("Unexpected V8 heap snapshot node schema");
	}
	const stride = nodeFields.length;
	let count = 0;
	for (let offset = 0; offset < snapshot.nodes.length; offset += stride) {
		if (typeNames[snapshot.nodes[offset + typeOffset]!] !== "string") continue;
		const text = snapshot.strings[snapshot.nodes[offset + nameOffset]!] ?? "";
		if (predicate(text)) count++;
	}
	return count;
}
