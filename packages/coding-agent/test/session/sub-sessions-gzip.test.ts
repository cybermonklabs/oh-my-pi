import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { collectSubSessions } from "@oh-my-pi/pi-coding-agent/session/sub-sessions";
import { TempDir } from "@oh-my-pi/pi-utils";

/** A subagent transcript of about 2 MB: far more than one decompressed chunk. */
function transcript(): string {
	const lines = [
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "alpha",
			timestamp: "2026-01-01T00:00:00.000Z",
		}),
	];
	let parentId: string | null = null;
	for (let index = 0; index < 500; index++) {
		const id = `m${index}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: `${id} ${"y".repeat(4000)}`, timestamp: index },
			}),
		);
		parentId = id;
	}
	return `${lines.join("\n")}\n{partial\n`;
}

describe("gc-compressed subagent transcripts", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("are parsed as they decompress, with the entries and malformed count of the plain transcript", async () => {
		using dir = TempDir.createSync("@omp-subsessions-gzip-");
		const text = transcript();
		const plainRoot = path.join(dir.path(), "plain");
		const archivedRoot = path.join(dir.path(), "archived");
		await Bun.write(path.join(plainRoot, "main.jsonl"), "");
		await Bun.write(path.join(plainRoot, "main/Alpha.jsonl"), text);
		await Bun.write(path.join(archivedRoot, "main.jsonl"), "");
		await Bun.write(path.join(archivedRoot, "main/Alpha.jsonl.gz"), Bun.gzipSync(text));
		const plain = await collectSubSessions(path.join(plainRoot, "main.jsonl"));

		const parseChunk = Bun.JSONL.parseChunk;
		let longestParse = 0;
		vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation((input, ...rest) => {
			longestParse = Math.max(longestParse, typeof input === "string" ? input.length : input.byteLength);
			return parseChunk(input, ...rest);
		});
		const gunzip = vi.spyOn(Bun, "gunzipSync");
		const archived = await collectSubSessions(path.join(archivedRoot, "main.jsonl"), { includeCompressed: true });

		expect(gunzip).not.toHaveBeenCalled();
		expect(longestParse).toBeGreaterThan(0);
		expect(longestParse).toBeLessThan(Buffer.byteLength(text) / 4);
		expect(archived.Alpha?.entries).toHaveLength(500);
		expect(archived.Alpha?.entries).toEqual(plain.Alpha!.entries);
		expect(archived.Alpha?.malformedRecords).toBe(1);
		expect(archived.Alpha?.malformedRecords).toBe(plain.Alpha!.malformedRecords);
	});
});
