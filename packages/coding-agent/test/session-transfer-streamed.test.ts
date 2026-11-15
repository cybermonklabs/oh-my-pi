import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { findSessionFiles } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	packSession,
	SESSION_ARCHIVE_VERSION,
	SESSION_TRANSFER_MESSAGE_TYPE,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { formatBytes, getBlobsDir, getConfigRootDir, setAgentDir, VERSION } from "@oh-my-pi/pi-utils";
import { ArchiveReader, encodeArchive, readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";
import type { BunFile } from "bun";
import { makeAssistantMessage } from "./session-manager/helpers";

const SESSION_ID = "streamed-session";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const JOURNAL_NAME = `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`;
/** A text or buffer longer than this means a transcript was read or parsed whole. */
const WHOLE_VALUE_LIMIT = 16 * 1024 * 1024;
const REF_PREFIX = "blob:sha256:";

function sizeOf(value: string | ArrayBufferLike | ArrayBufferView): number {
	return typeof value === "string" ? value.length : value.byteLength;
}

/**
 * Run `action` while the entry points that read a file whole, join buffers,
 * decode text, or parse JSON record the longest text or buffer each takes or
 * makes. Returns `action`'s result and the entry points that passed
 * {@link WHOLE_VALUE_LIMIT}, with their longest value.
 */
async function watchWholeValues<T>(
	action: () => Promise<T>,
): Promise<{ result: T; oversized: Record<string, number> }> {
	const longest = new Map<string, number>();
	const note = (label: string, size: number): void => {
		if (size > (longest.get(label) ?? 0)) longest.set(label, size);
	};
	const parse = JSON.parse;
	vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
		note("JSON.parse", text.length);
		return parse(text, reviver);
	});
	const parseChunk = Bun.JSONL.parseChunk;
	vi.spyOn(Bun.JSONL, "parseChunk").mockImplementation((input, start, end) => {
		note("Bun.JSONL.parseChunk", sizeOf(input));
		return parseChunk(input, start, end);
	});
	const concat = Buffer.concat;
	vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
		const joined = concat.call(Buffer, list, totalLength);
		note("Buffer.concat", joined.byteLength);
		return joined;
	});
	for (const [label, owner] of [
		["fs.promises.readFile", fs.promises],
		["fs/promises.readFile", fsp],
	] as const) {
		const readFile = owner.readFile;
		vi.spyOn(owner, "readFile").mockImplementation((async (...args: Parameters<typeof readFile>) => {
			const content = await readFile(...args);
			note(label, sizeOf(content));
			return content;
		}) as typeof readFile);
	}
	const decode = TextDecoder.prototype.decode;
	vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
		const text = decode.call(this, input, options);
		note("TextDecoder.decode", text.length);
		return text;
	});
	const fileMethods = Object.getPrototypeOf(Bun.file(import.meta.path)) as BunFile;
	const bytes = fileMethods.bytes;
	vi.spyOn(fileMethods, "bytes").mockImplementation(async function (this: BunFile) {
		const content = await bytes.call(this);
		note("BunFile.bytes", content.byteLength);
		return content;
	});
	const arrayBuffer = fileMethods.arrayBuffer;
	vi.spyOn(fileMethods, "arrayBuffer").mockImplementation(async function (this: BunFile) {
		const content = await arrayBuffer.call(this);
		note("BunFile.arrayBuffer", content.byteLength);
		return content;
	});
	const text = fileMethods.text;
	vi.spyOn(fileMethods, "text").mockImplementation(async function (this: BunFile) {
		const content = await text.call(this);
		note("BunFile.text", content.length);
		return content;
	});
	try {
		const result = await action();
		return {
			result,
			oversized: Object.fromEntries([...longest].filter(([, size]) => size > WHOLE_VALUE_LIMIT)),
		};
	} finally {
		vi.restoreAllMocks();
	}
}

async function sha256OfFile(file: string): Promise<string> {
	const digest = new Bun.SHA256();
	for await (const chunk of Bun.file(file).stream()) digest.update(chunk);
	return digest.digest("hex");
}

/** Store `bytes` in the current agent's blob store; returns its hash. */
async function storeBlob(bytes: Buffer): Promise<string> {
	return (await new BlobStore(getBlobsDir()).put(bytes)).hash;
}

function header(cwd: string): SessionHeader {
	return { type: "session", version: CURRENT_SESSION_VERSION, id: SESSION_ID, timestamp: TIMESTAMP, cwd };
}

