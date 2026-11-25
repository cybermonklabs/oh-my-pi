/**
 * `node:util/types`' boxed-primitive checks for the browser bundles of the
 * dashboard client's code, which `client-bundle.ts` resolves `node:util/types`
 * to: Bun's browser target gives that module no exports, and pi-utils' JSON
 * writer (`stringifyDeepJson`, which the client uses to show a transcript entry
 * of any depth) tells a boxed number, string, boolean or bigint apart by these.
 * Each check reads the internal slot as Node's does, by calling the type's own
 * `valueOf` on the value, so a box from another realm, or one whose prototype
 * changed, is still a box, and any other object is not.
 */

function hasSlot(value: unknown, valueOf: (this: unknown) => unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	try {
		valueOf.call(value);
		return true;
	} catch {
		return false;
	}
}

export function isNumberObject(value: unknown): boolean {
	return hasSlot(value, Number.prototype.valueOf);
}

export function isStringObject(value: unknown): boolean {
	return hasSlot(value, String.prototype.valueOf);
}

export function isBooleanObject(value: unknown): boolean {
	return hasSlot(value, Boolean.prototype.valueOf);
}

export function isBigIntObject(value: unknown): boolean {
	return hasSlot(value, BigInt.prototype.valueOf);
}
