/**
 * What `RedisSessionStorage`'s chunked-read scripts (`OMP_READ_WINDOW` and
 * `OMP_CHECK_WINDOWS`) answer, and what its write scripts keep in the
 * generation hash, for the hand-rolled Redis doubles that run no Lua.
 */

/** Whether `byte` continues a UTF-8 character (10xxxxxx). */
function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/**
 * The continuation bytes, at most three and none before byte `floor`, that run
 * back from byte `at` of `bytes` to the byte that begins their character; 0
 * when byte `at` begins one, or when no such byte is found.
 */
function backToStart(bytes: Buffer, at: number, floor: number): number {
	let back = 0;
	while (back < 3 && at - back > Math.max(floor, at - 3) && isContinuation(bytes[at - back])) back++;
	const lead = bytes[at - back];
	return back > 0 && lead !== undefined && lead >= 0xc0 ? back : 0;
}

/** A generation hash value, `<token> <mtime>`, as its token and its mtime; neither when it has no such shape. */
function splitGeneration(held: string | undefined): [token?: string, mtime?: string] {
	const match = held === undefined ? null : /^(\S+) (.*)$/.exec(held);
	return match ? [match[1], match[2]] : [];
}

/** The generation hash value a full write or a move leaves: its new `token` and the mtime it sets. */
export function newGeneration(token: string, mtimeMs: string): string {
	return `${token} ${mtimeMs}`;
}

/**
 * The generation hash value an append or a title update leaves, given the
 * value `held` and the meta hash's `mtime` before it, its new `token` and the
 * mtime it sets: the held token while the mtime recorded beside it is the meta
 * hash's, else the new one.
 */
export function keptGeneration(
	held: string | undefined,
	mtime: string | undefined,
	token: string,
	mtimeMs: string,
): string {
	const [kept, recorded] = splitGeneration(held);
	return newGeneration(kept !== undefined && recorded === mtime ? kept : token, mtimeMs);
}

/**
 * The generation a window returns, given the generation hash's value `held`
 * and the meta hash's `mtime`: the token while the mtime recorded beside it is
 * the meta hash's, else "?" and the meta hash's mtime.
 */
export function windowGeneration(held: string | undefined, mtime: string | undefined): string {
	const [token, recorded] = splitGeneration(held);
	return token !== undefined && recorded === mtime ? token : `?${mtime ?? ""}`;
}

/**
 * The window script's reply for `bytes` at `generation` (see
 * {@link windowGeneration}), `argv` being its first byte, most bytes and the
 * size the read stops at ("" for the first window): a first window from inside
 * a character starts at the byte that begins it, and a window that stops short
 * of the read's end ends before the character its next byte continues, never
 * as nothing; its SHA-1 when the generation has no token, else ""; `[size]`
 * alone when the key is shorter than that end.
 */
export function readWindow(
	bytes: Buffer | undefined,
	generation: string,
	[first, most, until]: string[],
): unknown[] | null {
	if (!bytes) return null;
	if (until !== "" && bytes.length < Number(until)) return [bytes.length];
	const stop = until === "" ? bytes.length : Number(until);
	const from = Number(first);
	if (from >= stop) return [bytes.length, generation, 0, "", "", 0];
	const start = from > 0 && until === "" ? from - backToStart(bytes, from, 0) : from;
	let end = Math.min(start + Number(most), stop);
	if (end < stop) end -= backToStart(bytes, end, start + 1);
	const window = bytes.subarray(start, end);
	const digest = generation.startsWith("?") ? new Bun.CryptoHasher("sha1").update(window).digest("hex") : "";
	return [bytes.length, generation, window.length, digest, window.toString("utf-8"), from - start];
}

/** The end check script's reply: 1 when `bytes` holds, from `argv[0]` on, each window given as its length and SHA-1. */
export function holdsWindows(bytes: Buffer | undefined, [first, ...windows]: string[]): number {
	if (!bytes) return 0;
	let at = Number(first);
	for (let i = 0; i < windows.length; i += 2) {
		const window = bytes.subarray(at, at + Number(windows[i]));
		if (window.length !== Number(windows[i])) return 0;
		if (new Bun.CryptoHasher("sha1").update(window).digest("hex") !== windows[i + 1]) return 0;
		at += window.length;
	}
	return 1;
}
