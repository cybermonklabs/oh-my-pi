/**
 * What `RedisSessionStorage`'s chunked-read scripts (`OMP_READ_WINDOW` and
 * `OMP_CHECK_WINDOWS`) answer, for the hand-rolled Redis doubles that run no
 * Lua: given the bytes of the key they read, or none for a missing key.
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

/**
 * The window script's reply for `bytes`, `argv` being its first byte, most
 * bytes and the size the read stops at ("" for the first window): a first
 * window from inside a character starts at the byte that begins it, and a
 * window that stops short of the read's end ends before the character its
 * next byte continues, never as nothing; `[size]` alone when the key is
 * shorter than that end.
 */
export function readWindow(bytes: Buffer | undefined, [first, most, until]: string[]): unknown[] | null {
	if (!bytes) return null;
	if (until !== "" && bytes.length < Number(until)) return [bytes.length];
	const stop = until === "" ? bytes.length : Number(until);
	const from = Number(first);
	if (from >= stop) return [bytes.length, 0, "", "", 0];
	const start = from > 0 && until === "" ? from - backToStart(bytes, from, 0) : from;
	let end = Math.min(start + Number(most), stop);
	if (end < stop) end -= backToStart(bytes, end, start + 1);
	const window = bytes.subarray(start, end);
	const digest = new Bun.CryptoHasher("sha1").update(window).digest("hex");
	return [bytes.length, window.length, digest, window.toString("utf-8"), from - start];
}

/** The check script's reply: 1 when `bytes` holds, from `argv[0]` on, each window given as its length and SHA-1. */
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
