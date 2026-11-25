/**
 * What the SQL and Redis backends share for a streamed full write
 * (`writeFullStream`): the age of a dead writer's staged parts, and the cut
 * of the body into parts that end on character boundaries.
 */

/**
 * Age at which the staged parts of a backend's streamed full write are a dead
 * writer's: a live full write finishes far sooner. SQL deletes a path's older
 * staging sets at its next swap; a Redis staging key expires this long after
 * its last part.
 */
export const STALE_STAGING_MS = 60 * 60 * 1000;

/**
 * Where a part of `bytes` that starts at `start` and holds at most `maxBytes`
 * ends: at the end of `bytes` when it is that close, otherwise `maxBytes` on,
 * backed off continuation bytes (0b10xxxxxx) so no character straddles two
 * parts. A run of continuation bytes that long, never in valid UTF-8, is cut
 * at `maxBytes`.
 */
export function utf8PartEnd(bytes: Uint8Array, start: number, maxBytes: number): number {
	const limit = start + maxBytes;
	if (limit >= bytes.byteLength) return bytes.byteLength;
	let end = limit;
	while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
	return end === start ? limit : end;
}

/**
 * Cut the UTF-8 bytes `chunks` yields into parts of at most `maxBytes`, each
 * ending on a character boundary, also where a character straddles two
 * chunks: a cut is made only once the byte after it has arrived.
 */
export async function* utf8Parts(
	chunks: AsyncIterable<Uint8Array>,
	maxBytes: number,
): AsyncGenerator<{ text: string; byteLength: number }> {
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	for await (const chunk of chunks) {
		pending.push(chunk);
		pendingBytes += chunk.byteLength;
		if (pendingBytes <= maxBytes) continue;
		const bytes = Buffer.concat(pending, pendingBytes);
		let start = 0;
		while (bytes.byteLength - start > maxBytes) {
			const end = utf8PartEnd(bytes, start, maxBytes);
			yield { text: bytes.toString("utf8", start, end), byteLength: end - start };
			start = end;
		}
		pending = [bytes.subarray(start)];
		pendingBytes = bytes.byteLength - start;
	}
	if (pendingBytes > 0)
		yield { text: Buffer.concat(pending, pendingBytes).toString("utf8"), byteLength: pendingBytes };
}
