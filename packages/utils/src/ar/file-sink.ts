import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Write `chunks` to `destPath` in order, replacing the file: creates missing
 * parent directories and truncates an existing file before requesting the
 * first chunk. A failure after that can leave an empty or partial file. Waits
 * for each write before requesting the next chunk, so only the chunk in flight
 * is held. Closes the file even if a read or write fails, so the caller can
 * remove the partial file.
 */
export async function writeChunksToFile(destPath: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
	await fs.mkdir(path.dirname(destPath), { recursive: true });
	await using file = await fs.open(destPath, "w");
	const sink = Bun.file(file.fd).writer();
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
