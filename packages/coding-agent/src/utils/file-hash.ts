/** Lowercase hex SHA-256 of a file's contents, streamed so large files are never buffered whole. */
export async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(filePath).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}

/** Lowercase hex SHA-256 of the bytes `stream` yields, and their count, hashed chunk by chunk. */
export async function digestStream(stream: AsyncIterable<Uint8Array>): Promise<{ hash: string; bytes: number }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of stream) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), bytes };
}
