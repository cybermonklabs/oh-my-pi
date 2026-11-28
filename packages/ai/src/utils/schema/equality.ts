import { ContainerPairPath, type NestedWalk, runNested } from "@oh-my-pi/pi-utils";
import type { JsonObject } from "./types";
import { isJsonObject } from "./types";

/**
 * Whether two JSON values are equal: primitives as `Object.is` compares them,
 * arrays of one length element by element, and objects with the same
 * enumerable keys (`for…in`) holding equal values. It walks on its own stack
 * ({@link runNested}): `const`, `enum` and `uniqueItems` compare a tool call's
 * arguments, which nest as deep as `JSON.parse` reads, where a recursive walk
 * ran out of stack. A pair of containers met again inside itself, a cycle,
 * which JSON never holds, is answered as `Bun.deepEquals` answers it
 * ({@link ContainerPairPath}).
 */
export function areJsonValuesEqual(left: unknown, right: unknown): boolean {
	const settled = shallowEquality(left, right);
	if (settled !== undefined) return settled;
	return runNested(equalContents(left as object, right as object, new ContainerPairPath()));
}

/**
 * {@link areJsonValuesEqual} of a pair its kinds settle, or `undefined` for two
 * arrays of one length or two objects, which their contents settle.
 */
function shallowEquality(left: unknown, right: unknown): boolean | undefined {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length ? undefined : false;
	}
	return isJsonObject(left) && isJsonObject(right) ? undefined : false;
}

/**
 * Whether `left` and `right`, two arrays of one length or two objects a pair
 * `path` is inside of, hold equal values; each pair of child containers that
 * {@link shallowEquality} leaves open is a nested step.
 */
function* equalContents(left: object, right: object, path: ContainerPairPath): NestedWalk<boolean> {
	const metAgain = path.enter(left, right);
	if (metAgain !== undefined) return metAgain;
	if (Array.isArray(left)) {
		const items = right as unknown[];
		for (let i = 0; i < left.length; i += 1) {
			const x: unknown = left[i];
			const y = items[i];
			if (!(shallowEquality(x, y) ?? (yield equalContents(x as object, y as object, path)))) return false;
		}
	} else {
		const leftRecord = left as Record<string, unknown>;
		const rightRecord = right as Record<string, unknown>;
		let rightLen = 0;
		for (const _ in rightRecord) rightLen++;
		let leftLen = 0;
		for (const key in leftRecord) {
			leftLen++;
			if (!(key in rightRecord)) return false;
			const x = leftRecord[key];
			const y = rightRecord[key];
			if (!(shallowEquality(x, y) ?? (yield equalContents(x as object, y as object, path)))) return false;
		}
		if (leftLen !== rightLen) return false;
	}
	path.leave(left, right);
	return true;
}

export function mergeCompatibleEnumSchemas(existing: unknown, incoming: unknown): JsonObject | null {
	if (!isJsonObject(existing) || !isJsonObject(incoming)) {
		return null;
	}
	const existingEnum = Array.isArray(existing.enum) ? existing.enum : null;
	const incomingEnum = Array.isArray(incoming.enum) ? incoming.enum : null;
	if (!existingEnum || !incomingEnum) {
		return null;
	}
	if (!areJsonValuesEqual(existing.type, incoming.type)) {
		return null;
	}
	let existingNonEnumCount = 0;
	for (const key in existing) {
		if (key !== "enum") existingNonEnumCount++;
	}
	let incomingNonEnumCount = 0;
	for (const key in incoming) {
		if (key !== "enum") incomingNonEnumCount++;
	}
	if (existingNonEnumCount !== incomingNonEnumCount) {
		return null;
	}
	for (const key in existing) {
		if (key === "enum") continue;
		if (!(key in incoming) || !areJsonValuesEqual(existing[key], incoming[key])) {
			return null;
		}
	}

	const mergedEnum = [...existingEnum];
	for (const enumValue of incomingEnum) {
		if (!mergedEnum.some(existingValue => areJsonValuesEqual(existingValue, enumValue))) {
			mergedEnum.push(enumValue);
		}
	}
	return {
		...existing,
		enum: mergedEnum,
	};
}

function getAnyOfVariants(schema: unknown): unknown[] {
	if (isJsonObject(schema) && Array.isArray(schema.anyOf)) {
		return schema.anyOf;
	}
	return [schema];
}

export function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
	if (areJsonValuesEqual(existing, incoming)) {
		return existing;
	}
	const mergedEnumSchema = mergeCompatibleEnumSchemas(existing, incoming);
	if (mergedEnumSchema !== null) {
		return mergedEnumSchema;
	}

	const mergedAnyOf = [...getAnyOfVariants(existing)];
	for (const variant of getAnyOfVariants(incoming)) {
		if (!mergedAnyOf.some(existingVariant => areJsonValuesEqual(existingVariant, variant))) {
			mergedAnyOf.push(variant);
		}
	}
	return mergedAnyOf.length === 1 ? mergedAnyOf[0] : { anyOf: mergedAnyOf };
}
