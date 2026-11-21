/**
 * The longest string or buffer a path under test hands to, or takes back
 * from, a storage or its backend: a test of a memory bound wraps their
 * methods with these and checks what {@link Longest} noted.
 */

/** The UTF-8 bytes of a string, the bytes of a buffer, 0 for anything else. */
export function byteSize(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof Uint8Array) return value.byteLength;
	return 0;
}

/** The largest string or buffer an instrumented path saw, in UTF-8 bytes, and what it was. */
export class Longest {
	bytes = 0;
	what = "nothing";

	note(bytes: number, what: string): void {
		if (bytes <= this.bytes) return;
		this.bytes = bytes;
		this.what = what;
	}

	reset(): void {
		this.bytes = 0;
		this.what = "nothing";
	}
}

function isStream(value: unknown): value is AsyncIterable<unknown> {
	return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

async function* noteChunks(chunks: AsyncIterable<unknown>, longest: Longest, name: string): AsyncGenerator<unknown> {
	for await (const chunk of chunks) {
		longest.note(byteSize(chunk), `a chunk ${name} yielded`);
		yield chunk;
	}
}

/** Note `value` in `longest`: a string or buffer, each element of an array, or the text of a `{ text, size }`. */
function noteValue(value: unknown, longest: Longest, what: string): void {
	if (Array.isArray(value)) for (const item of value) longest.note(byteSize(item), `an element of ${what}`);
	else if (typeof value === "object" && value !== null && "text" in value) {
		longest.note(byteSize(value.text), `the text of ${what}`);
	} else longest.note(byteSize(value), what);
}

/**
 * `method`, run on `target`, with `longest` noting every string handed to or
 * returned by it, each element of an array argument (a full write's lines),
 * the text of a `{ text, size }` result (a ranged read), and each chunk of a
 * stream handed to it (a streamed write's body) or returned by it, as the
 * stream yields it.
 */
export function recordMethod(
	target: object,
	name: string,
	method: Function,
	longest: Longest,
): (...args: unknown[]) => unknown {
	return (...args) => {
		const handed = args.map(arg => {
			if (isStream(arg)) return noteChunks(arg, longest, `an argument of ${name}`);
			noteValue(arg, longest, `an argument of ${name}`);
			return arg;
		});
		const result: unknown = Reflect.apply(method, target, handed);
		if (result instanceof Promise) {
			return result.then((value: unknown) => {
				noteValue(value, longest, `the result of ${name}`);
				return value;
			});
		}
		if (isStream(result)) return noteChunks(result, longest, name);
		noteValue(result, longest, `the result of ${name}`);
		return result;
	};
}

/** `storage` behind a proxy whose methods run on the storage itself, each recorded by {@link recordMethod}. */
export function recordStorage<S extends object>(storage: S, longest: Longest): S {
	return new Proxy(storage, {
		get(target, key) {
			const member: unknown = Reflect.get(target, key, target);
			return typeof member === "function" ? recordMethod(target, String(key), member, longest) : member;
		},
	});
}
