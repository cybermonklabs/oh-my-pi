/**
 * Contract: with session store masking on, a full write of a session whose tool result is cold
 * stores the blob references persistence wrote for the images of a list nested in a `content` or
 * `images` list of that result's free `details`, as a full write of the same session held whole
 * stores them, also under a `secrets.yml` rule that matches a run of hex. A reload gives both
 * images back, and under SQL session storage the session keeps its reference rows for both blobs.
 * Each case runs against file storage and SQLite SQL storage.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

/** A `secrets.yml` regex that matches the hash of every blob reference. */
const HEX_RUN = "[0-9a-f]{32,}";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** Two images larger than a persisted line keeps inline. */
const LISTED = Buffer.alloc(3000, 5).toString("base64");
const BLOCK = Buffer.alloc(3000, 6).toString("base64");
const BLOB_REF = /^blob:sha256:([0-9a-f]{64})$/;
/** Each case writes in full and reads back a session of 9 entries, cold and whole. */
const CASE_TIMEOUT_MS = 60_000;

type StoredRecord = Record<string, unknown>;

/** Longer than any value a cold entry keeps in memory. */
function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
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

/** The `details` of a tool's result: an image and an image block, each in a list inside a list. */
function resultDetails(): StoredRecord {
	return {
		images: [[{ data: LISTED, mimeType: "image/png" }]],
		content: [[{ type: "image", data: BLOCK, mimeType: "image/png" }]],
	};
}

/**
 * `u1`, a reply `a1` that calls a tool, its result `t1` whose `details` hold
 * {@link resultDetails}, `u2 a2`, a compaction `c1` that keeps from `u2` (the
 * cut), then `u3 a3`: `t1` lies before the cut, so it goes cold.
 */
function sessionText(id: string, cwd: string): string {
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
		message: reply("a1", [{ type: "toolCall", id: "call-render", name: "render", arguments: {} }]),
	});
	add("message", "t1", {
		message: {
			role: "toolResult",
			toolCallId: "call-render",
			toolName: "render",
			content: [{ type: "text", text: text("t1") }],
			details: resultDetails(),
			isError: false,
			timestamp: 3,
		},
	});
	user("u2");
	add("message", "a2", { message: reply("a2") });
	add("compaction", "c1", { summary: text("c1"), firstKeptEntryId: "u2", tokensBefore: 1000 });
	user("u3");
	add("message", "a3", { message: reply("a3") });
	return lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

/** The `details` of the message of `entry`, as plain data. */
function detailsOf(entry: unknown): unknown {
	const message = isRecord(entry) ? entry.message : undefined;
	return isRecord(message) ? message.details : undefined;
}

/** `t1`'s `details` in the stored text of a session. */
function storedDetails(stored: string): unknown {
	return detailsOf(Bun.JSONL.parse(stored).find(record => isRecord(record) && record.id === "t1"));
}

/** The first element of the first list under `key` of `details`. */
function nestedImage(details: unknown, key: string): unknown {
	const outer = isRecord(details) ? details[key] : undefined;
	const inner = Array.isArray(outer) ? outer[0] : undefined;
	return Array.isArray(inner) ? inner[0] : undefined;
}

/** The hashes of the blob references at the two images of stored `details`, sorted. */
function imageHashes(details: unknown): string[] {
	return [nestedImage(details, "images"), nestedImage(details, "content")]
		.map(image => (isRecord(image) && typeof image.data === "string" ? BLOB_REF.exec(image.data)?.[1] : undefined))
		.filter((hash): hash is string => hash !== undefined)
		.sort();
}

interface Store {
	storage: SessionStorage;
	/** The blob hashes the store references from `file`, sorted; undefined for a store that keeps no references. */
	refs(file: string): Promise<string[] | undefined>;
	close(): Promise<void>;
}

