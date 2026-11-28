export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Whether `value` is an array of strings (an empty one included). */
export function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Whether `value` is an object or an array, not `null`: what a walk over JSON-shaped data goes into. */
export function isNonNullObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/** Whether `value`'s prototype is `Object.prototype` or `null`: an object as `JSON.parse` makes one, not a class instance, `Date` or `Map`. */
export function isJsonRecord(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Reads an own string-valued property without invoking accessors. */
export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
