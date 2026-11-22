/**
 * Whether `a` and `b` have the same own enumerable keys, each holding the identical value: a shallow snapshot taken
 * of an object (`{ ...source }`) still matches it while no field of it was replaced in place.
 */
export function sameOwnFields(a: object, b: object): boolean {
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	for (const key of aKeys) {
		if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
	}
	return true;
}
