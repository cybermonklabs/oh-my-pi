import { describe, expect, test } from "bun:test";
import { openArchive } from "../../src/ar/open";
import { STREAM_CHUNK_SIZE } from "../../src/ar/source";
import { writeArchive, writeTarArchive } from "../../src/ar/write";
import { TempDir } from "../../src/temp";

/** Bytes that differ at every offset of a chunk, so a misplaced chunk changes the result. */
function patterned(size: number): Uint8Array {
	return new Uint8Array(size).map((_, index) => index % 251);
}

describe("plain tar written member by member", () => {
	test("writes the bytes writeArchive writes for the same members, a file member streamed", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const payload = dir.join("payload.bin");
		await Bun.write(payload, patterned(3 * STREAM_CHUNK_SIZE + 123));
		const members = [
			["notes/readme.txt", "hello\n"],
			["payload.bin", Bun.file(payload)],
			// Past the ustar name and prefix fields: written with a PAX path record.
			[`${"deep/".repeat(60)}name.txt`, new TextEncoder().encode("long")],
			["win\\style.txt", "backslash"],
			["empty/", ""],
		] as const;
		const inMemory = dir.join("out", "in-memory.tar");
		const streamed = dir.join("out", "streamed.tar");
		await writeArchive(inMemory, "tar", members);
		await writeTarArchive(streamed, members);
		expect(Bun.file(streamed).size).toBe(Bun.file(inMemory).size);
		expect(Bun.SHA256.hash(await Bun.file(streamed).bytes(), "hex")).toBe(
			Bun.SHA256.hash(await Bun.file(inMemory).bytes(), "hex"),
		);
	});

	test("fails instead of writing a member whose stream is shorter than its size", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		/** A source that shrank after its size was taken. */
		class ShrunkBlob extends Blob {
			override get size(): number {
				return super.size + 1;
			}
		}
		await expect(writeTarArchive(dir.join("out.tar"), [["data.bin", new ShrunkBlob(["abc"])]])).rejects.toThrow(
			"Tar member 'data.bin' changed size while it was written",
		);
	});

	test("reads a member of a plain tar on disk back in chunks no larger than the stream chunk", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const bytes = patterned(2 * STREAM_CHUNK_SIZE + 77);
		const archivePath = dir.join("members.tar");
		await writeTarArchive(archivePath, [
			["first.txt", "first"],
			["data.bin", bytes],
		]);
		const archive = await openArchive({ path: archivePath, format: "tar" });
		const chunks: Uint8Array[] = [];
		for await (const chunk of archive.readFileChunks("data.bin")) chunks.push(chunk);
		expect(chunks.map(chunk => chunk.byteLength)).toEqual([STREAM_CHUNK_SIZE, STREAM_CHUNK_SIZE, 77]);
		expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
	});
});
