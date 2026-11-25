import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { heldFileSource } from "../../src/ar/source";
import { TempDir } from "../../src/temp";

const OPENED = "the archive the handle opened";

describe("ar source over a held file handle", () => {
	// If this regresses, an archive another file is renamed over while it is
	// read yields its first members from one file and the rest from the other.
	test("reads the file its handle opened, not a file renamed over its path since", async () => {
		using dir = TempDir.createSync("@omp-held-file-source-");
		const archive = dir.join("archive.bin");
		const replacement = dir.join("replacement.bin");
		await Bun.write(archive, OPENED);
		const handle = await fs.open(archive, "r");
		try {
			const source = await heldFileSource(handle);
			await Bun.write(replacement, "another file, renamed over the archive's path");
			await fs.rename(replacement, archive);

			expect(new TextDecoder().decode(await source.read(0, source.size))).toBe(OPENED);
		} finally {
			await handle.close();
		}
	});
});
