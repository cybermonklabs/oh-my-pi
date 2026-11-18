/**
 * Contract: session store masking stores the same bytes for a long session whose older entries are
 * cold (their large values kept on disk and read back on access) as for the same session held
 * whole. A full write masks each held value of a cold entry, in the values the entry keeps in
 * memory and in those it reads back from its record, as it masks a whole entry, and reads none of
 * the cold entries' images back to do it; with masking off it stores them as written. A clone, a
 * persisted copy and a fork of a cold session keep both its masking binding and its cold store,
 * which serves their cold entries once the source is closed. An appended `entry_patch` record
 * stores each patch masked as a full write stores the entry it patches: a signed block whose text
 * masking changed loses its signature, and a field the entry keeps stays as written.
 * The model reads the real values: masking applies to what is stored, never to what a cold entry
 * reads back. Each case runs against file storage and SQLite SQL storage.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { getBlobsDir, isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";

const ENV_VALUE = "zq9-synthetic-service-4821";
const ENV_MARKER = "[REDACTED:env:SERVICE_API_KEY]";
/** A prefix of ENV_VALUE no marker contains: finding it in stored text means a fragment of the value survived. */
const ENV_FRAGMENT = ENV_VALUE.slice(0, 6);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const NOW = 1_700_000_000_000;
/** An image larger than a persisted line keeps inline: a session file holds it as a blob reference. */
const IMAGE = Buffer.alloc(3000, 7);
/** Each case resumes, writes in full and reads back a session of 17 entries, cold and whole. */
const CASE_TIMEOUT_MS = 60_000;

type StoredRecord = Record<string, unknown>;

const said = (value: string): string => `before ${value} after`;

/** Longer than any value a cold entry keeps in memory. */
function text(label: string): string {
	return `${label} ${"body ".repeat(900)}`;
}

/** {@link text} with `held` in it. */
function heldText(label: string, held: string): string {
	return text(`${label} ${said(held)}`);
}

function assistant(label: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: text(label) }],
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
		stopReason: "stop",
		timestamp: 2,
	};
}

/** The entries before the cut that {@link sessionText} puts the held value in. */
const HELD_IDS = ["u1", "e1", "n1", "c1"];

/**
 * A session with three compactions: `c1` keeps from `u2`, `c2` from `u3`, and `c3`, the newest,
 * from `u5` (the cut). Before the cut, `held` lies in fields a cold entry reads back from its
 * record (`u1`'s message content, beside the image `imageRef` names, `n1`'s content, `c1`'s
 * summary) and in fields it keeps in memory while small (`e1`'s `errorMessage`, a failed reply's,
 * and `n1`'s `details`).
 */
function sessionText(id: string, cwd: string, held: string, imageRef: string): string {
	const lines: object[] = [{ type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: TIMESTAMP, cwd }];
	let parentId: string | null = null;
	const add = (type: string, entryId: string, fields: object): void => {
		lines.push({ type, id: entryId, parentId, timestamp: TIMESTAMP, ...fields });
		parentId = entryId;
	};
	const user = (entryId: string, content: object[] = [{ type: "text", text: text(entryId) }]) =>
		add("message", entryId, { message: { role: "user", content, timestamp: 1 } });
	const reply = (entryId: string) => add("message", entryId, { message: assistant(entryId) });
	const compaction = (entryId: string, firstKeptEntryId: string, summary = text(entryId)) =>
		add("compaction", entryId, { summary, firstKeptEntryId, tokensBefore: 1000 });

	user("u1", [
		{ type: "text", text: heldText("u1", held) },
		{ type: "image", data: imageRef, mimeType: "image/png" },
	]);
	reply("a1");
	add("message", "e1", {
		message: { ...assistant("e1"), content: [], stopReason: "error", errorMessage: said(held) },
	});
	add("custom_message", "n1", {
		customType: "test-note",
		content: heldText("n1", held),
		display: true,
		details: { note: said(held) },
	});
	user("u2");
	reply("a2");
	compaction("c1", "u2", heldText("c1", held));
	user("u3");
	reply("a3");
	compaction("c2", "u3");
	user("u4");
	reply("a4");
	user("u5");
	reply("a5");
	compaction("c3", "u5");
	user("u6");
	reply("a6");
	const slot = serializeTitleSlot({ title: "Rotate the service key", source: "user", updatedAt: TIMESTAMP });
	return slot + lines.map(line => `${JSON.stringify(line)}\n`).join("");
}

