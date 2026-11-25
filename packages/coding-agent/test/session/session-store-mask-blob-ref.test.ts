/**
 * Contract: with session store masking on, the blob reference (`blob:sha256:` and the 64-hex
 * content hash of stored bytes) of an image in free content, such as a tool result's `details`, is
 * stored as written where persistence writes one and a load resolves it (a `content` image block,
 * an `images` image), also under a `secrets.yml` rule that matches a run of hex. A full write of a
 * session whose tool result is cold (its values read back from disk, its image data as blob
 * references) stores the bytes the whole session stores, and a reload gives that result's image
 * back. A blob reference anywhere else in free content, image data that only starts like one, and
 * every other string are masked. Each session case runs against file storage and SQLite SQL storage.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { maskSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entry-mask";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getBlobsDir, isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const ENV_VALUE = "zq9-synthetic-service-4821";
const ENV_MARKER = "[REDACTED:env:SERVICE_API_KEY]";
/** A `secrets.yml` regex that matches the hash of every blob reference. */
const HEX_RUN = "[0-9a-f]{32,}";
const HEX_MARKER = "[REDACTED:secrets.yml:global#1]";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** An image larger than a persisted line keeps inline: a session file holds it as a blob reference. */
const IMAGE = Buffer.alloc(3000, 7);
/** Each case writes in full and reads back a session of 9 entries, cold and whole. */
const CASE_TIMEOUT_MS = 60_000;

type StoredRecord = Record<string, unknown>;

const said = (value: string): string => `before ${value} after`;

/** Longer than any value a cold entry keeps in memory. */
function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

/** A mask holding SERVICE_API_KEY's value and {@link HEX_RUN}, listed in `agentDir`'s secrets.yml. */
async function hexRunMask(agentDir: string, cwd: string): Promise<storeMask.SessionStoreMask> {
	await Bun.write(path.join(agentDir, "secrets.yml"), JSON.stringify([{ type: "regex", content: HEX_RUN }]));
	return new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: ENV_VALUE }), agentDir }).snapshot(cwd);
}

/** A screenshot tool's result, whose `details` (free content) holds `details`. */
function toolResult(details: StoredRecord): StoredRecord {
	return {
		role: "toolResult",
		toolCallId: "call-shot",
		toolName: "screenshot",
		content: [{ type: "text", text: text("t1") }],
		details,
		isError: false,
		timestamp: 3,
	};
}

function reply(label: string, content: unknown[] = [{ type: "text", text: text(label) }]): StoredRecord {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some(block => isRecord(block) && block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 2,
	};
}

/**
 * `u1`, a reply `a1` that calls a tool, its result `t1` ({@link toolResult}) whose `details` hold
 * the image `imageRef` names and a held value beside it, `u2 a2`, a compaction `c1` that keeps
 * from `u2` (the cut), then `u3 a3`: `t1` lies before the cut, so it goes cold.
 */
function sessionText(id: string, cwd: string, imageRef: string): string {
	const lines: object[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd }];
	let parentId: string | null = null;
	const add = (type: string, entryId: string, fields: object): void => {
		lines.push({ type, id: entryId, parentId, timestamp: TIMESTAMP, ...fields });
		parentId = entryId;
	};
	const user = (entryId: string) =>
		add("message", entryId, {
			message: { role: "user", content: [{ type: "text", text: text(entryId) }], timestamp: 1 },
		});

	user("u1");
	add("message", "a1", {
		message: reply("a1", [{ type: "toolCall", id: "call-shot", name: "screenshot", arguments: {} }]),
	});
	add("message", "t1", {
		message: toolResult({
			images: [{ type: "image", data: imageRef, mimeType: "image/png" }],
			note: said(ENV_VALUE),
		}),
	});
	user("u2");
	add("message", "a2", { message: reply("a2") });
	add("compaction", "c1", { summary: text("c1"), firstKeptEntryId: "u2", tokensBefore: 1000 });
	user("u3");
	add("message", "a3", { message: reply("a3") });
	const slot = serializeTitleSlot({ title: "Take a screenshot", source: "user", updatedAt: TIMESTAMP });
	return slot + lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

/** The `details` of the message of `entry`, as plain data. */
function detailsOf(entry: unknown): unknown {
	const message = isRecord(entry) ? entry.message : undefined;
	return isRecord(message) ? message.details : undefined;
}

function entryOf(manager: SessionManager, id: string): SessionEntry {
	const entry = manager.getEntry(id);
	if (!entry) throw new Error(`No entry ${id}`);
	return entry;
}

