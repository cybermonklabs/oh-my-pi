/**
 * Write `chunks` to the file `destPath` in order, one awaited write at a time,
 * so only the chunk in flight is held. The file is not truncated and its
 * parent directory must exist. A failed read or write still releases the
 * file's descriptor before it is rethrown, so the caller can remove the
 * partial file.
 */
export async function writeChunksToFile(destPath: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
	const sink = Bun.file(destPath).writer();
	try {
		for await (const chunk of chunks) {
			const written = sink.write(chunk);
			if (typeof written !== "number") await written;
		}
	} catch (error) {
		try {
			await sink.end();
		} catch {
			// The read or write failure is the error worth reporting.
		}
		throw error;
	}
	await sink.end();
}