/** What a client or the model receives. */
function wire(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** The stored entries of a session body, after its title slot and header, in file order. */
function storedRecords(stored: string): StoredRecord[] {
	return Bun.JSONL.parse(stored).filter(isRecord).slice(2);
}

/** The lines of a session body after its title slot and header. */
function entryLines(stored: string): string[] {
	return stored.split("\n").slice(2);
}

function messageOf(record: StoredRecord): StoredRecord {
	const message = record.message;
	if (!isRecord(message)) throw new Error(`Entry ${String(record.id)} holds no message`);
	return message;
}

/** What `records` hold in each field {@link sessionText} puts the held value in. */
function heldFieldsOf(records: readonly unknown[]): StoredRecord {
	const byId = new Map<unknown, StoredRecord>();
	for (const record of records) if (isRecord(record)) byId.set(record.id, record);
	const at = (id: string): StoredRecord => {
		const record = byId.get(id);
		if (!record) throw new Error(`No entry ${id}`);
		return record;
	};
	const u1Content = messageOf(at("u1")).content;
	return {
		"u1 text": Array.isArray(u1Content) && isRecord(u1Content[0]) ? u1Content[0].text : undefined,
		"e1 errorMessage": messageOf(at("e1")).errorMessage,
		"n1 content": at("n1").content,
		"n1 details": at("n1").details,
		"c1 summary": at("c1").summary,
	};
}

/** {@link heldFieldsOf} for a session holding `held` where {@link sessionText} puts the value. */
function heldFields(held: string): StoredRecord {
	return {
		"u1 text": heldText("u1", held),
		"e1 errorMessage": said(held),
		"n1 content": heldText("n1", held),
		"n1 details": { note: said(held) },
		"c1 summary": heldText("c1", held),
	};
}

/**
 * Every stored string field that holds the held value, as `<record type>#<line>.<path>`, so a
 * failure names where the value leaked without printing it.
 */
function leakedFields(stored: string): string[] {
	const leaks: string[] = [];
	const visit = (value: unknown, at: string): void => {
		if (typeof value === "string") {
			if (value.includes(ENV_VALUE)) leaks.push(at);
		} else if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${at}[${index}]`));
		} else if (isRecord(value)) {
			for (const [key, child] of Object.entries(value)) visit(child, `${at}.${key}`);
		}
	};
	Bun.JSONL.parse(stored).forEach((record, line) =>
		visit(record, `${isRecord(record) && typeof record.type === "string" ? record.type : "?"}#${line}`),
	);
	return leaks;
}

/**
 * Whether the store's text `stored` holds the held value or a fragment of it, what it holds in
 * the fields {@link sessionText} puts the value in, and whether it holds the marked text of each
 * turn of {@link compactNewTurn} labelled in `turns`.
 */
function maskedView(stored: string, turns: readonly string[]): unknown {
	return {
		leaks: leakedFields(stored),
		fragment: stored.includes(ENV_FRAGMENT),
		held: heldFieldsOf(storedRecords(stored)),
		turns: turns.map(label => stored.includes(JSON.stringify(heldText(label, ENV_MARKER)))),
	};
}

/** {@link maskedView} of a store that holds each value as its marker. */
function masked(turns: readonly string[]): unknown {
	return { leaks: [], fragment: false, held: heldFields(ENV_MARKER), turns: turns.map(() => true) };
}

/**
 * Goes on with a turn whose prompt holds the held value and a compaction that keeps only its
 * reply, then builds the context, as a session does after compacting. Returns how many more
 * entries are cold: with the cold store on, the entries the new cut leaves behind go cold.
 */
function compactNewTurn(manager: SessionManager, label: string): number {
	const before = manager.coldStoreStats().coldEntries;
	manager.appendMessage({
		role: "user",
		content: [{ type: "text", text: heldText(label, ENV_VALUE) }],
		timestamp: NOW,
	});
	const reply = manager.appendMessage(assistant(`${label} reply`));
	manager.appendCompaction(text(`${label} summary`), undefined, reply, 2000);
	manager.buildSessionContext();
	return manager.coldStoreStats().coldEntries - before;
}

function entryOf(manager: SessionManager, id: string): SessionEntry {
	const entry = manager.getEntry(id);
	if (!entry) throw new Error(`No entry ${id}`);
	return entry;
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a session file");
	return file;
}

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

interface Seeded {
	file: string;
	cwd: string;
	text: string;
}

/**
 * The record a write appended to `seeded` as written, or `undefined` unless the store holds
 * `seeded` unchanged followed by exactly one more line.
 */
function appendedRecord(seeded: Seeded, stored: string): StoredRecord | undefined {
	if (!stored.startsWith(seeded.text)) return undefined;
	const added = stored.slice(seeded.text.length);
	if (added.indexOf("\n") !== added.length - 1) return undefined;
	const record: unknown = JSON.parse(added);
	return isRecord(record) ? record : undefined;
}

/** The stored line of entry `id` in a session body. */
function lineOf(stored: string, id: string): string {
	const index = storedRecords(stored).findIndex(record => record.id === id);
	if (index < 0) throw new Error(`No stored entry ${id}`);
	return entryLines(stored)[index]!;
}

/** A reply's content as a patch sets it: a signed thinking block, and a signed text block that holds no value. */
function signedContent(thinking: string, thinkingSignature: string): AssistantMessage["content"] {
	return [
		{ type: "thinking", thinking, thinkingSignature },
		{ type: "text", text: "the reply", textSignature: "text-signature" },
	];
}

for (const backend of backends) {
	describe(`session store masking of a session whose older entries are cold, under ${backend.name}`, () => {
		let tmp: TempDir;
		let agentDir: string;
		let store: Store;
		/** {@link IMAGE} in the blob store a session reads image data from. */
		let image: { hash: string; ref: string };
		const cleanups: Array<() => Promise<void>> = [];

		beforeEach(async () => {
			tmp = TempDir.createSync("@omp-cold-entries-store-mask-");
			agentDir = tmp.join("agent");
			await fs.mkdir(agentDir, { recursive: true });
			// Only the agent dir the test binds holds the value, never this machine's environment:
			// a manager that lost its binding masks by another agent dir's sources, which hold none.
			const held = new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: ENV_VALUE }), agentDir });
			spyOn(storeMask, "processSessionStoreMasker").mockImplementation(dir =>
				dir === agentDir ? held : new storeMask.SessionStoreMasker({ env: () => ({}), agentDir: dir }),
			);
			store = await backend.open();
			image = new BlobStore(getBlobsDir()).putSync(IMAGE, { extension: "png" });
		});

		afterEach(async () => {
			for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
			await store.close();
			vi.restoreAllMocks();
			await tmp.remove();
		});

		/** The session's agent dir binding with `secrets.maskSessionStore` set to `enabled`. */
		function binding(enabled: boolean): storeMask.StoreMaskingBinding {
			return { enabled: () => enabled, agentDir };
		}

		/** Writes the session to the store under its own directory and session id. */
		async function seed(name: string): Promise<Seeded> {
			const cwd = tmp.join(name, "project");
			await fs.mkdir(cwd, { recursive: true });
			const id = crypto.randomUUID();
			const file = tmp.join(name, "sessions", `2026-01-01T00-00-00-000Z_${id}.jsonl`);
			const seeded = { file, cwd, text: sessionText(id, cwd, ENV_VALUE, image.ref) };
			await store.storage.writeText(file, seeded.text);
			await store.storage.drain();
			return seeded;
		}

		/** `seeded` resumed cold or whole, bound to `masking`, closed after the case. */
		async function resume(
			seeded: Seeded,
			coldStore: boolean,
			masking: storeMask.StoreMaskingBinding,
		): Promise<SessionManager> {
			const manager = await SessionManager.open(seeded.file, path.dirname(seeded.file), store.storage, {
				suppressBreadcrumb: true,
				coldStore,
			});
			cleanups.push(() => manager.close());
			manager.setStoreMasking(masking);
			return manager;
		}

		/**
		 * What the store holds after `seeded`, as written, is resumed cold or whole, bound to
		 * `masking` and written in full; which of the entries holding the value were cold; and
		 * what the full write did with {@link IMAGE}: read it back or stored it again.
		 */
		async function storedAfterFullWrite(
			seeded: Seeded,
			coldStore: boolean,
			masking: storeMask.StoreMaskingBinding,
		): Promise<{ coldHeld: string[]; imageIo: string[]; stored: string }> {
			await store.storage.writeText(seeded.file, seeded.text);
			await store.storage.drain();
			const manager = await SessionManager.open(seeded.file, path.dirname(seeded.file), store.storage, {
				suppressBreadcrumb: true,
				coldStore,
			});
			let coldHeld: string[];
			const imageIo: string[] = [];
			try {
				manager.setStoreMasking(masking);
				coldHeld = HELD_IDS.filter(id => isColdEntry(entryOf(manager, id)));
				const reads = spyOn(BlobStore.prototype, "getSync");
				const stores = spyOn(BlobStore.prototype, "putSync");
				try {
					await manager.rewriteEntries();
					for (const [hash] of reads.mock.calls) if (hash === image.hash) imageIo.push("read");
					for (const [data] of stores.mock.calls) if (data.equals(IMAGE)) imageIo.push("stored");
				} finally {
					reads.mockRestore();
					stores.mockRestore();
				}
			} finally {
				await manager.close();
			}
			await store.storage.drain();
			return { coldHeld, imageIo, stored: await store.read(seeded.file) };
		}

		it(
			"stores each held value of a cold entry as its marker, in the bytes the whole session stores",
			async () => {
				const seeded = await seed("session");
				const cold = await storedAfterFullWrite(seeded, true, binding(true));
				const whole = await storedAfterFullWrite(seeded, false, binding(true));

				expect(cold.coldHeld).toEqual(HELD_IDS);
				expect(whole.coldHeld).toEqual([]);
				expect(cold.imageIo).toEqual([]);
				expect(maskedView(cold.stored, [])).toEqual(masked([]));
				expect(cold.stored).toBe(whole.stored);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"stores each held value of a cold entry as written while masking is off, in the bytes the whole session stores",
			async () => {
				const seeded = await seed("session");
				const cold = await storedAfterFullWrite(seeded, true, binding(false));
				const whole = await storedAfterFullWrite(seeded, false, binding(false));

				expect(cold.coldHeld).toEqual(HELD_IDS);
				expect(cold.imageIo).toEqual([]);
				expect(heldFieldsOf(storedRecords(cold.stored))).toEqual(heldFields(ENV_VALUE));
				expect(cold.stored).toBe(whole.stored);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"keeps the masking binding and the cold store in a clone of a cold session",
			async () => {
				const masking = binding(true);
				const source = await resume(await seed("source"), true, masking);
				const clone = source.cloneCurrentSession();
				cleanups.push(() => clone.close());
				// Closed, the source releases its cold store: only the store the clone holds serves the clone's cold entries.
				await source.close();

				expect(clone.coldStoreStats().coldEntries).toBeGreaterThan(0);
				expect(clone.coldStoreStats().storeBytes).toBeGreaterThan(0);
				expect(compactNewTurn(clone, "clone")).toBeGreaterThan(0);
				await clone.rewriteEntries();
				await store.storage.drain();
				expect(maskedView(await store.read(sessionFileOf(clone)), ["clone"])).toEqual(masked(["clone"]));
				// The source's own binding: a change to its setting reaches the clone's next write.
				expect(clone.storeMasking).toBe(masking);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"keeps the masking binding and the cold store in a persisted copy of a cold session",
			async () => {
				const masking = binding(true);
				const source = await resume(await seed("source"), true, masking);
				const copy = await source.persistCopy(
					{ sessionDir: tmp.join("copies"), suppressBreadcrumb: true },
					store.storage,
				);
				cleanups.push(() => copy.close());
				// Closed, the source releases its cold store: only the store the copy holds serves the copy's cold entries.
				await source.close();
				await store.storage.drain();

				// The copy's own first write holds the cold entries it copied.
				expect(maskedView(await store.read(sessionFileOf(copy)), [])).toEqual(masked([]));
				expect(copy.coldStoreStats().coldEntries).toBeGreaterThan(0);
				expect(copy.coldStoreStats().storeBytes).toBeGreaterThan(0);
				expect(compactNewTurn(copy, "copy")).toBeGreaterThan(0);
				await copy.rewriteEntries();
				await store.storage.drain();
				expect(maskedView(await store.read(sessionFileOf(copy)), ["copy"])).toEqual(masked(["copy"]));
				expect(copy.storeMasking).toBe(masking);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"keeps the masking binding and the cold store in a fork of a session, cold or whole alike",
			async () => {
				const masking = binding(true);
				const seeded = await seed("source");
				const fork = async (coldStore: boolean) => {
					const forked = await SessionManager.forkFrom(
						seeded.file,
						seeded.cwd,
						tmp.join(coldStore ? "cold-forks" : "whole-forks"),
						store.storage,
						{ suppressBreadcrumb: true, copyArtifacts: false, coldStore, storeMasking: masking },
					);
					cleanups.push(() => forked.close());
					await store.storage.drain();
					return { forked, stored: await store.read(sessionFileOf(forked)) };
				};
				const cold = await fork(true);
				const whole = await fork(false);

				// The fork's first write: the history it copied, masked as the whole fork's.
				expect(maskedView(cold.stored, [])).toEqual(masked([]));
				expect(entryLines(cold.stored)).toEqual(entryLines(whole.stored));
				expect(cold.forked.coldStoreStats().coldEntries).toBeGreaterThan(0);
				expect(whole.forked.coldStoreStats().coldEntries).toBe(0);
				expect(compactNewTurn(cold.forked, "fork")).toBeGreaterThan(0);
				await cold.forked.rewriteEntries();
				await store.storage.drain();
				expect(maskedView(await store.read(sessionFileOf(cold.forked)), ["fork"])).toEqual(masked(["fork"]));
				expect(cold.forked.storeMasking).toBe(masking);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"stores a patch's signed block that holds a value masked and unsigned, in one appended line, as a full write stores its entry",
			async () => {
				const masking = binding(true);
				const patch = { entryId: "a1", message: { content: signedContent(said(ENV_VALUE), "thinking-signature") } };
				const seeded = await seed("appended");
				const appended = await resume(seeded, true, masking);
				await appended.patchEntries([patch]);
				await appended.close();
				await store.storage.drain();

				// The record in the shape an older binary reads: the block's text masked, and the signature
				// that text no longer matches left out; the unchanged block keeps its own.
				expect(appendedRecord(seeded, await store.read(seeded.file))?.data).toEqual({
					patches: [
						{
							entryId: "a1",
							message: {
								content: [
									{ type: "thinking", thinking: said(ENV_MARKER) },
									{ type: "text", text: "the reply", textSignature: "text-signature" },
								],
							},
						},
					],
				});

				// Loaded with the record, the entry is the one a full write of the patched session stores whole.
				const reloaded = await resume(seeded, true, masking);
				await reloaded.rewriteEntries();
				const whole = await resume(await seed("whole"), false, masking);
				await whole.patchEntries([patch]);
				await whole.rewriteEntries();
				await store.storage.drain();
				expect(lineOf(await store.read(seeded.file), "a1")).toBe(
					lineOf(await store.read(sessionFileOf(whole)), "a1"),
				);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"stores a patch whose value lies only in a field its entry keeps as written, in one appended line",
			async () => {
				const seeded = await seed("kept");
				const manager = await resume(seeded, true, binding(true));
				// A block's signature is kept unscanned, and neither block's text holds the value.
				await manager.patchEntries([
					{ entryId: "a1", message: { content: signedContent("the reasoning", `signature ${ENV_VALUE}`) } },
				]);
				await store.storage.drain();

				expect(appendedRecord(seeded, await store.read(seeded.file))).toEqual(
					wire(manager.getEntries().at(-1)) as StoredRecord,
				);
			},
			CASE_TIMEOUT_MS,
		);

		it(
			"gives the model the real values the whole session gives while the store holds markers",
			async () => {
				const masking = binding(true);
				const cold = await resume(await seed("cold"), true, masking);
				const whole = await resume(await seed("whole"), false, masking);
				for (const manager of [cold, whole]) await manager.rewriteEntries();
				await store.storage.drain();
				expect(maskedView(await store.read(sessionFileOf(cold)), [])).toEqual(masked([]));

				// Each cold entry, read back from its record, gives what the same entry gives whole.
				expect(HELD_IDS.filter(id => isColdEntry(entryOf(cold, id)))).toEqual(HELD_IDS);
				for (const id of HELD_IDS) expect(wire(entryOf(cold, id))).toEqual(wire(entryOf(whole, id)));
				expect(heldFieldsOf(wire(cold.getEntries()) as unknown[])).toEqual(heldFields(ENV_VALUE));

				// The display transcript holds the entries before the cut; the model context starts at it.
				const atLeaf = (manager: SessionManager): unknown => {
					const context = manager.buildSessionContext().messages;
					return wire({
						transcript: manager.buildSessionContext({ transcript: true }).messages,
						context,
						llm: convertToLlm(context),
					});
				};
				const coldAtLeaf = atLeaf(cold);
				expect(coldAtLeaf).toEqual(atLeaf(whole));
				expect(JSON.stringify(coldAtLeaf)).toContain(heldText("u1", ENV_VALUE));

				// On a branch before the cut, the model context holds the cold entries' values.
				const beforeCut = (manager: SessionManager): unknown => {
					manager.branch("n1");
					const context = manager.buildSessionContext().messages;
					return wire({ context, llm: convertToLlm(context) });
				};
				const coldBeforeCut = beforeCut(cold);
				expect(coldBeforeCut).toEqual(beforeCut(whole));
				const sent = JSON.stringify(coldBeforeCut);
				expect(sent).toContain(heldText("u1", ENV_VALUE));
				expect(sent).toContain(heldText("n1", ENV_VALUE));
				expect(sent.includes(ENV_MARKER)).toBe(false);
			},
			CASE_TIMEOUT_MS,
		);
	});
}