describe("session store masking of an image's blob reference in free content", () => {
	let tmp: TempDir;

	beforeEach(() => {
		tmp = TempDir.createSync("@omp-store-mask-blob-ref-unit-");
	});

	afterEach(async () => {
		await tmp.remove();
	});

	it("keeps an image's blob reference a hex rule matches, and masks every other blob reference and value", async () => {
		// If this regresses, a full write with a hex rule in secrets.yml stores an image's blob
		// reference with its hash replaced by a marker, and the image is broken after a resume; or
		// a value that only looks like a reference reaches the store unmasked.
		await fs.mkdir(tmp.join("agent"), { recursive: true });
		const mask = await hexRunMask(tmp.join("agent"), tmp.path());
		const ref = `blob:sha256:${"ab".repeat(32)}`;
		const image = (data: string): StoredRecord => ({ type: "image", data, mimeType: "image/png" });
		const entry = {
			type: "message",
			id: "t1",
			parentId: null,
			timestamp: TIMESTAMP,
			message: toolResult({
				// The first image's data is a blob reference; the others only start as one does.
				images: [image(ref), image(`blob:sha256:${"ef".repeat(20)}`), image(`blob:sha256:${ENV_VALUE}`)],
				content: [image(ref), image(`iVBORw0KGgo${ENV_VALUE}`)],
				// Out of an image position, where a load resolves no blob reference.
				ref,
				image: image(ref),
				digest: "cd".repeat(20),
			}),
		};

		expect(detailsOf(maskSessionEntry(entry, mask))).toEqual({
			images: [image(ref), image(`blob:sha256:${HEX_MARKER}`), image(`blob:sha256:${ENV_MARKER}`)],
			content: [image(ref), image(`iVBORw0KGgo${ENV_MARKER}`)],
			ref: `blob:sha256:${HEX_MARKER}`,
			image: image(`blob:sha256:${HEX_MARKER}`),
			digest: HEX_MARKER,
		});
	});
});

interface Store {
	storage: SessionStorage;
	/** What the backing store holds at `file`, read through a new storage over it. */
	read(file: string): Promise<string>;
	close(): Promise<void>;
}

const backends: { name: string; open(): Promise<Store> }[] = [
	{
		name: "FileSessionStorage",
		async open() {
			return {
				storage: new FileSessionStorage(),
				read: file => new FileSessionStorage().readText(file),
				close: async () => {},
			};
		},
	},
	{
		name: "SqlSessionStorage (sqlite::memory:)",
		async open() {
			const client = new SQL("sqlite::memory:");
			const storage = await SqlSessionStorage.create({ client });
			const opened: SqlSessionStorage[] = [storage];
			return {
				storage,
				async read(file) {
					const next = await SqlSessionStorage.create({ client });
					opened.push(next);
					return next.readText(file);
				},
				async close() {
					for (const each of opened) await each.drain().catch(() => {});
					await client.end();
				},
			};
		},
	},
];

for (const backend of backends) {
	describe(`session store masking of a cold tool result's image, under ${backend.name}`, () => {
		let tmp: TempDir;
		let store: Store;
		/** {@link IMAGE} in the blob store a session reads image data from. */
		let image: { hash: string; ref: string };
		let file: string;
		let seeded: string;

		beforeEach(async () => {
			tmp = TempDir.createSync("@omp-store-mask-blob-ref-");
			const agentDir = tmp.join("agent");
			const cwd = tmp.join("project");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(cwd, { recursive: true });
			const mask = await hexRunMask(agentDir, cwd);
			spyOn(SessionManager.prototype, "storeMask").mockReturnValue(mask);
			store = await backend.open();
			image = new BlobStore(getBlobsDir()).putSync(IMAGE, { extension: "png" });
			const id = crypto.randomUUID();
			file = tmp.join("sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			seeded = sessionText(id, cwd, image.ref);
		});

		afterEach(async () => {
			await store.close();
			vi.restoreAllMocks();
			await tmp.remove();
		});

		/** The session as seeded, resumed cold or whole, with its masked full write stored. */
		async function storedAfterFullWrite(coldStore: boolean): Promise<{ resultCold: boolean; stored: string }> {
			await store.storage.writeText(file, seeded);
			await store.storage.drain();
			const manager = await SessionManager.open(file, path.dirname(file), store.storage, {
				suppressBreadcrumb: true,
				coldStore,
			});
			let resultCold: boolean;
			try {
				resultCold = isColdEntry(entryOf(manager, "t1"));
				await manager.rewriteEntries();
			} finally {
				await manager.close();
			}
			await store.storage.drain();
			return { resultCold, stored: await store.read(file) };
		}

		/** `t1`'s `details` in the session the store holds, reopened as a resume opens it. */
		async function reloadedDetails(): Promise<unknown> {
			const manager = await SessionManager.open(file, path.dirname(file), store.storage, {
				suppressBreadcrumb: true,
			});
			try {
				// As a client receives it: a cold entry's fields read back from its record.
				return detailsOf(JSON.parse(JSON.stringify(entryOf(manager, "t1"))));
			} finally {
				await manager.close();
			}
		}

		it(
			"stores the blob reference of a cold tool result's image as the whole session does, and a reload resolves it",
			async () => {
				// If this regresses, a move, fork or rewrite of a long session with masking on and a hex
				// rule in secrets.yml breaks the images of its older tool results after a resume, and
				// `omp gc --blobs` can delete the blobs they named.
				const cold = await storedAfterFullWrite(true);
				const reloaded = await reloadedDetails();
				const whole = await storedAfterFullWrite(false);

				expect({
					resultCold: cold.resultCold,
					stored: detailsOf(Bun.JSONL.parse(cold.stored).find(record => isRecord(record) && record.id === "t1")),
					reloaded,
					asWhole: cold.stored === whole.stored,
				}).toEqual({
					resultCold: true,
					stored: { images: [{ type: "image", data: image.ref, mimeType: "image/png" }], note: said(ENV_MARKER) },
					reloaded: {
						images: [{ type: "image", data: IMAGE.toString("base64"), mimeType: "image/png" }],
						note: said(ENV_MARKER),
					},
					asWhole: true,
				});
				expect(whole.resultCold).toBe(false);
			},
			CASE_TIMEOUT_MS,
		);
	});
}