const backends: { name: string; open(): Promise<Store> }[] = [
	{
		name: "FileSessionStorage",
		async open() {
			return { storage: new FileSessionStorage(), refs: async () => undefined, close: async () => {} };
		},
	},
	{
		name: "SqlSessionStorage (sqlite::memory:)",
		async open() {
			const client = new SQL("sqlite::memory:");
			const storage = await SqlSessionStorage.create({ client });
			return {
				storage,
				async refs(file) {
					const rows = (await client.unsafe("SELECT sha256 FROM omp_session_files_refs WHERE path = ?", [
						file,
					])) as Array<{ sha256: string }>;
					return rows.map(row => row.sha256).sort();
				},
				async close() {
					await storage.drain().catch(() => {});
					await client.end();
				},
			};
		},
	},
];

for (const backend of backends) {
	describe(`session store masking of a cold tool result's nested-list images, under ${backend.name}`, () => {
		const originalAgentDir = getAgentDir();
		let tmp: TempDir;
		let store: Store;
		let mask: storeMask.SessionStoreMask;
		let file: string;

		beforeEach(async () => {
			tmp = TempDir.createSync("@omp-store-mask-cold-nested-images-");
			setAgentDir(tmp.join("home"));
			const agentDir = tmp.join("agent");
			const cwd = tmp.join("project");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(cwd, { recursive: true });
			await Bun.write(path.join(agentDir, "secrets.yml"), JSON.stringify([{ type: "regex", content: HEX_RUN }]));
			mask = new storeMask.SessionStoreMasker({ env: () => ({}), agentDir }).snapshot(cwd);
			store = await backend.open();
			const id = crypto.randomUUID();
			file = tmp.join("sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			await store.storage.writeText(file, sessionText(id, cwd));
			await store.storage.drain?.();
		});

		afterEach(async () => {
			await store.close();
			vi.restoreAllMocks();
			setAgentDir(originalAgentDir);
			await tmp.remove();
		});

		/** Open the session (cold or whole), write it in full, close it, and answer the stored text. */
		async function fullWrite(coldStore: boolean): Promise<{ resultCold: boolean; stored: string }> {
			const manager = await SessionManager.open(file, path.dirname(file), store.storage, {
				suppressBreadcrumb: true,
				coldStore,
			});
			let resultCold: boolean;
			try {
				const entry = manager.getEntry("t1");
				resultCold = entry !== undefined && isColdEntry(entry);
				await manager.rewriteEntries();
			} finally {
				await manager.close();
			}
			await store.storage.drain?.();
			return { resultCold, stored: await store.storage.readText(file) };
		}

		it(
			"stores the images of a cold tool result's nested lists as written, and a reload gives both back",
			async () => {
				// If this regresses, with masking on and a hex rule in secrets.yml, a rewrite, fork or move of a
				// long session replaces the blob hash of an image in a list inside an older tool result's `images`
				// or `content` list with a redaction marker: after a resume that image is gone, and under SQL
				// session storage `omp gc` can delete its blob because the session no longer references it.
				// Persistence externalizes both images: the stored form holds their blob references.
				const seeded = storedDetails((await fullWrite(false)).stored);
				const hashes = imageHashes(seeded);
				expect(hashes).toHaveLength(2);

				spyOn(SessionManager.prototype, "storeMask").mockReturnValue(mask);
				const cold = await fullWrite(true);
				vi.restoreAllMocks();

				const reopened = await SessionManager.open(file, path.dirname(file), store.storage, {
					suppressBreadcrumb: true,
				});
				let reloaded: unknown;
				try {
					// As a client receives it: a cold entry's fields read back from its record.
					reloaded = detailsOf(JSON.parse(JSON.stringify(reopened.getEntry("t1"))));
				} finally {
					await reopened.close();
				}
				const refs = await store.refs(file);

				expect({
					resultCold: cold.resultCold,
					stored: storedDetails(cold.stored),
					reloaded,
					refs: refs?.filter(hash => hashes.includes(hash)),
				}).toEqual({
					resultCold: true,
					stored: seeded,
					reloaded: resultDetails(),
					refs: refs === undefined ? undefined : hashes,
				});
			},
			CASE_TIMEOUT_MS,
		);
	});
}
