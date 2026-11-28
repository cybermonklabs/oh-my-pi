import { describe, expect, test } from "bun:test";
import { writeChunksToFile } from "../../src/ar/file-sink";
import { openArchive } from "../../src/ar/open";
import { STREAM_CHUNK_SIZE } from "../../src/ar/source";
import { encodeArchive, writeArchive, writeTarArchive } from "../../src/ar/write";
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

	// If this regresses, a file that grows or shrinks while it is packed is written under a header that
	// records the size it had before: the member reads back padded with zeros or cut short, and the
	// write reports success.
	test("fails a member whose reported size changes after its header records it", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		/** A source whose first reported size is off by `drift` from its bytes, and every later one is right. */
		class DriftingBlob extends Blob {
			readonly #drift: number;
			#sized = false;

			constructor(text: string, drift: number) {
				super([text]);
				this.#drift = drift;
			}

			override get size(): number {
				if (this.#sized) return super.size;
				this.#sized = true;
				return super.size + this.#drift;
			}
		}
		const outcomes: string[] = [];
		// Shrank to three bytes after the header recorded four; grew to four after it recorded three.
		for (const blob of [new DriftingBlob("abc", 1), new DriftingBlob("abcd", -1)]) {
			outcomes.push(
				await writeTarArchive(dir.join("out.tar"), [["data.bin", blob]]).then(
					() => "written",
					(error: unknown) => String(error),
				),
			);
		}

		const refused = "ArchiveError: Tar member 'data.bin' changed size while it was written";
		expect(outcomes).toEqual([refused, refused]);
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

	test("writes the bytes encodeArchive writes into a directory it creates", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const members = [
			["notes/readme.txt", "hello\n"],
			["data.bin", patterned(STREAM_CHUNK_SIZE + 9)],
		] as const;
		// Neither parent directory exists yet: the writer creates them.
		const streamed = dir.join("missing", "parent", "streamed.tar");
		await writeTarArchive(streamed, members);
		expect(Bun.SHA256.hash(await Bun.file(streamed).bytes(), "hex")).toBe(
			Bun.SHA256.hash(await encodeArchive("tar", members), "hex"),
		);
	});

	test("streams a Blob from another realm, which is not instanceof Blob, instead of reading it whole", async () => {
		using dir = TempDir.createSync("@omp-tar-stream-");
		const bytes = patterned(2 * STREAM_CHUNK_SIZE + 5);
		const source = new Blob([bytes]);
		// A Blob made in another realm (a `node:vm` context, a polyfill) has the Blob methods but not this
		// realm's prototype. Its `stream()` works; reading it whole through `arrayBuffer()` is refused.
		const foreign = {
			size: source.size,
			type: source.type,
			stream: () => source.stream(),
			arrayBuffer: () => Promise.reject(new Error("the member was read whole through arrayBuffer()")),
		} as unknown as Blob;
		expect(foreign instanceof Blob).toBe(false);
		const streamed = dir.join("foreign.tar");
		await writeTarArchive(streamed, [["data.bin", foreign]]);
		expect(Bun.SHA256.hash(await Bun.file(streamed).bytes(), "hex")).toBe(
			Bun.SHA256.hash(await encodeArchive("tar", [["data.bin", bytes]]), "hex"),
		);
	});
});

describe("chunks written to a file", () => {
	async function* chunksOf(text: string): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(text);
	}

	test("truncates a longer existing file to exactly the chunks written", async () => {
		using dir = TempDir.createSync("@omp-chunk-file-");
		const dest = dir.join("dest.bin");
		await Bun.write(dest, "0123456789abcdef");
		await writeChunksToFile(dest, chunksOf("AB"));
		expect(await Bun.file(dest).bytes()).toEqual(new TextEncoder().encode("AB"));
	});

	test("creates the destination's missing parent directories", async () => {
		using dir = TempDir.createSync("@omp-chunk-file-");
		const dest = dir.join("missing", "parent", "dest.bin");
		await writeChunksToFile(dest, chunksOf("AB"));
		expect(await Bun.file(dest).text()).toBe("AB");
	});
});
