/**
 * Render inputs a tool getter compares with the ones it last rendered from, so it renders its definition again only
 * when one of them changed. The inputs may hold caller-owned arrays and objects that an embedder changes in place (a
 * live agent list it pushes to), so the getter keeps a copy of them ({@link renderInputsSnapshot}) rather than the
 * objects themselves, and a later read compares its inputs with that copy value by value ({@link sameRenderInputs}).
 */

/**
 * How deep arrays and plain objects are copied and compared; deeper values count by reference. Every value a getter's
 * renderer reads sits well above it (an agent's `tools` entry is four levels down), so a value changed in place below
 * it is one the rendering does not read.
 */
const MAX_DEPTH = 8;

/** A copy of `inputs`, arrays and plain objects copied down to {@link MAX_DEPTH}; other values kept by reference. */
export function renderInputsSnapshot<T extends object>(inputs: T): T {
	return copyInput(inputs, 0) as T;
}

/** Whether `inputs` hold the same values as `snapshot` ({@link renderInputsSnapshot}); false without one. */
export function sameRenderInputs(snapshot: object | undefined, inputs: object): boolean {
	return snapshot !== undefined && sameInput(snapshot, inputs, 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function copyInput(value: unknown, depth: number): unknown {
	if (depth >= MAX_DEPTH) return value;
	if (Array.isArray(value)) return value.map(item => copyInput(item, depth + 1));
	if (!isPlainObject(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const key in value) copy[key] = copyInput(value[key], depth + 1);
	return copy;
}

function sameInput(before: unknown, now: unknown, depth: number): boolean {
	if (before === now) return true;
	if (depth >= MAX_DEPTH) return false;
	if (Array.isArray(before) && Array.isArray(now)) {
		if (before.length !== now.length) return false;
		for (let index = 0; index < now.length; index++) {
			if (!sameInput(before[index], now[index], depth + 1)) return false;
		}
		return true;
	}
	if (!isPlainObject(before) || !isPlainObject(now)) return false;
	let size = 0;
	for (const key in now) {
		if (!Object.hasOwn(before, key) || !sameInput(before[key], now[key], depth + 1)) return false;
		size++;
	}
	for (const key in before) if (Object.hasOwn(before, key)) size--;
	return size === 0;
}