/** A ustar header for the file member `name` declaring `size` bytes: the writer's header of an empty member, its size and checksum rewritten. */
async function tarHeaderDeclaring(name: string, size: number): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const header = (await encodeArchive("tar", [[name, ""]])).slice(0, 512);
	header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
	header.fill(0x20, 148, 156);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
	return header;
}

describe("omp session pack/unpack of a long session", () => {
	let root: string;
	let agentA: string;
	let agentB: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-transfer-streamed-"));
		agentA = path.join(root, "agent-a");
		agentB = path.join(root, "agent-b");
		cwdA = path.join(root, "laptop", "project");
		cwdB = path.join(root, "cloud", "project");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
		setAgentDir(agentA);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("packs a journal over 32 MB to the bytes the in-memory writer gives and unpacks it whole, holding no text or buffer over 16 MiB", async () => {
		const journalImage = Buffer.alloc(4096, 7);
		const artifactImage = Buffer.alloc(4096, 9);
		const journalBlob = await storeBlob(journalImage);
		const artifactBlob = await storeBlob(artifactImage);

		const source = path.join(root, "sessions", JOURNAL_NAME);
		const body = "long transcript text ".repeat(3200);
		const lines = [JSON.stringify(header(cwdA))];
		let size = lines[0].length;
		let parentId: string | null = null;
		for (let turn = 0; size <= 34 * 1024 * 1024; turn++) {
			const user = {
				type: "message",
				id: `u${turn}`,
				parentId,
				timestamp: TIMESTAMP,
				message: {
					role: "user",
					content: [
						{ type: "text", text: `${turn} ${body}` },
						...(turn % 100 === 0
							? [{ type: "image", data: `${REF_PREFIX}${journalBlob}`, mimeType: "image/png" }]
							: []),
					],
					timestamp: 1,
				},
			};
			const assistant = {
				type: "message",
				id: `a${turn}`,
				parentId: `u${turn}`,
				timestamp: TIMESTAMP,
				message: { ...makeAssistantMessage(), content: [{ type: "text", text: `${turn} ${body}` }], timestamp: 2 },
			};
			parentId = `a${turn}`;
			for (const entry of [user, assistant]) {
				const line = JSON.stringify(entry);
				lines.push(line);
				size += line.length + 1;
			}
		}
		await Bun.write(source, `${lines.join("\n")}\n`);
		lines.length = 0;
		const artifactsDir = source.slice(0, -".jsonl".length);
		const artifacts: [string, string][] = [
			[
				"0-Explore.jsonl",
				`${JSON.stringify({ type: "session", id: "sub", cwd: "/x" })}\n${JSON.stringify({ image: `${REF_PREFIX}${artifactBlob}` })}\n`,
			],
			["nested/1.bash.log", "build output"],
		];
		for (const [relative, content] of artifacts) await Bun.write(path.join(artifactsDir, relative), content);

		const archive = path.join(root, "out", "session.tar");
		const pack = await watchWholeValues(() => packSession(source, archive));
		expect(pack.oversized).toEqual({});
		expect(pack.result.missingBlobs).toEqual([]);

		// The archive the in-memory writer makes of the same members, in the same order.
		const expected = path.join(root, "expected.tar");
		const manifest = { version: SESSION_ARCHIVE_VERSION, id: SESSION_ID, cwd: cwdA, omp: VERSION };
		await writeArchive(expected, "tar", [
			["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
			["session.jsonl", await Bun.file(source).bytes()],
			...artifacts.map(([relative, content]) => [`artifacts/${relative}`, content] as const),
			...[
				[journalBlob, journalImage],
				[artifactBlob, artifactImage],
			]
				.sort(([left], [right]) => (left < right ? -1 : 1))
				.map(([hash, bytes]) => [`blobs/${hash}`, bytes] as const),
		]);
		expect(Bun.file(archive).size).toBe(Bun.file(expected).size);
		expect(await sha256OfFile(archive)).toBe(await sha256OfFile(expected));

		// The cloud machine already holds a copy of the session, so unpack also checks that it is a prefix.
		setAgentDir(agentB);
		const sessionDir = SessionManager.getDefaultSessionDir(cwdB);
		await fsp.mkdir(sessionDir, { recursive: true });
		await fsp.copyFile(source, path.join(sessionDir, JOURNAL_NAME));
		const unpack = await watchWholeValues(() => unpackSession(archive, { cwd: cwdB }));
		expect(unpack.oversized).toEqual({});
		expect(unpack.result.mode).toBe("replaced");
		expect(unpack.result.id).toBe(SESSION_ID);

		const before = await loadEntriesFromFile(source);
		const after = await loadEntriesFromFile(unpack.result.sessionFile);
		expect(after[0]).toMatchObject({ type: "session", id: SESSION_ID, cwd: path.resolve(cwdB) });
		expect(after.slice(1, -1)).toEqual(before.slice(1));
		expect(after.at(-1)).toMatchObject({ type: "custom_message", customType: SESSION_TRANSFER_MESSAGE_TYPE });

		const unpackedArtifacts = unpack.result.sessionFile.slice(0, -".jsonl".length);
		for (const [relative, content] of artifacts) {
			expect(await Bun.file(path.join(unpackedArtifacts, relative)).text()).toBe(content);
		}
		const blobs = new BlobStore(getBlobsDir());
		expect(await blobs.get(journalBlob)).toEqual(journalImage);
		expect(await blobs.get(artifactBlob)).toEqual(artifactImage);
	}, 120_000);

	it("packs a blob that a reference split by a scan chunk edge names", async () => {
		// One reference straddles every 64 KiB boundary; file stream chunks end on such boundaries.
		const boundary = 64 * 1024;
		const refLinePrefix = '{"type":"custom","customType":"ref","data":"';
		const fillerPrefix = '{"type":"custom","customType":"filler","data":"';
		const refStarts: number[] = [];
		const hashes: string[] = [];
		let journal = `${JSON.stringify(header(cwdA))}\n`;
		for (let edge = boundary; edge <= 48 * boundary; edge += boundary) {
			const hash = await storeBlob(Buffer.from(`image at ${edge}`));
			hashes.push(hash);
			const refStart = edge - 38;
			const filler = refStart - refLinePrefix.length - journal.length - fillerPrefix.length - '"}\n'.length;
			journal += `${fillerPrefix}${"x".repeat(filler)}"}\n${refLinePrefix}`;
			refStarts.push(journal.length);
			journal += `${REF_PREFIX}${hash}"}\n`;
		}
		const source = path.join(root, "sessions", JOURNAL_NAME);
		await Bun.write(source, journal);

		// The case only proves something when a chunk of the file's stream ends inside a reference.
		const refLength = REF_PREFIX.length + 64;
		let offset = 0;
		let splitRefs = 0;
		for await (const chunk of Bun.file(source).stream()) {
			offset += chunk.byteLength;
			if (refStarts.some(start => start < offset && offset < start + refLength)) splitRefs++;
		}
		expect(splitRefs).toBeGreaterThan(0);

		const archive = path.join(root, "session.tar");
		const packed = await packSession(source, archive);
		expect(packed.missingBlobs).toEqual([]);
		const members = await readArchiveEntries({ path: archive, format: "tar" });
		const packedBlobs = [...members.keys()].filter(name => name.startsWith("blobs/")).map(name => name.slice(6));
		expect(packedBlobs.sort()).toEqual(hashes.sort());
	});

	it("refuses an archive whose member headers total more than 2 GiB, before staging any member", async () => {
		// Two members under the 2 GiB member limit in a sparse file: only their headers hold bytes.
		const memberSize = Math.round(1.2 * 1024 ** 3);
		const paddedSize = Math.ceil(memberSize / 512) * 512;
		const archive = path.join(root, "huge.tar");
		const file = await fsp.open(archive, "w");
		try {
			await file.write(await tarHeaderDeclaring("manifest.json", memberSize), 0, 512, 0);
			await file.write(await tarHeaderDeclaring("session.jsonl", memberSize), 0, 512, 512 + paddedSize);
			await file.truncate(2 * (512 + paddedSize) + 1024);
		} finally {
			await file.close();
		}

		setAgentDir(agentB);
		const memberReads = vi.spyOn(ArchiveReader.prototype, "readFileChunks");
		await expect(unpackSession(archive, { cwd: cwdB })).rejects.toThrow(
			`Bad session archive ${archive}: Archive is too large to read in memory (${formatBytes(2 * memberSize)} > ${formatBytes(2 * 1024 ** 3)} limit)`,
		);
		expect(memberReads).not.toHaveBeenCalled();
		expect(await findSessionFiles(SESSION_ID)).toEqual([]);
	});
});
