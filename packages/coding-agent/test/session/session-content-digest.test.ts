import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	loadSessionFile,
	sessionContentDigest,
	transcriptByteChunks,
} from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import * as piUtils from "@oh-my-pi/pi-utils";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** Uneven chunk sizes, so chunk edges fall inside lines and inside multibyte characters. */
const CHUNK_SIZES = [1, 7, 65_537, 300_001, 1_048_579];

/** File storage that counts whole-text reads. */
class CountingFileStorage extends FileSessionStorage {
	textReads = 0;

	override readText(filePath: string): Promise<string> {
		this.textReads++;
		return super.readText(filePath);
	}
}

/** In-memory storage that serves its bytes in uneven chunks and counts whole-text reads. */
class ChunkedMemoryStorage extends MemorySessionStorage {
	textReads = 0;

	override readText(filePath: string): Promise<string> {
		this.textReads++;
		return super.readText(filePath);
	}

	async *readChunks(filePath: string, fromByte = 0): AsyncGenerator<Uint8Array> {
		const bytes = new TextEncoder().encode(this.readTextSync(filePath)).subarray(fromByte);
		for (let offset = 0, turn = 0; offset < bytes.length; turn++) {
			const end = offset + CHUNK_SIZES[turn % CHUNK_SIZES.length];
			yield bytes.subarray(offset, end);
			offset = end;
		}
	}
}

const STORAGES: { name: string; create: () => SessionStorage & { textReads: number } }[] = [
	{ name: "file", create: () => new CountingFileStorage() },
	{ name: "chunked", create: () => new ChunkedMemoryStorage() },
];

const timestamp = new Date().toISOString();

/** A valid transcript of about 3 MiB whose text is mostly multibyte characters. */
function transcript(cwd: string): string {
	const lines = [JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "digest", timestamp, cwd })];
	let parentId: string | null = null;
	for (let index = 0; index < 48; index++) {
		const id = `m${index}`;
		const content = `${index} ${"é🙂".repeat(11_000)}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp,
				message: { role: "user", content, timestamp: index },
			}),
		);
		parentId = id;
	}
	return `${lines.join("\n")}\n`;
}

const APPENDED = `${JSON.stringify({
	type: "message",
	id: "late",
	parentId: "m47",
	timestamp,
	message: { role: "user", content: "appended after the load", timestamp: 48 },
})}\n`;

const tempDirs: TempDir[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function makeTempDir(): string {
	const dir = TempDir.createSync("@omp-session-digest-");
	tempDirs.push(dir);
	return dir.path();
}

beforeEach(() => {
	setAgentDir(path.join(makeTempDir(), "agent"));
});

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	__resetDirsFromEnvForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

for (const { name, create } of STORAGES) {
	describe(`sessionContentDigest on ${name} storage`, () => {
		it("hashes a multi-chunk transcript's stored bytes without reading its whole text", async () => {
			const cwd = makeTempDir();
			const file = path.join(cwd, "session.jsonl");
			const storage = create();
			const text = transcript(cwd);
			await storage.writeText(file, text);
			const chunkSizes: number[] = [];
			for await (const chunk of transcriptByteChunks(file, storage)) chunkSizes.push(chunk.byteLength);
			expect(chunkSizes.length).toBeGreaterThan(1);

			const digest = await sessionContentDigest(file, storage);

			expect(digest).toBe(new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex"));
			expect(storage.textReads).toBe(0);
		});

		it("matches the load-time digest until the transcript changes", async () => {
			const cwd = makeTempDir();
			const file = path.join(cwd, "session.jsonl");
			const storage = create();
			const text = transcript(cwd);
			await storage.writeText(file, text);

			const loaded = await loadSessionFile(file, storage, { digest: true });
			expect(await sessionContentDigest(file, storage)).toBe(loaded.sourceDigest!);

			await storage.writeText(file, `${text}${APPENDED}`);
			expect(await sessionContentDigest(file, storage)).not.toBe(loaded.sourceDigest!);
		});

		it("rejects with ENOENT once the transcript is gone, so a fail-closed resume still fails", async () => {
			const cwd = makeTempDir();
			const storage = create();

			await expect(sessionContentDigest(path.join(cwd, "missing.jsonl"), storage)).rejects.toMatchObject({
				code: "ENOENT",
			});
		});

		it("makes a fail-closed resume parse again when the transcript grew during the cwd probe", async () => {
			const cwd = makeTempDir();
			const file = path.join(cwd, "session.jsonl");
			const storage = create();
			const text = transcript(cwd);
			await storage.writeText(file, text);
			const probe = spyOn(piUtils, "directoryIsEnterable").mockImplementationOnce(async () => {
				await storage.writeText(file, `${text}${APPENDED}`);
				return true;
			});
			try {
				const manager = await SessionManager.open(file, undefined, storage, {
					throwIfMissing: true,
					suppressBreadcrumb: true,
				});
				expect(probe).toHaveBeenCalledTimes(1);
				expect(manager.getEntries().map(entry => entry.id)).toContain("late");
				await manager.close();
			} finally {
				probe.mockRestore();
			}
		});
	});
}
