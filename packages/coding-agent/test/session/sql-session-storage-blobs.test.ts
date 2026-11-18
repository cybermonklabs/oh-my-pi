/**
 * Under SQL session storage a blob a session references and cannot draw
 * again is kept in `<table>_blobs` as well as in the local blob store, so a
 * session resumed where that store is gone (a new machine, a new pod) gets
 * its images back. Snapcompact frames stay out of the table: their archive's
 * text draws them again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, getBlobsDir, logger, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { LEASE_BACKENDS, type LeaseDb, openLeaseDb, ROW_LEASE_BACKENDS } from "./sql-session-lease-fixture";

const ID = "01a1f400-0000-7000-8000-000000000001";
/** An image payload long enough for persistence to put it in the blob store. */
const IMAGE_BYTES = Buffer.alloc(4096, 7);
const IMAGE = IMAGE_BYTES.toString("base64");
const BLOB_REF = /blob:sha256:([0-9a-f]{64})/g;

function sha256(data: Buffer): string {
	return new Bun.SHA256().update(data).digest("hex");
}

function assistant(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
}

/** A snapcompact archive whose frames are large enough to go to the blob store. */
async function frameArchive(): Promise<snapcompact.Archive> {
	const result = await snapcompact.compact(
		{
			firstKeptEntryId: "kept",
			messagesToSummarize: [
				{ role: "user", content: `Head. ${"An archived fact. ".repeat(500)}Tail.`, timestamp: 0 },
			],
			turnPrefixMessages: [],
			tokensBefore: 1000,
			previousSummary: undefined,
			previousPreserveData: undefined,
			fileOps: snapcompact.createFileOps(),
		},
		{ model: { api: "anthropic-messages" }, frameSize: 320, maxFrames: 4 },
	);
	const archive = snapcompact.getPreservedArchive(result.preserveData);
	if (!archive) throw new Error("Expected a snapcompact archive");
	return archive;
}

/** The image block's data of the user turn `entryId`: its base64, or the reference when it did not resolve. */
function imageData(manager: SessionManager, entryId: string): string | undefined {
	const entry = manager.getEntry(entryId);
	if (entry?.type !== "message" || entry.message.role !== "user" || typeof entry.message.content === "string") {
		throw new Error(`Expected the user turn ${entryId}`);
	}
	return entry.message.content.find((block): block is ImageContent => block.type === "image")?.data;
}

/** A session with an image turn and a snapcompact compaction, written through `db`'s store and closed. */
async function writeSession(db: LeaseDb): Promise<{ sessionFile: string; sessionDir: string; userId: string }> {
	const sessionDir = db.dir.join("sessions");
	const manager = SessionManager.create(db.dir.join("project"), sessionDir, await db.open());
	const userId = manager.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "look" },
			{ type: "image", data: IMAGE, mimeType: "image/png" },
		],
		timestamp: 1,
	});
	manager.appendMessage(assistant("seen"));
	manager.appendCompaction("summary", undefined, userId, 1000, {
		preserveData: { [snapcompact.PRESERVE_KEY]: await frameArchive() },
	});
	await manager.flush();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	await manager.close();
	return { sessionFile, sessionDir, userId };
}

describe("session blobs in the SQL session storage", () => {
	const originalAgentDir = getAgentDir();
	let agentDir: TempDir | undefined;

	beforeEach(() => {
		agentDir = TempDir.createSync("@omp-sql-blobs-agent-");
		setAgentDir(agentDir.path());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		agentDir?.removeSync();
	});

	for (const { adapter, url } of LEASE_BACKENDS) {
		describe.skipIf(!url)(adapter, () => {
			it("keeps an image block's blob in the table and no frame's, and a resume without the blob store gets the image back", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir, userId } = await writeSession(db);
				const imageHash = sha256(IMAGE_BYTES);

				const rows = await db.sql(`SELECT sha256, byte_len, mime_type FROM ${db.table}_blobs`);
				expect(rows.map(row => [String(row.sha256), Number(row.byte_len), row.mime_type])).toEqual([
					[imageHash, IMAGE_BYTES.byteLength, "image/png"],
				]);
				// The frames went to the blob store too, and none of them to the table.
				const refs = new Set([...((await db.row(sessionFile))?.content ?? "").matchAll(BLOB_REF)].map(m => m[1]));
				expect(refs.has(imageHash)).toBe(true);
				expect(refs.size).toBeGreaterThan(1);

				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(resumed, userId)).toBe(IMAGE);
				expect(await Bun.file(path.join(getBlobsDir(), imageHash)).exists()).toBe(true);
				await resumed.close();

				// Control: without the row, and the blob store gone again, the image stays a reference.
				await db.sql(`DELETE FROM ${db.table}_blobs`);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const bare = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(bare, userId)).toBe(`blob:sha256:${imageHash}`);
				await bare.close();
			});

			it("restores no row whose bytes do not hash to its key", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const { sessionFile, sessionDir, userId } = await writeSession(db);
				const imageHash = sha256(IMAGE_BYTES);
				await db.sql(`UPDATE ${db.table}_blobs SET content = @1 WHERE sha256 = @2`, [
					Buffer.from("not the image"),
					imageHash,
				]);
				await fsp.rm(getBlobsDir(), { recursive: true, force: true });
				const warn = vi.spyOn(logger, "warn");

				const resumed = await SessionManager.open(sessionFile, sessionDir, await db.open());
				expect(imageData(resumed, userId)).toBe(`blob:sha256:${imageHash}`);
				expect(await Bun.file(path.join(getBlobsDir(), imageHash)).exists()).toBe(false);
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("does not hash to its key"),
					expect.objectContaining({ hash: imageHash }),
				);
				await resumed.close();
			});
		});
	}

	for (const { adapter, url } of ROW_LEASE_BACKENDS) {
		describe.skipIf(!url)(adapter, () => {
			it("writes a blob behind its session's fence: another holder's fresh lease refuses it with a warning, its holder writes it", async () => {
				await using db = await openLeaseDb(adapter, url ?? "");
				const file = path.join(db.dir.path(), "sessions", "-project-", `2026-11-18T00-00-00-000Z_${ID}.jsonl`);
				const holder = await db.open();
				expect(await holder.acquireSessionClaim?.(ID, file)).toBeFunction();
				const other = await db.open();
				const data = Buffer.from("an image of the held session");
				const hash = sha256(data);
				const warn = vi.spyOn(logger, "warn");

				other.blobTier.store(hash, data, "image/png", file);
				await other.drain();
				expect(await db.sql(`SELECT sha256 FROM ${db.table}_blobs`)).toEqual([]);
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining("Storing a session blob in the session database failed"),
					expect.objectContaining({ hash, sessionPath: file }),
				);

				holder.blobTier.store(hash, data, "image/png", file);
				await holder.drain();
				expect((await db.sql(`SELECT sha256 FROM ${db.table}_blobs`)).map(row => String(row.sha256))).toEqual([
					hash,
				]);
			});
		});
	}
});
