/**
 * Contract: with session store masking on, every write `SessionManager` and the
 * collab guest make to a session store holds a marker in place of each held
 * secret value — entries, header, title slot, title field, draft, replica,
 * the title and recaps in history.db — while the live in-memory session keeps
 * the real values. Provider replay state is never stored half-masked: a
 * changed signed block loses its signature, a changed carrier is dropped, and
 * ciphertext, images and ids are kept byte for byte. Each session file case
 * runs against every session store backend; history.db is written for file
 * storage only. Whether a manager masks is the setting of the session it is
 * bound to, read at each write.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { cfgSecretsMaskSessionStore } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import { type BtwHistoryRecord, BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	closeSessionIndex,
	listSessionRecaps,
	lookupSessionTitle,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
import { maskSessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entry-mask";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import * as utils from "@oh-my-pi/pi-utils";
import { getConfigRootDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../collab/helpers/in-memory-relay";

const ENV_VALUE = "zq9-synthetic-service-4821";
const FILE_VALUE = "file-held-token-7310";
const ENV_MARKER = "[REDACTED:env:SERVICE_API_KEY]";
const FILE_MARKER = "[REDACTED:file:EXAMPLE_TOKEN_FILE]";
/** A prefix of ENV_VALUE no marker contains: finding it in stored text means a fragment of the value survived. */
const ENV_FRAGMENT = ENV_VALUE.slice(0, 6);
const NOW = 1_700_000_000_000;

const said = (value: string): string => `before ${value} after`;

type StoredRecord = Record<string, unknown>;

interface StoreHarness {
	storage: SessionStorage;
	sessionDir: string;
	/** A new storage over the same backing store, so reads come from what the store holds. */
	reopen(): Promise<SessionStorage>;
	close(): Promise<void>;
}

interface Backend {
	name: string;
	open(root: string): Promise<StoreHarness>;
}

function sqlBackend(name: string, connect: () => InstanceType<typeof SQL>, table?: () => string): Backend {
	return {
		name,
		async open(root) {
			const client = connect();
			const options = { client, table: table?.() };
			const storage = await SqlSessionStorage.create(options);
			const opened: SqlSessionStorage[] = [storage];
			return {
				storage,
				sessionDir: path.join(root, "sessions"),
				async reopen() {
					const next = await SqlSessionStorage.create(options);
					opened.push(next);
					return next;
				},
				async close() {
					for (const each of opened) await each.drain().catch(() => {});
					if (options.table) await client.unsafe(`DROP TABLE IF EXISTS ${options.table}`);
					await client.end();
				},
			};
		},
	};
}

const postgresDsn = process.env.OMP_TEST_POSTGRES_DSN;
const backends: Backend[] = [
	{
		name: "FileSessionStorage",
		async open(root) {
			return {
				storage: new FileSessionStorage(),
				sessionDir: path.join(root, "sessions"),
				reopen: async () => new FileSessionStorage(),
				close: async () => {},
			};
		},
	},
	sqlBackend("SqlSessionStorage (sqlite::memory:)", () => new SQL("sqlite::memory:")),
	...(postgresDsn
		? [
				sqlBackend(
					"SqlSessionStorage (Postgres)",
					() => new SQL(postgresDsn),
					() => `omp_masked_${crypto.randomUUID().replaceAll("-", "")}`,
				),
			]
		: []),
];

let tmp: TempDir;
let cwd: string;
let mask: storeMask.SessionStoreMask;

beforeEach(async () => {
	tmp = TempDir.createSync("@omp-session-store-masking-");
	cwd = tmp.join("project");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(tmp.join("agent"), { recursive: true });
	const tokenFile = tmp.join("token.txt");
	await Bun.write(tokenFile, `${FILE_VALUE}\n`);
	mask = new storeMask.SessionStoreMasker({
		env: () => ({ SERVICE_API_KEY: ENV_VALUE, EXAMPLE_TOKEN_FILE: tokenFile }),
		agentDir: tmp.join("agent"),
	}).snapshot(cwd);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await tmp.remove();
});

/** Every session manager's writes get the test's mask, as when its session's setting is on. */
function maskWrites(): void {
	spyOn(SessionManager.prototype, "storeMask").mockReturnValue(mask);
}

/**
 * Binds `manager` to `secrets.maskSessionStore` in `settings` and to the test's agent dir, as
 * `createAgentSession` binds a session's manager.
 */
function bindSetting(manager: SessionManager, settings: Settings): void {
	manager.setStoreMasking({ enabled: () => cfgSecretsMaskSessionStore.get(settings), agentDir: tmp.join("agent") });
}

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		stopReason: "stop",
		timestamp: NOW,
		...extra,
	};
}

/** Appends one entry of every kind, each with a held value in each text field. */
function appendEveryEntryKind(manager: SessionManager): void {
	manager.appendSessionInit({ systemPrompt: [said(ENV_VALUE)], task: said(FILE_VALUE), tools: ["read"] });
	const userId = manager.appendMessage({ role: "user", content: said(ENV_VALUE), timestamp: NOW });
	manager.appendMessage({ role: "developer", content: [{ type: "text", text: said(FILE_VALUE) }], timestamp: NOW });
	manager.appendMessage({
		role: "custom",
		customType: "note",
		content: said(ENV_VALUE),
		display: true,
		details: { why: said(FILE_VALUE) },
		timestamp: NOW,
	});
	manager.appendMessage(
		assistant(
			[
				{ type: "text", text: said(ENV_VALUE) },
				{ type: "thinking", thinking: said(FILE_VALUE) },
				{
					type: "toolCall",
					id: "call-a",
					name: "bash",
					arguments: { request: { argv: ["run", said(ENV_VALUE)] } },
				},
			],
			{ stopReason: "toolUse" },
		),
	);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "call-a",
		toolName: "bash",
		content: [{ type: "text", text: said(FILE_VALUE) }],
		details: { stdout: said(ENV_VALUE), nested: { lines: [said(FILE_VALUE)] } },
		isError: false,
		timestamp: NOW,
	});
	manager.appendMessage({
		role: "bashExecution",
		command: said(ENV_VALUE),
		output: said(FILE_VALUE),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: NOW,
	});
	manager.appendMessage({
		role: "pythonExecution",
		code: said(FILE_VALUE),
		output: said(ENV_VALUE),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: NOW,
	});
	manager.appendCustomMessageEntry("note", said(ENV_VALUE), true, { why: said(FILE_VALUE) });
	manager.appendCompaction(said(ENV_VALUE), said(FILE_VALUE), userId, 1000, {
		details: { files: [said(ENV_VALUE)] },
	});
	manager.branchWithSummary(userId, said(FILE_VALUE), { note: said(ENV_VALUE) });
	manager.appendCustomEntry("ext-state", { token: said(FILE_VALUE), list: [{ deep: said(ENV_VALUE) }] });
}

/** Appends provider replay state: signed and unsigned blocks, carriers, ciphertext, an image and ids, with held values. */
function appendReplayState(manager: SessionManager): void {
	manager.appendMessage(
		assistant(
			[
				{ type: "thinking", thinking: said(ENV_VALUE), thinkingSignature: "opaque-thinking-signature" },
				{ type: "thinking", thinking: said(FILE_VALUE) },
				{ type: "text", text: "nothing held here", textSignature: "opaque-text-signature" },
				{ type: "redactedThinking", data: `cipher-${ENV_VALUE}` },
				{ type: "toolCall", id: `call-${FILE_VALUE}`, name: "read", arguments: { path: "notes.txt" } },
			],
			{
				stopReason: "toolUse",
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [{ type: "message", content: [{ type: "output_text", text: said(ENV_VALUE) }] }],
				},
			},
		),
	);
	manager.appendMessage({
		role: "toolResult",
		toolCallId: `call-${FILE_VALUE}`,
		toolName: "read",
		content: [
			{ type: "text", text: "file contents" },
			{ type: "image", data: `iVBORw0KGgo${ENV_VALUE}`, mimeType: "image/png" },
		],
		isError: false,
		timestamp: NOW,
	});
	manager.appendMessage(
		assistant([{ type: "text", text: "done" }], {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [{ type: "reasoning", id: "rs_held", summary: [], encrypted_content: `enc-${ENV_VALUE}` }],
			},
		}),
	);
}

async function settle(manager: SessionManager, storage: SessionStorage): Promise<void> {
	await manager.flush();
	await storage.drain();
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a session file");
	return file;
}

/** The stored entries of a session body, after its title slot and header, in file order. */
function storedRecords(text: string): StoredRecord[] {
	return Bun.JSONL.parse(text).filter(isRecord).slice(2);
}

/**
 * Every stored string field that holds a held value, as `<record type>#<line>.<path>`, so a
 * failure names where a value leaked without printing it.
 */
function leakedFields(text: string): string[] {
	const leaks: string[] = [];
	const visit = (value: unknown, at: string): void => {
		if (typeof value === "string") {
			if (value.includes(ENV_VALUE) || value.includes(FILE_VALUE)) leaks.push(at);
		} else if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${at}[${index}]`));
		} else if (isRecord(value)) {
			for (const [key, child] of Object.entries(value)) visit(child, `${at}.${key}`);
		}
	};
	Bun.JSONL.parse(text).forEach((record, line) =>
		visit(record, `${isRecord(record) && typeof record.type === "string" ? record.type : "?"}#${line}`),
	);
	return leaks;
}

function messageOf(record: StoredRecord | undefined): StoredRecord {
	const message = record?.message;
	if (!isRecord(message)) throw new Error("Expected a stored message entry");
	return message;
}

function storedMessage(records: StoredRecord[], role: string): StoredRecord {
	return messageOf(records.find(record => isRecord(record.message) && record.message.role === role));
}

function storedOfType(records: StoredRecord[], type: string): StoredRecord {
	const found = records.find(record => record.type === type);
	if (!found) throw new Error(`No stored ${type} entry`);
	return found;
}

/** `record`'s fields among `keys` that hold a value, as a JSON line would keep them. */
function fieldsOf(record: StoredRecord, keys: readonly string[]): StoredRecord {
	return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

/**
 * The fields that link or classify records, where the session format puts them: the entry's (and
 * the header's), its message's, and the `type` and `id` of each content block of either.
 */
function structuralFieldsOf(entry: unknown): StoredRecord {
	if (!isRecord(entry)) throw new Error("Expected an entry record");
	const entryKeys = ["type", "id", "parentId", "timestamp"];
	if (entry.type === "session") entryKeys.push("cwd", "parentSession", "version");
	const message = isRecord(entry.message) ? entry.message : undefined;
	return {
		entry: fieldsOf(entry, entryKeys),
		message: message && fieldsOf(message, ["role", "timestamp", "toolCallId"]),
		// A string `content` has no blocks.
		blocks: [entry.content, message?.content].map(content =>
			Array.isArray(content) ? content.filter(isRecord).map(block => fieldsOf(block, ["type", "id"])) : undefined,
		),
	};
}

/**
 * For each tool result in file order, the id of the entry whose assistant message holds the tool
 * call with the result's `toolCallId`, or null when no earlier entry does.
 */
function toolCallPairs(entries: readonly SessionEntry[]): (string | null)[] {
	const callEntryIds = new Map<string, string>();
	const pairs: (string | null)[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") callEntryIds.set(block.id, entry.id);
			}
		} else if (message.role === "toolResult") {
			pairs.push(callEntryIds.get(message.toolCallId) ?? null);
		}
	}
	return pairs;
}

/** A title whose 256-byte slot cut, unmasked, would keep the first half of ENV_VALUE. */
function titleCutInsideValue(): { title: string; filler: string } {
	const updatedAt = new Date(NOW).toISOString();
	const half = Math.floor(ENV_VALUE.length / 2);
	for (let n = 1; n < 256; n++) {
		const filler = "t".repeat(n);
		const title = `${filler} ${ENV_VALUE} tail`;
		const slot = serializeTitleSlot({ title, source: "user", updatedAt });
		if (slot.includes(ENV_VALUE.slice(0, half)) && !slot.includes(ENV_VALUE.slice(0, half + 1))) {
			return { title, filler };
		}
	}
	throw new Error("No title length puts the slot cut inside the value");
}

for (const backend of backends) {
	describe(`session store masking with ${backend.name}`, () => {
		let store: StoreHarness;

		beforeEach(async () => {
			store = await backend.open(tmp.path());
		});

		afterEach(async () => {
			await store.close();
		});

		async function onDisk(): Promise<SessionManager> {
			const manager = SessionManager.create(cwd, store.sessionDir, store.storage);
			await manager.ensureOnDisk();
			return manager;
		}

		it("stores every entry kind's held values as markers and keeps the live entries intact", async () => {
			maskWrites();
			const manager = await onDisk();
			appendEveryEntryKind(manager);
			await manager.setSessionName(said(ENV_VALUE), "user");
			await settle(manager, store.storage);

			const text = await store.storage.readText(sessionFileOf(manager));
			expect(leakedFields(text)).toEqual([]);
			expect(text.includes(ENV_VALUE)).toBe(false);
			expect(text.includes(FILE_VALUE)).toBe(false);
			const records = storedRecords(text);
			expect(storedOfType(records, "session_init")).toMatchObject({
				systemPrompt: [said(ENV_MARKER)],
				task: said(FILE_MARKER),
			});
			expect(storedMessage(records, "user").content).toBe(said(ENV_MARKER));
			expect(storedMessage(records, "developer").content).toEqual([{ type: "text", text: said(FILE_MARKER) }]);
			expect(storedMessage(records, "custom")).toMatchObject({
				content: said(ENV_MARKER),
				details: { why: said(FILE_MARKER) },
			});
			expect(storedMessage(records, "assistant").content).toEqual([
				{ type: "text", text: said(ENV_MARKER) },
				{ type: "thinking", thinking: said(FILE_MARKER) },
				{
					type: "toolCall",
					id: "call-a",
					name: "bash",
					arguments: { request: { argv: ["run", said(ENV_MARKER)] } },
				},
			]);
			expect(storedMessage(records, "toolResult")).toMatchObject({
				toolCallId: "call-a",
				content: [{ type: "text", text: said(FILE_MARKER) }],
				details: { stdout: said(ENV_MARKER), nested: { lines: [said(FILE_MARKER)] } },
			});
			expect(storedMessage(records, "bashExecution")).toMatchObject({
				command: said(ENV_MARKER),
				output: said(FILE_MARKER),
			});
			expect(storedMessage(records, "pythonExecution")).toMatchObject({
				code: said(FILE_MARKER),
				output: said(ENV_MARKER),
			});
			expect(storedOfType(records, "custom_message")).toMatchObject({
				content: said(ENV_MARKER),
				details: { why: said(FILE_MARKER) },
			});
			expect(storedOfType(records, "compaction")).toMatchObject({
				summary: said(ENV_MARKER),
				shortSummary: said(FILE_MARKER),
				details: { files: [said(ENV_MARKER)] },
			});
			expect(storedOfType(records, "branch_summary")).toMatchObject({
				summary: said(FILE_MARKER),
				details: { note: said(ENV_MARKER) },
			});
			expect(storedOfType(records, "custom")).toMatchObject({
				data: { token: said(FILE_MARKER), list: [{ deep: said(ENV_MARKER) }] },
			});
			expect(storedOfType(records, "title_change")).toMatchObject({ title: said(ENV_MARKER) });

			// The session the user is working in still holds the real values.
			const live = manager.getEntries();
			const liveUser = live.find(entry => entry.type === "message" && entry.message.role === "user");
			expect(liveUser).toMatchObject({ message: { content: said(ENV_VALUE) } });
			const liveCustom = live.find(entry => entry.type === "custom");
			expect(liveCustom?.type === "custom" && liveCustom.data).toEqual({
				token: said(FILE_VALUE),
				list: [{ deep: said(ENV_VALUE) }],
			});
			expect(manager.getSessionName()).toBe(said(ENV_VALUE));
			await manager.close();
		});

		it("masks held values in tool and extension fields named like record identity keys", async () => {
			// `type`, `id`, `role` and `timestamp` link or classify records only at record and block level.
			// Inside tool call arguments, tool result details and custom entry data they are free text.
			maskWrites();
			const manager = await onDisk();
			manager.appendMessage(
				assistant(
					[
						{
							type: "toolCall",
							id: "call-b",
							name: "lookup",
							arguments: { id: said(ENV_VALUE), type: said(FILE_VALUE), role: said(ENV_VALUE) },
						},
					],
					{ stopReason: "toolUse" },
				),
			);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-b",
				toolName: "lookup",
				content: [{ type: "text", text: "found" }],
				details: { id: said(FILE_VALUE), timestamp: said(ENV_VALUE) },
				isError: false,
				timestamp: NOW,
			});
			manager.appendCustomEntry("ext-state", { id: said(ENV_VALUE), type: said(FILE_VALUE) });
			await settle(manager, store.storage);

			const text = await store.storage.readText(sessionFileOf(manager));
			expect(leakedFields(text)).toEqual([]);
			await manager.close();
		});

		it("keeps every structural field as written, so a reloaded session pairs each tool result with its call", async () => {
			// Held values sit in text, tool calls, tool results, custom data, a compaction and a branch
			// summary, and in a tool call's `id` and the `toolCallId` of the result that answers it.
			maskWrites();
			const manager = await onDisk();
			appendEveryEntryKind(manager);
			appendReplayState(manager);
			await settle(manager, store.storage);
			const file = sessionFileOf(manager);

			const text = await store.storage.readText(file);
			// Masking ran on this session, so the comparison below is against masked records.
			expect(text).toContain(said(ENV_MARKER));
			// The header and every entry, after the title slot, as the store holds them.
			const stored = Bun.JSONL.parse(text).filter(isRecord).slice(1);
			const live = [manager.getHeader(), ...manager.getEntries()];
			expect(stored.map(structuralFieldsOf)).toEqual(live.map(structuralFieldsOf));
			const livePairs = toolCallPairs(manager.getEntries());
			expect(livePairs).not.toContain(null);
			await manager.close();

			const reopenedStorage = await store.reopen();
			const reopened = await SessionManager.open(file, store.sessionDir, reopenedStorage);
			expect(toolCallPairs(reopened.getEntries())).toEqual(livePairs);
			await reopened.close();
		});

		it("drops a changed block's signature and changed replay carriers, keeping ciphertext, images and ids", async () => {
			maskWrites();
			const manager = await onDisk();
			appendReplayState(manager);
			await settle(manager, store.storage);

			const records = storedRecords(await store.storage.readText(sessionFileOf(manager)));
			const [first, toolResult, second] = records.filter(record => record.type === "message").map(messageOf);
			expect(first.content).toEqual([
				// Signed and changed: stored unsigned, so no provider replays a signature over altered text.
				{ type: "thinking", thinking: said(ENV_MARKER) },
				// Unsigned: the same shape, masked.
				{ type: "thinking", thinking: said(FILE_MARKER) },
				// Signed and unchanged: the signature stays, so replay still validates.
				{ type: "text", text: "nothing held here", textSignature: "opaque-text-signature" },
				{ type: "redactedThinking", data: `cipher-${ENV_VALUE}` },
				{ type: "toolCall", id: `call-${FILE_VALUE}`, name: "read", arguments: { path: "notes.txt" } },
			]);
			expect(Object.hasOwn(first, "providerPayload")).toBe(false);
			expect(toolResult).toMatchObject({ toolCallId: `call-${FILE_VALUE}` });
			expect(toolResult.content).toEqual([
				{ type: "text", text: "file contents" },
				{ type: "image", data: `iVBORw0KGgo${ENV_VALUE}`, mimeType: "image/png" },
			]);
			expect(second.providerPayload).toEqual({
				type: "openaiResponsesHistory",
				items: [{ type: "reasoning", id: "rs_held", summary: [], encrypted_content: `enc-${ENV_VALUE}` }],
			});
			const liveIds = manager.getEntries().map(entry => [entry.id, entry.parentId]);
			expect(records.map(record => [record.id, record.parentId])).toEqual(liveIds);
			await manager.close();
		});

		it("keeps the 256-byte title slot whole and masks the stored title on the append and rewrite paths", async () => {
			maskWrites();
			const manager = await onDisk();
			appendEveryEntryKind(manager);
			await settle(manager, store.storage);
			const { title, filler } = titleCutInsideValue();
			const file = sessionFileOf(manager);

			const expectMaskedSlot = (text: string): void => {
				const slot = text.slice(0, text.indexOf("\n"));
				expect(Buffer.byteLength(`${slot}\n`, "utf8")).toBe(256);
				expect(slot.includes(ENV_FRAGMENT)).toBe(false);
				expect(JSON.parse(slot)).toMatchObject({
					title: expect.stringMatching(new RegExp(`^${filler} \\[REDACTED:`)),
				});
				expect(text.includes(ENV_VALUE)).toBe(false);
			};

			await manager.setSessionName(title, "user");
			await settle(manager, store.storage);
			expectMaskedSlot(await store.storage.readText(file));
			// A fresh storage reads the title the store kept (the SQL title column), not this process's index.
			expectMaskedSlot(await (await store.reopen()).readText(file));

			await manager.rewriteEntries();
			await settle(manager, store.storage);
			expectMaskedSlot(await store.storage.readText(file));
			expectMaskedSlot(await (await store.reopen()).readText(file));
			await manager.close();
		});

		it("stores the draft masked", async () => {
			maskWrites();
			const manager = await onDisk();
			await manager.saveDraft(said(ENV_VALUE));
			expect(await manager.consumeDraft()).toBe(said(ENV_MARKER));
			await manager.close();
		});

		it("masks a value that straddles the 500,000-character persistence cut", async () => {
			// Persistence cuts a string longer than 500,000 characters to 500,000 including its notice;
			// the value starts just before that point.
			const content = `${"a".repeat(499_945)}${ENV_VALUE}${"b".repeat(100)}`;

			const unmasked = await onDisk();
			unmasked.appendMessage({ role: "user", content, timestamp: NOW });
			await settle(unmasked, store.storage);
			const unmaskedText = await store.storage.readText(sessionFileOf(unmasked));
			await unmasked.close();
			// The fixture really crosses the cut: unmasked, a fragment survives and the whole value does not.
			expect(unmaskedText.includes(ENV_FRAGMENT)).toBe(true);
			expect(unmaskedText.includes(ENV_VALUE)).toBe(false);

			maskWrites();
			const masked = await onDisk();
			masked.appendMessage({ role: "user", content, timestamp: NOW });
			await settle(masked, store.storage);
			const maskedText = await store.storage.readText(sessionFileOf(masked));
			expect(maskedText.includes(ENV_FRAGMENT)).toBe(false);
			await masked.close();
		});

		it("gives byte-identical stored text after append, forced rewrite and reload", async () => {
			maskWrites();
			const manager = await onDisk();
			appendEveryEntryKind(manager);
			appendReplayState(manager);
			await settle(manager, store.storage);
			const file = sessionFileOf(manager);
			const appended = await store.storage.readText(file);

			await expect(manager.rewriteEntries()).resolves.toBeUndefined();
			await settle(manager, store.storage);
			expect(await store.storage.readText(file)).toBe(appended);
			await manager.close();

			const reopenedStorage = await store.reopen();
			const reopened = await SessionManager.open(file, store.sessionDir, reopenedStorage);
			await expect(reopened.rewriteEntries()).resolves.toBeUndefined();
			await settle(reopened, reopenedStorage);
			expect(await reopenedStorage.readText(file)).toBe(appended);
			await reopened.close();
		});

		it("stores values as written while the session's setting is off", async () => {
			const manager = await onDisk();
			bindSetting(manager, Settings.isolated({ "secrets.maskSessionStore": false }));
			manager.appendMessage({ role: "user", content: said(ENV_VALUE), timestamp: NOW });
			await settle(manager, store.storage);
			expect((await store.storage.readText(sessionFileOf(manager))).includes(ENV_VALUE)).toBe(true);
			await manager.close();
		});
	});
}

describe("session store masking of the history.db title and recaps", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(() => {
		// Under the test runner, history.db opens only in an agent dir the test chose.
		setAgentDir(tmp.join("agent"));
		closeSessionIndex();
	});

	afterEach(() => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
	});

	/** history.db is written only for file-backed sessions. */
	async function fileSession(): Promise<SessionManager> {
		const manager = SessionManager.create(cwd, tmp.join("sessions"), new FileSessionStorage());
		await manager.ensureOnDisk();
		return manager;
	}

	it("records the title and the recap with markers", async () => {
		maskWrites();
		const manager = await fileSession();
		await manager.setSessionName(said(ENV_VALUE), "user");
		manager.recordRecap(said(FILE_VALUE));

		const id = manager.getSessionId();
		expect(lookupSessionTitle(id)).toBe(said(ENV_MARKER));
		expect(listSessionRecaps({ sessionIds: [id] }).map(entry => entry.recap)).toEqual([said(FILE_MARKER)]);
		expect(manager.getSessionName()).toBe(said(ENV_VALUE));
		await manager.close();
	});

	it("records the title and the recap as written while the session's setting is off", async () => {
		const manager = await fileSession();
		bindSetting(manager, Settings.isolated({ "secrets.maskSessionStore": false }));
		await manager.setSessionName(said(ENV_VALUE), "user");
		manager.recordRecap(said(FILE_VALUE));

		const id = manager.getSessionId();
		expect(lookupSessionTitle(id)).toBe(said(ENV_VALUE));
		expect(listSessionRecaps({ sessionIds: [id] }).map(entry => entry.recap)).toEqual([said(FILE_VALUE)]);
		await manager.close();
	});
});

describe("session store masking by the setting each manager is bound to", () => {
	/** The content of each stored message of `manager`'s session, in file order. */
	async function storedContents(manager: SessionManager, storage: SessionStorage): Promise<unknown[]> {
		return storedRecords(await storage.readText(sessionFileOf(manager))).map(record => messageOf(record).content);
	}

	it("masks the writes of a manager bound to the setting on and not those of one bound to it off", async () => {
		// The process masker reads only the test's variable, never this machine's environment.
		spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
			new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: ENV_VALUE }), agentDir: tmp.join("agent") }),
		);
		const storage = new FileSessionStorage();
		const on = SessionManager.create(cwd, tmp.join("sessions"), storage);
		bindSetting(on, Settings.isolated({ "secrets.maskSessionStore": true }));
		const off = SessionManager.create(cwd, tmp.join("sessions"), storage);
		bindSetting(off, Settings.isolated({ "secrets.maskSessionStore": false }));
		for (const manager of [on, off]) {
			await manager.ensureOnDisk();
			manager.appendMessage({ role: "user", content: said(ENV_VALUE), timestamp: NOW });
			await settle(manager, storage);
		}

		expect(await storedContents(on, storage)).toEqual([said(ENV_MARKER)]);
		expect(await storedContents(off, storage)).toEqual([said(ENV_VALUE)]);
		await on.close();
		await off.close();
	});

	it("builds no masker and reads no _FILE path on a write while the setting is off, and does both once it is on", async () => {
		const tokenFile = tmp.join("token.txt");
		// The process masker reads only the test's file, never this machine's environment.
		const build = spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
			new storeMask.SessionStoreMasker({
				env: () => ({ EXAMPLE_TOKEN_FILE: tokenFile }),
				agentDir: tmp.join("agent"),
			}),
		);
		const stat = spyOn(fsSync, "statSync");
		const open = spyOn(fsSync, "openSync");
		const storage = new FileSessionStorage();
		const settings = Settings.isolated({ "secrets.maskSessionStore": false });
		const manager = SessionManager.create(cwd, tmp.join("sessions"), storage);
		bindSetting(manager, settings);
		await manager.ensureOnDisk();

		manager.appendMessage({ role: "user", content: said(FILE_VALUE), timestamp: NOW });
		await settle(manager, storage);
		expect(build).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalledWith(tokenFile, expect.anything());
		expect(open).not.toHaveBeenCalledWith(tokenFile, expect.anything());

		// Turned on mid-session: the same manager's next write builds the masker, reads the file and masks.
		cfgSecretsMaskSessionStore.override(settings, true);
		manager.appendMessage({ role: "user", content: said(FILE_VALUE), timestamp: NOW });
		await settle(manager, storage);
		expect(build).toHaveBeenCalled();
		expect(stat).toHaveBeenCalledWith(tokenFile, expect.anything());
		expect(open).toHaveBeenCalledWith(tokenFile, expect.anything());
		expect(await storedContents(manager, storage)).toEqual([said(FILE_VALUE), said(FILE_MARKER)]);
		await manager.close();
	});

	it("masks nothing for a manager no session bound while there are no global settings, and follows them once there are", async () => {
		resetSettingsForTest();
		// The process masker reads only the test's variable, never this machine's environment.
		const build = spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
			new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: ENV_VALUE }), agentDir: tmp.join("agent") }),
		);
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(cwd, tmp.join("sessions"), storage);
		await manager.ensureOnDisk();

		manager.appendMessage({ role: "user", content: said(ENV_VALUE), timestamp: NOW });
		await settle(manager, storage);
		expect(build).not.toHaveBeenCalled();

		try {
			await Settings.init({
				inMemory: true,
				cwd,
				agentDir: tmp.join("agent"),
				overrides: { "secrets.maskSessionStore": true },
			});
			manager.appendMessage({ role: "user", content: said(ENV_VALUE), timestamp: NOW });
			await settle(manager, storage);
		} finally {
			resetSettingsForTest();
		}
		expect(await storedContents(manager, storage)).toEqual([said(ENV_VALUE), said(ENV_MARKER)]);
		await manager.close();
	});
});

function hostContext(manager: SessionManager): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: manager,
		session: {
			isStreaming: false,
			isAborting: false,
			queuedMessageCount: 0,
			sessionName: "host session",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

function guestContext(switchSession: (replicaPath: string) => Promise<boolean>): InteractiveModeContext {
	const ctx = {
		// The guest's own session has the setting on.
		settings: Settings.isolated({ "secrets.maskSessionStore": true }),
		sessionManager: {
			getSessionFile: () => null,
			getSessionName: () => undefined,
			getCwd: () => cwd,
		},
		session: {
			switchSession,
			newSession: () => Promise.resolve(),
			messages: [],
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
		},
		statusContainer: { clear: () => {} },
		pendingShellContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		eventController: {
			handleEvent: () => Promise.resolve(),
			takeDisplaceableComponents: () => [],
			resetTranscriptAnchors: () => {},
		},
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
			markActivityEnd: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {}, disposeChildren: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		syncRunningSubagentBadge: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
		// Newer releases set the guest through this method rather than the field.
		setCollabGuest: (guest: InteractiveModeContext["collabGuest"]) => {
			Object.assign(ctx, { collabGuest: guest });
		},
	} as unknown as InteractiveModeContext;
	return ctx;
}

describe("session store masking of the collab replica", () => {
	it("writes the guest's replica of the host transcript with markers", async () => {
		// The guest writes its replica under the config root; keep it in the test's temp dir.
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp.path());
		// The process masker holds the test's variable and file, never this machine's environment.
		spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
			new storeMask.SessionStoreMasker({
				env: () => ({ SERVICE_API_KEY: ENV_VALUE, EXAMPLE_TOKEN_FILE: tmp.join("token.txt") }),
				agentDir: tmp.join("agent"),
			}),
		);
		const hostManager = SessionManager.inMemory(cwd);
		hostManager.appendMessage({ role: "user", content: said(ENV_VALUE), timestamp: NOW });
		hostManager.appendCustomMessageEntry("note", said(FILE_VALUE), true, { why: said(FILE_VALUE) });

		let replica: string | undefined;
		installInMemoryRelay();
		const host = new CollabHost(hostContext(hostManager));
		const guest = new CollabGuestLink(
			guestContext(async replicaPath => {
				replica = await new FileSessionStorage().readText(replicaPath);
				return true;
			}),
		);
		try {
			await host.start("ws://localhost:8788");
			await guest.join(host.link);
		} finally {
			await guest.leave("test done").catch(() => {});
			await host.stop("test done");
			uninstallInMemoryRelay();
		}

		if (replica === undefined) throw new Error("The guest never activated its replica");
		expect(replica.includes(ENV_VALUE)).toBe(false);
		expect(replica.includes(FILE_VALUE)).toBe(false);
		const records = Bun.JSONL.parse(replica).filter(isRecord);
		expect(storedMessage(records, "user").content).toBe(said(ENV_MARKER));
		expect(storedOfType(records, "custom_message")).toMatchObject({
			content: said(FILE_MARKER),
			details: { why: said(FILE_MARKER) },
		});
		// The host's live session is untouched.
		const hostUser = hostManager.getEntries().find(entry => entry.type === "message");
		expect(hostUser).toMatchObject({ message: { content: said(ENV_VALUE) } });
	});
});

// The keep rules: a string is stored as written only in a position the masker's table names for
// it. In position, each kept field stays byte-identical under a secrets.yml regex that matches it;
// out of position, the same name and shape holding a held value is stored as its marker.

/** A field below a record: dot-separated keys and array indexes. */
type FieldPath = string;

function valueAt(root: unknown, field: FieldPath): unknown {
	let value = root;
	for (const part of field === "" ? [] : field.split(".")) {
		value = Array.isArray(value) ? value[Number(part)] : isRecord(value) ? value[part] : undefined;
	}
	return value;
}

function joinPath(base: FieldPath, field: FieldPath): FieldPath {
	return base === "" ? field : field === "" ? base : `${base}.${field}`;
}

/** What a field a row masks holds, and what the store holds in its place. */
const HELD = said(ENV_VALUE);
const HELD_MARKER = said(ENV_MARKER);
/** The marker of the one regex in the agent dir's secrets.yml of a keep-rule case. */
const REGEX_MARKER = "[REDACTED:secrets.yml:global#1]";
const KEEP_TIMESTAMP = "2026-11-15T08:00:00.000Z";
const ROOT_ENTRY_ID = "keep-root-0001";

/** A blob reference in the form persistence writes, to a blob no store holds. */
const blobRef = (pair: string): string => `blob:sha256:${pair.repeat(32)}`;

function messageEntry(message: StoredRecord): StoredRecord {
	return { type: "message", message };
}

/** An assistant message written as a plain object, so it can carry fields a newer format has. */
function assistantRecord(content: unknown[], fields: StoredRecord = {}): StoredRecord {
	return { ...assistant([]), content, ...fields };
}

/** A mask holding SERVICE_API_KEY's value and one regex, listed in `agentDir`'s secrets.yml. */
async function regexMask(agentDir: string, maskCwd: string, source: string): Promise<storeMask.SessionStoreMask> {
	await Bun.write(path.join(agentDir, "secrets.yml"), JSON.stringify([{ type: "regex", content: source }]));
	return new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: ENV_VALUE }), agentDir }).snapshot(maskCwd);
}

const KEEP_HEADER: StoredRecord = {
	type: "session",
	version: 3,
	id: "keep-session-0001",
	title: HELD,
	titleSource: "user",
	timestamp: "2026-11-15T07:00:00.000Z",
	cwd: "/srv/keep-project",
	additionalDirectories: ["/srv/keep-extra"],
	parentSession: "keep-parent-session",
	continuationOf: "keep-continued-session",
	previousSessionFiles: ["/srv/keep-moved/session.jsonl"],
	seanceSource: "/srv/keep-seance/session.jsonl",
	providerPromptCacheKey: "keep-cache-key",
	taskPromptCacheKey: "keep-job-cache-key",
};
const ROOT_ENTRY: StoredRecord = { type: "custom", customType: "plain-root", id: ROOT_ENTRY_ID, parentId: null };
const RUNTIME_ENTRY: StoredRecord = {
	type: "custom",
	id: "keep-entry-0001",
	parentId: ROOT_ENTRY_ID,
	timestamp: "2026-11-15T08:00:01.000Z",
	activeLeafId: ROOT_ENTRY_ID,
	runtime: {
		version: "14.2.0",
		commit: "keep-commit-0001",
		branch: "keep-branch",
		diff: "keep-diff-0001",
		label: HELD,
	},
	customType: "plain-runtime",
};
const MODEL_USAGE_ENTRY: StoredRecord = {
	type: "model_usage",
	purpose: "keep-purpose",
	role: "keep-usage-role",
	api: "keep-usage-api",
	provider: "keep-usage-provider",
	model: "keep-usage-model",
	usage: assistant([]).usage,
	stopReason: "keep-usage-stop",
	errorMessage: HELD,
};
const SERVICE_TIER_ENTRY: StoredRecord = {
	type: "service_tier_change",
	serviceTier: { openai: "priority", anthropic: "flex", google: "scale" },
};
/** A scalar tier, as written before tiers per provider family: KR3 keeps only the three family keys. */
const LEGACY_SERVICE_TIER_ENTRY: StoredRecord = { type: "service_tier_change", serviceTier: HELD };
const REMOTE_COMPACTION_SLOT: StoredRecord = {
	provider: "keep-remote-provider",
	replacementHistory: [{ type: "message", role: "user", content: [{ type: "input_text", text: "plain words" }] }],
	compactionItem: { type: "compaction", id: "keep-remote-item", encrypted_content: "keep-remote-cipher" },
};
const ANTHROPIC_COMPACTION_SLOT: StoredRecord = {
	provider: "keep-compaction-provider",
	model: "keep-compaction-model",
	content: "plain summary text",
	signature: "keep-compaction-signature",
	encryptedContent: "keep-compaction-cipher",
	toolChanges: [
		{
			type: "tool_addition",
			tool: { type: "tool_reference", name: "keep-added-tool" },
			opaque: { state: "keep-added-opaque", steps: ["keep-added-step"] },
		},
	],
	filesText: "plain files",
	retainedFiles: [{ text: "plain retained", after: 1 }],
	usedTokens: 1,
};
const SNAPCOMPACT_SLOT: StoredRecord = {
	frames: [
		{
			data: blobRef("a1"),
			mimeType: "image/png",
			cols: 1,
			rows: 1,
			chars: 1,
			font: "keep-font",
			variant: "keep-variant",
			detail: "original",
		},
	],
	totalChars: 1,
	truncatedChars: 0,
	text: "plain archive",
	textHead: "plain head",
	textTail: "plain tail",
	withoutThinking: {
		summary: "plain summary",
		archive: {
			frames: [
				{
					data: "iVBORw0KGgoKeepFrame",
					mimeType: "image/png",
					cols: 1,
					rows: 1,
					chars: 1,
					font: "keep-inner-font",
					variant: "keep-inner-variant",
					detail: "original",
				},
			],
			totalChars: 1,
			truncatedChars: 0,
			text: "plain inner archive",
		},
	},
};
const COMPACTION_ENTRY: StoredRecord = {
	type: "compaction",
	summary: HELD,
	shortSummary: HELD,
	firstKeptEntryId: "keep-first-kept",
	tokensBefore: 10,
	method: "keep-method",
	providerReplayThroughEntryId: "keep-replay-through",
	warning: HELD,
	preserveData: {
		openaiRemoteCompaction: REMOTE_COMPACTION_SLOT,
		anthropicCompaction: ANTHROPIC_COMPACTION_SLOT,
		snapcompact: SNAPCOMPACT_SLOT,
	},
};
const V2_COMPACTION_ENTRY: StoredRecord = {
	type: "compaction",
	summary: "plain",
	firstKeptEntryId: ROOT_ENTRY_ID,
	tokensBefore: 1,
	preserveData: {
		openaiRemoteCompaction: {
			version: "v2",
			provider: "keep-v2-provider",
			replacementHistory: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_image", image_url: blobRef("b2"), detail: "original" }],
				},
				{ type: "compaction", id: "keep-v2-item", encrypted_content: "keep-v2-cipher" },
			],
			usedTokens: 1,
			retainedImageCount: 1,
		},
	},
};
const BRANCH_SUMMARY_ENTRY: StoredRecord = { type: "branch_summary", fromId: "keep-branch-from", summary: HELD };
const CUSTOM_ENTRY: StoredRecord = { type: "custom", customType: "keep-custom-type", data: { note: "plain" } };
const CUSTOM_MESSAGE_ENTRY: StoredRecord = {
	type: "custom_message",
	customType: "keep-custom-message-type",
	content: HELD,
	display: true,
	attribution: "agent",
	tag: "keep-message-tag",
};
const CUSTOM_MESSAGE_BLOCKS_ENTRY: StoredRecord = {
	type: "custom_message",
	customType: "plain-blocks",
	content: [{ type: "text", text: HELD }],
	display: true,
};
const SESSION_INIT_ENTRY: StoredRecord = {
	type: "session_init",
	systemPrompt: [HELD],
	task: HELD,
	tools: ["keep-tool-read"],
	mountedTools: ["keep-tool-mounted"],
	agent: "keep-agent",
	modelRole: "keep-agent-role",
	resolvedModel: "keep-resolved-model",
	perCallModel: true,
	perCallModelIdentity: "keep-call-identity",
	perCallThinkingLevel: "keep-call-level",
	retryFallback: { primary: "keep-primary", chain: ["keep-fallback"] },
	outputSchema: { type: "object" },
	outputSchemaMode: "keep-schema-mode",
	spawns: "keep-spawns",
	advisor: "keep-advisor",
	workPoolYieldItems: [{ id: HELD, index: 0 }],
};
const USER_MESSAGE: StoredRecord = messageEntry({
	role: "user",
	content: HELD,
	attribution: "user",
	tag: "keep-user-tag",
	parentIrc: { from: HELD, body: HELD },
	timestamp: NOW,
});
const DEVELOPER_MESSAGE: StoredRecord = messageEntry({
	role: "developer",
	content: HELD,
	attribution: "agent",
	providerPayload: {
		type: "anthropicMessage",
		clearAt: "keep-clear-at",
		effort: "keep-effort",
		toolChanges: [{ type: "tool_removal", name: "keep-removed-tool" }],
	},
	timestamp: NOW,
});
const ASSISTANT_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([{ type: "text", text: HELD }], {
		api: "keep-api",
		provider: "keep-provider",
		model: "keep-model",
		responseId: "keep-response",
		upstreamProvider: "keep-upstream-provider",
		upstreamModel: "keep-upstream-model",
		serviceTier: "keep-tier",
		stopReason: "keep-stop-reason",
		stopDetails: { type: "keep-stop-type", category: "keep-stop-category", explanation: HELD },
		retryRecovery: {
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recoveredAt: "keep-recovered-at",
			recovery: "keep-recovery",
			note: HELD,
			supersededBy: {
				timestamp: NOW,
				responseId: "keep-superseding-response",
				provider: "keep-superseding-provider",
				model: "keep-superseding-model",
			},
		},
		disabledFeatures: ["keep-feature"],
		inputTransformations: [
			{ type: "keep-transform", path: "keep-transform-path", reason: "keep-transform-reason", note: HELD },
		],
		requestControls: {
			messageIndex: 0,
			tools: { declared: ["keep-declared"], deferred: ["keep-deferred"], active: ["keep-active"] },
			effort: { topLevel: "keep-top-effort", tail: "keep-tail-effort" },
		},
		errorMessage: HELD,
		errorDisplayMessage: HELD,
		errorClassificationMessage: HELD,
		toolCallAbortMessages: { "plain-call": HELD },
	}),
);
const TOOL_RESULT_MESSAGE: StoredRecord = messageEntry({
	role: "toolResult",
	toolCallId: "keep-tool-call",
	toolName: "keep-tool-name",
	content: [
		{ type: "text", text: HELD },
		{
			type: "image",
			data: "iVBORw0KGgoKeepImage",
			mimeType: "image/png",
			detail: "original",
			providerFile: { provider: "openai", id: "keep-provider-file", uri: "keep-provider-uri", expiresAt: 1 },
			url: "https://example.invalid/keep-image.png",
		},
	],
	details: { note: "plain" },
	isError: false,
	attribution: "agent",
	providerMetadata: {
		type: "computer",
		screenshot: { type: "computer_screenshot", file_id: "keep-screenshot-file", image_url: blobRef("c3") },
		acknowledgedSafetyChecks: [{ id: "keep-ack-check", code: "keep-ack-code", message: HELD }],
	},
	timestamp: NOW,
});
const CUSTOM_ROLE_MESSAGE: StoredRecord = messageEntry({
	role: "custom",
	customType: "keep-custom-role",
	content: HELD,
	display: true,
	attribution: "agent",
	tag: "keep-custom-tag",
	timestamp: NOW,
});
const HOOK_MESSAGE: StoredRecord = messageEntry({
	role: "hookMessage",
	customType: "keep-hook-type",
	content: HELD,
	display: true,
	attribution: "user",
	tag: "keep-hook-tag",
	timestamp: NOW,
});
const BRANCH_SUMMARY_MESSAGE: StoredRecord = messageEntry({
	role: "branchSummary",
	summary: HELD,
	fromId: "keep-summary-from",
	timestamp: NOW,
});
/** An image outside a content array (KR7), with every field KR5's image row keeps. */
function keptImage(data: string, name: string): StoredRecord {
	return {
		type: "image",
		data,
		mimeType: "image/png",
		detail: "original",
		providerFile: { provider: "openai", id: `keep-${name}-file`, uri: `keep-${name}-uri`, expiresAt: 1 },
		url: `https://example.invalid/keep-${name}.png`,
	};
}
/** The fields {@link keptImage} gives an image, each kept where KR7 names the image. */
const KEPT_IMAGE_FIELDS = [
	"type",
	"data",
	"mimeType",
	"detail",
	"providerFile.provider",
	"providerFile.id",
	"providerFile.uri",
	"url",
] as const;
const COMPACTION_SUMMARY_MESSAGE: StoredRecord = messageEntry({
	role: "compactionSummary",
	summary: HELD,
	shortSummary: HELD,
	tokensBefore: 1,
	method: "keep-summary-method",
	warning: HELD,
	blocks: [{ type: "text", text: HELD }],
	images: [keptImage(blobRef("d4"), "summary-image")],
	providerPayload: {
		type: "anthropicCompaction",
		provider: "keep-payload-provider",
		content: "plain summary text",
		signature: "keep-payload-signature",
		encryptedContent: "keep-payload-cipher",
		toolChanges: [
			{
				type: "tool_addition",
				tool: { type: "tool_reference", name: "keep-payload-tool" },
				opaque: { state: "keep-payload-opaque" },
			},
		],
		filesText: "plain files",
	},
	timestamp: NOW,
});
const OUTPUT_META: StoredRecord = {
	truncation: {
		direction: "keep-direction",
		truncatedBy: "keep-truncated-by",
		totalLines: 2,
		totalBytes: 2,
		outputLines: 1,
		outputBytes: 1,
		artifactId: "keep-truncation-artifact",
	},
	artifactError: "keep-artifact-error",
	source: { type: "keep-source-type", value: HELD },
	diagnostics: { summary: HELD, messages: [HELD] },
	limits: {
		columnTruncated: {
			maxColumn: 1,
			unit: "keep-unit",
			artifactId: "keep-column-artifact",
			selectorBase: "keep-selector-base",
		},
	},
	minimized: { filter: HELD, inputBytes: 2, outputBytes: 1, artifactId: "keep-minimized-artifact" },
};
const BASH_MESSAGE: StoredRecord = messageEntry({
	role: "bashExecution",
	command: HELD,
	output: HELD,
	exitCode: 0,
	cancelled: false,
	truncated: true,
	images: [keptImage(blobRef("e5"), "bash-image")],
	meta: OUTPUT_META,
	timestamp: NOW,
});
const PYTHON_MESSAGE: StoredRecord = messageEntry({
	role: "pythonExecution",
	code: HELD,
	output: HELD,
	exitCode: 0,
	cancelled: false,
	truncated: true,
	meta: OUTPUT_META,
	timestamp: NOW,
});
const FILE_MENTION_MESSAGE: StoredRecord = messageEntry({
	role: "fileMention",
	files: [
		{ path: HELD, content: HELD, lineCount: 1, skippedReason: "keep-skipped-reason" },
		{
			path: "plain/picture.png",
			content: "",
			image: keptImage("iVBORw0KGgoKeepMention", "mention-image"),
		},
	],
	timestamp: NOW,
});
const USER_BLOCKS_MESSAGE: StoredRecord = messageEntry({
	role: "user",
	content: [{ type: "text", text: HELD }],
	timestamp: NOW,
});
const ASSISTANT_BLOCKS_MESSAGE: StoredRecord = messageEntry(
	assistantRecord(
		[
			{ type: "thinking", thinking: HELD, itemId: "keep-item-id" },
			{
				type: "toolCall",
				id: "keep-call-id",
				name: "keep-call-name",
				arguments: { note: "plain" },
				intent: HELD,
				rawBlock: HELD,
				customWireName: "keep-wire-name",
				namespace: "keep-namespace",
				providerMetadata: {
					type: "computer",
					providerItemId: "keep-provider-item",
					actions: [
						{ type: "click", button: "left", x: 1, y: 2, keys: ["keep-key"] },
						{ type: "type", text: HELD },
					],
					pendingSafetyChecks: [{ id: "keep-check-id", code: "keep-check-code", message: HELD }],
				},
			},
			{ type: "redactedThinking", data: "keep-redacted-data" },
			{ type: "fallback", from: { model: "keep-from-model" }, to: { model: "keep-to-model" } },
		],
		{ stopReason: "toolUse" },
	),
);
const SIGNED_BLOCKS_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([
		{ type: "thinking", thinking: "plain thought", thinkingSignature: "keep-thinking-signature" },
		{ type: "text", text: "plain answer", textSignature: "keep-text-signature" },
		{
			type: "toolCall",
			id: "keep-signed-call",
			name: "keep-signed-tool",
			arguments: { note: "plain" },
			thoughtSignature: "keep-thought-signature",
		},
	]),
);
const SERVER_TOOL_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([
		{
			type: "anthropicServerTool",
			block: {
				type: "server_tool_use",
				id: "keep-server-use",
				name: "web_search",
				input: { query: "plain words" },
				cache_control: { type: "ephemeral", ttl: "1h", scope: "keep-cache-scope" },
			},
		},
		{
			type: "anthropicServerTool",
			block: {
				type: "web_search_tool_result",
				tool_use_id: "keep-server-use",
				content: [
					{
						type: "web_search_result",
						url: "plain-url",
						title: "plain title",
						encrypted_content: "keep-server-cipher",
						page_age: "plain age",
					},
				],
				cache_control: { type: "ephemeral", ttl: "5m", scope: "keep-result-cache-scope" },
			},
		},
		{
			type: "anthropicServerTool",
			block: {
				type: "tool_search_tool_result",
				tool_use_id: "keep-search-use",
				content: {
					type: "tool_search_tool_search_result",
					tool_references: [{ type: "tool_reference", tool_name: "keep-found-tool" }],
				},
			},
		},
		{
			type: "anthropicServerTool",
			block: {
				type: "web_search_tool_result",
				tool_use_id: "keep-error-use",
				content: { type: "web_search_tool_result_error", error_code: "keep-error-code" },
			},
		},
		{
			type: "anthropicServerTool",
			block: {
				type: "tool_search_tool_result",
				tool_use_id: "keep-search-error-use",
				content: { type: "tool_search_tool_result_error", error_code: "keep-search-error-code" },
			},
		},
	]),
);
const RESPONSES_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([{ type: "text", text: "plain answer" }], {
		providerPayload: {
			type: "openaiResponsesHistory",
			provider: "keep-responses-provider",
			items: [
				{
					type: "message",
					id: "keep-message-item",
					role: "assistant",
					status: "completed",
					phase: "keep-phase",
					content: [{ type: "output_text", text: "plain words" }],
				},
				{
					type: "reasoning",
					id: "keep-reasoning-item",
					summary: [{ type: "summary_text", text: "plain summary" }],
					encrypted_content: "keep-reasoning-cipher",
				},
				{
					type: "function_call",
					id: "keep-function-item",
					call_id: "keep-function-call",
					name: "keep-function-name",
					namespace: "keep-function-namespace",
					arguments: '{"query":"plain"}',
					status: "completed",
				},
				{
					type: "function_call_output",
					call_id: "keep-function-call",
					output: [
						{ type: "input_image", image_url: blobRef("f6"), detail: "original", file_id: "keep-output-file" },
					],
				},
				{
					type: "computer_call",
					id: "keep-computer-item",
					call_id: "keep-computer-call",
					status: "completed",
					action: { type: "click", button: "left", x: 1, y: 1, keys: ["keep-action-key"] },
					actions: [{ type: "click", button: "right", x: 2, y: 2, keys: ["keep-actions-key"] }],
					pending_safety_checks: [
						{ id: "keep-pending-check", code: "keep-pending-code", message: "plain message" },
					],
				},
				{
					type: "computer_call_output",
					call_id: "keep-computer-call",
					output: { type: "computer_screenshot", image_url: blobRef("0a"), file_id: "keep-screenshot-output" },
					acknowledged_safety_checks: [{ id: "keep-acknowledged-check", code: "keep-acknowledged-code" }],
				},
				{ type: "image_generation_call", id: "keep-image-item", status: "completed", result: "keep-image-result" },
				{
					type: "web_search_call",
					id: "keep-search-item",
					status: "completed",
					action: { type: "search", query: "plain query" },
				},
				{
					type: "apply_patch_call",
					call_id: "keep-patch-call",
					status: "completed",
					operation: { type: "create_file", path: "plain/path.txt", diff: "plain diff" },
				},
			],
		},
	}),
);
const MCP_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([{ type: "text", text: "plain answer" }], {
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [
				{
					type: "mcp_list_tools",
					id: "keep-mcp-list-item",
					server_label: "keep-mcp-list-server",
					tools: [
						{
							name: "keep-mcp-listed-tool",
							description: "plain description",
							input_schema: { type: "object", properties: { query: { description: "plain field" } } },
						},
					],
				},
				{
					type: "mcp_call",
					id: "keep-mcp-call-item",
					server_label: "keep-mcp-call-server",
					name: "keep-mcp-call-name",
					approval_request_id: "keep-mcp-call-approval",
					arguments: '{"query":"plain"}',
					output: "plain output",
					error: "plain error",
					status: "completed",
				},
				{
					type: "mcp_approval_request",
					id: "keep-mcp-request-item",
					server_label: "keep-mcp-request-server",
					name: "keep-mcp-request-name",
					arguments: '{"query":"plain"}',
				},
				{
					type: "mcp_approval_response",
					id: "keep-mcp-response-item",
					approval_request_id: "keep-mcp-response-approval",
					approve: true,
					reason: "plain reason",
				},
			],
		},
	}),
);
/** Responses items whose `output`, `content` and `summary` are objects, not arrays of parts. */
const RESPONSES_OBJECT_SHAPES_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([{ type: "text", text: "plain answer" }], {
		providerPayload: {
			type: "openaiResponsesHistory",
			items: [
				{
					type: "custom_tool_call_output",
					call_id: "keep-object-output-call",
					output: { type: "keep-object-output-type", text: "plain output" },
				},
				{
					type: "message",
					id: "keep-object-content-item",
					role: "user",
					content: { note: "plain content" },
					summary: { note: "plain summary" },
				},
			],
		},
	}),
);
const CURSOR_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([{ type: "text", text: "plain" }], {
		providerPayload: {
			type: "cursorHistory",
			wireRoute: "keep-wire-route",
			digest: "keep-cursor-digest",
			records: ["plain record"],
		},
	}),
);
const GEMINI_MESSAGE: StoredRecord = messageEntry(
	assistantRecord([{ type: "text", text: "plain" }], {
		providerPayload: {
			type: "geminiNativeContent",
			digest: "keep-gemini-digest",
			content: {
				role: "model",
				parts: [
					{ text: "plain text", thoughtSignature: "keep-gemini-thought" },
					{ functionCall: { id: "keep-gemini-call", name: "keep-gemini-function", args: { query: "plain" } } },
					{
						functionResponse: {
							id: "keep-gemini-response",
							name: "keep-gemini-response-name",
							response: { result: "plain result" },
						},
					},
					{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgoKeepGemini" } },
					{ fileData: { mimeType: "application/pdf", fileUri: "https://example.invalid/keep-gemini.pdf" } },
					{ executableCode: { language: "PYTHON", code: "print('plain')" } },
					{ codeExecutionResult: { outcome: "OUTCOME_OK", output: "plain output" } },
				],
			},
		},
	}),
);
const KEEP_BTW = {
	id: "keep-btw-0001",
	leafId: "keep-btw-leaf",
	question: HELD,
	images: [{ type: "image", data: "iVBORw0KGgoKeepBtw", mimeType: "image/png" }],
	answer: HELD,
	status: "complete",
	createdAt: NOW,
	updatedAt: NOW,
	error: HELD,
	followUps: [
		{
			question: HELD,
			images: [{ type: "image", data: "iVBORw0KGgoKeepFollowUp", mimeType: "image/png" }],
			answer: HELD,
			status: "error",
			createdAt: NOW,
			updatedAt: NOW,
			error: HELD,
		},
	],
} satisfies BtwHistoryRecord;

/** One row of the keep rules: the fields a position keeps as written and those it masks. */
interface KeepRow {
	readonly rule: string;
	readonly position: string;
	/** The record holding the position: an entry, the header or a `/btw` record. Rows may share one. */
	readonly record: StoredRecord;
	readonly kind?: "header" | "btw";
	/** The position's object in `record`, the shape the out-of-position cases copy. */
	readonly shape: FieldPath;
	/** Fields below `shape` kept as written. */
	readonly kept: readonly FieldPath[];
	/** Fields below `shape` that hold {@link HELD} and are masked. */
	readonly masked?: readonly FieldPath[];
}

const KEEP_ROWS: readonly KeepRow[] = [
	{
		rule: "KR1",
		position: "an entry",
		record: RUNTIME_ENTRY,
		shape: "",
		kept: [
			"type",
			"id",
			"parentId",
			"timestamp",
			"activeLeafId",
			"runtime.version",
			"runtime.commit",
			"runtime.branch",
			"runtime.diff",
		],
		masked: ["runtime.label"],
	},
	{
		rule: "KR2",
		position: "the header",
		record: KEEP_HEADER,
		kind: "header",
		shape: "",
		kept: [
			"type",
			"id",
			"timestamp",
			"titleSource",
			"cwd",
			"additionalDirectories.0",
			"parentSession",
			"continuationOf",
			"previousSessionFiles.0",
			"seanceSource",
			"providerPromptCacheKey",
			"taskPromptCacheKey",
		],
		masked: ["title"],
	},
	{
		rule: "KR3",
		position: "a model_usage entry",
		record: MODEL_USAGE_ENTRY,
		shape: "",
		kept: ["purpose", "role", "api", "provider", "model", "stopReason"],
		masked: ["errorMessage"],
	},
	{
		rule: "KR3",
		position: "a thinking_level_change entry",
		record: { type: "thinking_level_change", thinkingLevel: "high", configured: "auto" },
		shape: "",
		kept: ["thinkingLevel", "configured"],
	},
	{
		rule: "KR3",
		position: "a model_change entry",
		record: { type: "model_change", model: "keep-provider/keep-model", role: "keep-model-role" },
		shape: "",
		kept: ["model", "role"],
	},
	{
		rule: "KR3",
		position: "a service_tier_change entry",
		record: SERVICE_TIER_ENTRY,
		shape: "",
		kept: ["serviceTier.openai", "serviceTier.anthropic", "serviceTier.google"],
	},
	{
		rule: "KR3",
		position: "a service_tier_change entry whose serviceTier is a string",
		record: LEGACY_SERVICE_TIER_ENTRY,
		shape: "",
		kept: [],
		masked: ["serviceTier"],
	},
	{
		rule: "KR3",
		position: "a compaction entry",
		record: COMPACTION_ENTRY,
		shape: "",
		kept: ["firstKeptEntryId", "method", "providerReplayThroughEntryId"],
		masked: ["summary", "shortSummary", "warning"],
	},
	{
		rule: "KR3",
		position: "a branch_summary entry",
		record: BRANCH_SUMMARY_ENTRY,
		shape: "",
		kept: ["fromId"],
		masked: ["summary"],
	},
	{ rule: "KR3", position: "a custom entry", record: CUSTOM_ENTRY, shape: "", kept: ["customType"] },
	{
		rule: "KR3",
		position: "a custom_message entry",
		record: CUSTOM_MESSAGE_ENTRY,
		shape: "",
		kept: ["customType", "attribution", "tag"],
		masked: ["content"],
	},
	{
		rule: "KR3",
		position: "a label entry",
		record: { type: "label", targetId: "keep-label-target", label: HELD },
		shape: "",
		kept: ["targetId"],
		masked: ["label"],
	},
	{
		rule: "KR3",
		position: "a title_change entry",
		record: { type: "title_change", title: HELD, previousTitle: HELD, source: "auto", trigger: HELD },
		shape: "",
		kept: ["source"],
		masked: ["title", "previousTitle", "trigger"],
	},
	{
		rule: "KR3",
		position: "a ttsr_injection entry",
		record: { type: "ttsr_injection", injectedRules: ["keep-rule-a", "keep-rule-b"] },
		shape: "",
		kept: ["injectedRules.0", "injectedRules.1"],
	},
	{
		rule: "KR3",
		position: "a credential_pin entry",
		record: { type: "credential_pin", provider: "keep-pin-provider", hash: "keep-pin-hash" },
		shape: "",
		kept: ["provider", "hash"],
	},
	{
		rule: "KR3",
		position: "a session_init entry",
		record: SESSION_INIT_ENTRY,
		shape: "",
		kept: [
			"tools.0",
			"mountedTools.0",
			"agent",
			"modelRole",
			"resolvedModel",
			"perCallModelIdentity",
			"perCallThinkingLevel",
			"retryFallback.primary",
			"retryFallback.chain.0",
			"outputSchemaMode",
			"spawns",
			"advisor",
		],
		masked: ["systemPrompt.0", "task", "workPoolYieldItems.0.id"],
	},
	{
		rule: "KR3",
		position: "a mode_change entry",
		record: { type: "mode_change", mode: "keep-mode", data: { plan: "plain" } },
		shape: "",
		kept: ["mode"],
	},
	{
		rule: "KR4",
		position: "a user message",
		record: USER_MESSAGE,
		shape: "message",
		kept: ["role", "attribution", "tag"],
		masked: ["content", "parentIrc.from", "parentIrc.body"],
	},
	{
		rule: "KR4",
		position: "a developer message",
		record: DEVELOPER_MESSAGE,
		shape: "message",
		kept: ["role", "attribution"],
		masked: ["content"],
	},
	{
		rule: "KR4",
		position: "an assistant message",
		record: ASSISTANT_MESSAGE,
		shape: "message",
		kept: [
			"role",
			"api",
			"provider",
			"model",
			"responseId",
			"upstreamProvider",
			"upstreamModel",
			"serviceTier",
			"stopReason",
			"stopDetails.type",
			"stopDetails.category",
			"retryRecovery.kind",
			"retryRecovery.status",
			"retryRecovery.recovery",
			"retryRecovery.recoveredAt",
			"retryRecovery.supersededBy.responseId",
			"retryRecovery.supersededBy.provider",
			"retryRecovery.supersededBy.model",
			"disabledFeatures.0",
			"inputTransformations.0.type",
			"inputTransformations.0.path",
			"inputTransformations.0.reason",
			"requestControls.tools.declared.0",
			"requestControls.tools.deferred.0",
			"requestControls.tools.active.0",
			"requestControls.effort.topLevel",
			"requestControls.effort.tail",
		],
		masked: [
			"content.0.text",
			"stopDetails.explanation",
			"retryRecovery.note",
			"inputTransformations.0.note",
			"errorMessage",
			"errorDisplayMessage",
			"errorClassificationMessage",
			"toolCallAbortMessages.plain-call",
		],
	},
	{
		rule: "KR4",
		position: "a toolResult message",
		record: TOOL_RESULT_MESSAGE,
		shape: "message",
		kept: [
			"role",
			"toolCallId",
			"toolName",
			"attribution",
			"providerMetadata.type",
			"providerMetadata.screenshot.type",
			"providerMetadata.screenshot.file_id",
			"providerMetadata.acknowledgedSafetyChecks.0.id",
			"providerMetadata.acknowledgedSafetyChecks.0.code",
		],
		masked: ["content.0.text", "providerMetadata.acknowledgedSafetyChecks.0.message"],
	},
	{
		rule: "KR4",
		position: "a custom message",
		record: CUSTOM_ROLE_MESSAGE,
		shape: "message",
		kept: ["role", "customType", "attribution", "tag"],
		masked: ["content"],
	},
	{
		rule: "KR4",
		position: "a hookMessage message",
		record: HOOK_MESSAGE,
		shape: "message",
		kept: ["role", "customType", "attribution", "tag"],
		masked: ["content"],
	},
	{
		rule: "KR4",
		position: "a branchSummary message",
		record: BRANCH_SUMMARY_MESSAGE,
		shape: "message",
		kept: ["role", "fromId"],
		masked: ["summary"],
	},
	{
		rule: "KR4",
		position: "a compactionSummary message",
		record: COMPACTION_SUMMARY_MESSAGE,
		shape: "message",
		kept: ["role", "method"],
		masked: ["summary", "shortSummary", "warning"],
	},
	{
		rule: "KR4",
		position: "a bashExecution message",
		record: BASH_MESSAGE,
		shape: "message",
		kept: [
			"role",
			"meta.truncation.direction",
			"meta.truncation.truncatedBy",
			"meta.truncation.artifactId",
			"meta.artifactError",
			"meta.source.type",
			"meta.limits.columnTruncated.unit",
			"meta.limits.columnTruncated.artifactId",
			"meta.limits.columnTruncated.selectorBase",
			"meta.minimized.artifactId",
		],
		masked: [
			"command",
			"output",
			"meta.source.value",
			"meta.diagnostics.summary",
			"meta.diagnostics.messages.0",
			"meta.minimized.filter",
		],
	},
	{
		rule: "KR4",
		position: "a pythonExecution message",
		record: PYTHON_MESSAGE,
		shape: "message",
		kept: [
			"role",
			"meta.truncation.direction",
			"meta.truncation.truncatedBy",
			"meta.truncation.artifactId",
			"meta.artifactError",
			"meta.source.type",
			"meta.limits.columnTruncated.unit",
			"meta.limits.columnTruncated.artifactId",
			"meta.limits.columnTruncated.selectorBase",
			"meta.minimized.artifactId",
		],
		masked: ["code", "output", "meta.source.value", "meta.diagnostics.summary", "meta.minimized.filter"],
	},
	{
		rule: "KR4",
		position: "a fileMention message",
		record: FILE_MENTION_MESSAGE,
		shape: "message",
		kept: ["role", "files.0.skippedReason"],
		masked: ["files.0.path", "files.0.content"],
	},
	{
		rule: "KR5",
		position: "a text block of a message",
		record: USER_BLOCKS_MESSAGE,
		shape: "message.content.0",
		kept: ["type"],
		masked: ["text"],
	},
	{
		rule: "KR5",
		position: "a text block of a custom_message entry",
		record: CUSTOM_MESSAGE_BLOCKS_ENTRY,
		shape: "content.0",
		kept: ["type"],
		masked: ["text"],
	},
	{
		rule: "KR5",
		position: "a text block of compactionSummary.blocks",
		record: COMPACTION_SUMMARY_MESSAGE,
		shape: "message.blocks.0",
		kept: ["type"],
		masked: ["text"],
	},
	{
		rule: "KR5",
		position: "a thinking block",
		record: ASSISTANT_BLOCKS_MESSAGE,
		shape: "message.content.0",
		kept: ["type", "itemId"],
		masked: ["thinking"],
	},
	{
		rule: "KR5",
		position: "a toolCall block",
		record: ASSISTANT_BLOCKS_MESSAGE,
		shape: "message.content.1",
		kept: [
			"type",
			"id",
			"name",
			"customWireName",
			"namespace",
			"providerMetadata.type",
			"providerMetadata.providerItemId",
			"providerMetadata.actions.0.type",
			"providerMetadata.actions.0.button",
			"providerMetadata.actions.0.keys.0",
			"providerMetadata.actions.1.type",
			"providerMetadata.pendingSafetyChecks.0.id",
			"providerMetadata.pendingSafetyChecks.0.code",
		],
		masked: [
			"intent",
			"rawBlock",
			"providerMetadata.actions.1.text",
			"providerMetadata.pendingSafetyChecks.0.message",
		],
	},
	{
		rule: "KR5",
		position: "a redactedThinking block",
		record: ASSISTANT_BLOCKS_MESSAGE,
		shape: "message.content.2",
		kept: ["type", "data"],
	},
	{
		rule: "KR5",
		position: "a fallback block",
		record: ASSISTANT_BLOCKS_MESSAGE,
		shape: "message.content.3",
		kept: ["type", "from.model", "to.model"],
	},
	{
		rule: "KR5",
		position: "an image block",
		record: TOOL_RESULT_MESSAGE,
		shape: "message.content.1",
		kept: [
			"type",
			"data",
			"mimeType",
			"detail",
			"providerFile.provider",
			"providerFile.id",
			"providerFile.uri",
			"url",
		],
	},
	{
		rule: "KR5",
		position: "an anthropicServerTool block",
		record: SERVER_TOOL_MESSAGE,
		shape: "message.content.0",
		kept: ["type"],
	},
	{
		rule: "KR6",
		position: "a signed thinking block",
		record: SIGNED_BLOCKS_MESSAGE,
		shape: "message.content.0",
		kept: ["thinkingSignature"],
	},
	{
		rule: "KR6",
		position: "a signed text block",
		record: SIGNED_BLOCKS_MESSAGE,
		shape: "message.content.1",
		kept: ["textSignature"],
	},
	{
		rule: "KR6",
		position: "a signed toolCall block",
		record: SIGNED_BLOCKS_MESSAGE,
		shape: "message.content.2",
		kept: ["thoughtSignature"],
	},
	{
		rule: "KR7",
		position: "an image of a bashExecution message",
		record: BASH_MESSAGE,
		shape: "message.images.0",
		kept: KEPT_IMAGE_FIELDS,
	},
	{
		rule: "KR7",
		position: "an image of a compactionSummary message",
		record: COMPACTION_SUMMARY_MESSAGE,
		shape: "message.images.0",
		kept: KEPT_IMAGE_FIELDS,
	},
	{
		rule: "KR7",
		position: "the image of a fileMention file",
		record: FILE_MENTION_MESSAGE,
		shape: "message.files.1.image",
		kept: KEPT_IMAGE_FIELDS,
	},
	{
		rule: "KR7",
		position: "a tool result's screenshot",
		record: TOOL_RESULT_MESSAGE,
		shape: "message.providerMetadata.screenshot",
		kept: ["image_url"],
	},
	{
		rule: "KR7",
		position: "the images of a /btw record and its follow-up",
		record: KEEP_BTW,
		kind: "btw",
		shape: "",
		kept: [
			"images.0.type",
			"images.0.data",
			"images.0.mimeType",
			"followUps.0.images.0.type",
			"followUps.0.images.0.data",
			"followUps.0.images.0.mimeType",
		],
	},
	{
		rule: "KR8",
		position: "an openaiResponsesHistory payload",
		record: RESPONSES_MESSAGE,
		shape: "message.providerPayload",
		kept: [
			"type",
			"provider",
			"items.0.type",
			"items.0.id",
			"items.0.role",
			"items.0.status",
			"items.0.phase",
			"items.0.content.0.type",
			"items.1.type",
			"items.1.id",
			"items.1.summary.0.type",
			"items.1.encrypted_content",
			"items.2.type",
			"items.2.id",
			"items.2.call_id",
			"items.2.name",
			"items.2.namespace",
			"items.2.status",
			"items.3.type",
			"items.3.call_id",
			"items.3.output.0.type",
			"items.3.output.0.image_url",
			"items.3.output.0.detail",
			"items.3.output.0.file_id",
			"items.4.type",
			"items.4.id",
			"items.4.call_id",
			"items.4.status",
			"items.4.action.type",
			"items.4.action.button",
			"items.4.action.keys.0",
			"items.4.actions.0.type",
			"items.4.actions.0.button",
			"items.4.actions.0.keys.0",
			"items.4.pending_safety_checks.0.id",
			"items.4.pending_safety_checks.0.code",
			"items.5.type",
			"items.5.call_id",
			"items.5.output.type",
			"items.5.output.image_url",
			"items.5.output.file_id",
			"items.5.acknowledged_safety_checks.0.id",
			"items.5.acknowledged_safety_checks.0.code",
			"items.6.type",
			"items.6.id",
			"items.6.status",
			"items.6.result",
			"items.7.type",
			"items.7.id",
			"items.7.status",
			"items.7.action.type",
			"items.8.type",
			"items.8.call_id",
			"items.8.status",
			"items.8.operation.type",
		],
	},
	{
		rule: "KR8",
		position: "an anthropicMessage payload",
		record: DEVELOPER_MESSAGE,
		shape: "message.providerPayload",
		kept: ["type", "clearAt", "effort", "toolChanges.0.type", "toolChanges.0.name"],
	},
	{
		rule: "KR8",
		position: "an anthropicCompaction payload",
		record: COMPACTION_SUMMARY_MESSAGE,
		shape: "message.providerPayload",
		kept: [
			"type",
			"provider",
			"signature",
			"encryptedContent",
			"toolChanges.0.type",
			"toolChanges.0.tool.type",
			"toolChanges.0.tool.name",
			"toolChanges.0.opaque.state",
		],
	},
	{
		rule: "KR8",
		position: "a cursorHistory payload",
		record: CURSOR_MESSAGE,
		shape: "message.providerPayload",
		kept: ["type", "wireRoute", "digest"],
	},
	{
		rule: "KR8",
		position: "a geminiNativeContent payload",
		record: GEMINI_MESSAGE,
		shape: "message.providerPayload",
		kept: [
			"type",
			"digest",
			"content.role",
			"content.parts.0.thoughtSignature",
			"content.parts.1.functionCall.id",
			"content.parts.1.functionCall.name",
			"content.parts.2.functionResponse.id",
			"content.parts.2.functionResponse.name",
			"content.parts.3.inlineData.mimeType",
			"content.parts.3.inlineData.data",
			"content.parts.4.fileData.mimeType",
			"content.parts.4.fileData.fileUri",
			"content.parts.5.executableCode.language",
			"content.parts.6.codeExecutionResult.outcome",
		],
	},
	{
		rule: "KR8",
		position: "the object output, content and summary of Responses items",
		record: RESPONSES_OBJECT_SHAPES_MESSAGE,
		shape: "message.providerPayload",
		kept: ["items.0.type", "items.0.call_id", "items.0.output.type", "items.1.type", "items.1.id", "items.1.role"],
	},
	{
		rule: "KR8",
		position: "the MCP items of an openaiResponsesHistory payload",
		record: MCP_MESSAGE,
		shape: "message.providerPayload",
		kept: [
			"items.0.type",
			"items.0.id",
			"items.0.server_label",
			"items.0.tools.0.name",
			"items.1.type",
			"items.1.id",
			"items.1.server_label",
			"items.1.name",
			"items.1.approval_request_id",
			"items.1.status",
			"items.2.type",
			"items.2.id",
			"items.2.server_label",
			"items.2.name",
			"items.3.type",
			"items.3.id",
			"items.3.approval_request_id",
		],
	},
	{
		rule: "KR8",
		position: "a classic openaiRemoteCompaction slot",
		record: COMPACTION_ENTRY,
		shape: "preserveData.openaiRemoteCompaction",
		kept: [
			"provider",
			"replacementHistory.0.type",
			"replacementHistory.0.role",
			"replacementHistory.0.content.0.type",
			"compactionItem.type",
			"compactionItem.id",
			"compactionItem.encrypted_content",
		],
	},
	{
		rule: "KR8",
		position: "a v2 openaiRemoteCompaction slot",
		record: V2_COMPACTION_ENTRY,
		shape: "preserveData.openaiRemoteCompaction",
		kept: [
			"version",
			"provider",
			"replacementHistory.0.type",
			"replacementHistory.0.role",
			"replacementHistory.0.content.0.type",
			"replacementHistory.0.content.0.image_url",
			"replacementHistory.0.content.0.detail",
			"replacementHistory.1.type",
			"replacementHistory.1.id",
			"replacementHistory.1.encrypted_content",
		],
	},
	{
		rule: "KR8",
		position: "an anthropicCompaction slot",
		record: COMPACTION_ENTRY,
		shape: "preserveData.anthropicCompaction",
		kept: [
			"provider",
			"model",
			"signature",
			"encryptedContent",
			"toolChanges.0.type",
			"toolChanges.0.tool.type",
			"toolChanges.0.tool.name",
			"toolChanges.0.opaque.state",
			"toolChanges.0.opaque.steps.0",
		],
	},
	{
		rule: "KR8",
		position: "a server_tool_use block",
		record: SERVER_TOOL_MESSAGE,
		shape: "message.content.0.block",
		kept: ["type", "id", "name", "cache_control.type", "cache_control.ttl", "cache_control.scope"],
	},
	{
		rule: "KR8",
		position: "a web search result block",
		record: SERVER_TOOL_MESSAGE,
		shape: "message.content.1.block",
		kept: [
			"type",
			"tool_use_id",
			"content.0.type",
			"content.0.encrypted_content",
			"cache_control.type",
			"cache_control.ttl",
			"cache_control.scope",
		],
	},
	{
		rule: "KR8",
		position: "a tool search result block",
		record: SERVER_TOOL_MESSAGE,
		shape: "message.content.2.block",
		kept: [
			"type",
			"tool_use_id",
			"content.type",
			"content.tool_references.0.type",
			"content.tool_references.0.tool_name",
		],
	},
	{
		rule: "KR8",
		position: "a server-tool error block",
		record: SERVER_TOOL_MESSAGE,
		shape: "message.content.3.block",
		kept: ["type", "tool_use_id", "content.type", "content.error_code"],
	},
	{
		rule: "KR8",
		position: "a tool search error block",
		record: SERVER_TOOL_MESSAGE,
		shape: "message.content.4.block",
		kept: ["type", "tool_use_id", "content.type", "content.error_code"],
	},
	{
		rule: "KR9",
		position: "a snapcompact slot",
		record: COMPACTION_ENTRY,
		shape: "preserveData.snapcompact",
		kept: [
			"frames.0.data",
			"frames.0.mimeType",
			"frames.0.detail",
			"frames.0.font",
			"frames.0.variant",
			"withoutThinking.archive.frames.0.data",
			"withoutThinking.archive.frames.0.mimeType",
			"withoutThinking.archive.frames.0.detail",
			"withoutThinking.archive.frames.0.font",
			"withoutThinking.archive.frames.0.variant",
		],
	},
	{
		rule: "KR11",
		position: "a /btw record",
		record: KEEP_BTW,
		kind: "btw",
		shape: "",
		kept: ["id", "leafId", "status", "followUps.0.status"],
		masked: ["question", "answer", "error", "followUps.0.question", "followUps.0.answer", "followUps.0.error"],
	},
];

/** Shapes some row keeps in its position, here holding a held value under a key no row names. */
const FREE_SHAPES: readonly { readonly shape: string; readonly value: unknown; readonly field: FieldPath }[] = [
	{ shape: "an encrypted_content key", value: { encrypted_content: HELD }, field: "encrypted_content" },
	{
		shape: "an image-shaped object",
		value: { type: "image", data: `iVBORw0KGgo${ENV_VALUE}`, mimeType: "image/png" },
		field: "data",
	},
	{ shape: "a blob reference", value: `blob:sha256:${ENV_VALUE}`, field: "" },
	{ shape: "an image data URL", value: `data:image/png;base64,${ENV_VALUE}`, field: "" },
];

/** Where the out-of-position cases put every row's shape: free data, each under a key no row names. */
const OUT_OF_POSITION: readonly { readonly where: string; readonly record: StoredRecord; readonly field: FieldPath }[] =
	(() => {
		const shapes: StoredRecord = {};
		for (const [index, row] of KEEP_ROWS.entries()) shapes[`row${index}`] = valueAt(row.record, row.shape);
		for (const [index, free] of FREE_SHAPES.entries()) shapes[`free${index}`] = free.value;
		return [
			{
				where: "a tool call's arguments",
				record: messageEntry(
					assistantRecord(
						[{ type: "toolCall", id: "plain-free-call", name: "plain-free-tool", arguments: shapes }],
						{
							stopReason: "toolUse",
						},
					),
				),
				field: "message.content.0.arguments",
			},
			{
				where: "a tool result's details",
				record: messageEntry({
					role: "toolResult",
					toolCallId: "plain-free-call",
					toolName: "plain-free-tool",
					content: [{ type: "text", text: "plain" }],
					details: shapes,
					isError: false,
					timestamp: NOW,
				}),
				field: "message.details",
			},
			{
				where: "a custom entry's data",
				record: { type: "custom", customType: "plain-free-custom", data: shapes },
				field: "data",
			},
			{
				where: "a non-format key",
				record: {
					type: "compaction",
					summary: "plain",
					firstKeptEntryId: ROOT_ENTRY_ID,
					tokensBefore: 1,
					preserveData: { extensionState: { nested: shapes } },
				},
				field: "preserveData.extensionState.nested",
			},
		];
	})();

/** The header, then every entry of the keep-rule session, in file order. */
const KEEP_FIXTURES: readonly StoredRecord[] = [
	KEEP_HEADER,
	ROOT_ENTRY,
	...new Set(KEEP_ROWS.filter(row => row.kind === undefined).map(row => row.record)),
	...OUT_OF_POSITION.map(({ record }) => record),
];

/** The stored line of a fixture: the title slot comes before the header. */
function storedLineOf(fixture: StoredRecord): number {
	return KEEP_FIXTURES.indexOf(fixture) + 1;
}

/** A regex matching each value the table keeps, as a whole string, and nothing else. */
function keptValuesRegex(): string {
	const values = KEEP_ROWS.flatMap(row => row.kept.map(field => valueAt(row.record, joinPath(row.shape, field))));
	const strings = values.filter((value): value is string => typeof value === "string");
	if (strings.length !== values.length) throw new Error("A kept field of the keep-rule table holds no string");
	return `^(?:${[...new Set(strings)].map(value => RegExp.escape(value)).join("|")})$`;
}

/**
 * Writes the keep-rule session as the live session holds it, opens it with the table's mask on
 * and rewrites it, and returns every stored line, title slot first.
 */
async function storeKeepRuleSession(store: StoreHarness, dir: TempDir): Promise<StoredRecord[]> {
	let parentId: string | null = null;
	const lines = KEEP_FIXTURES.map((fixture, index) => {
		if (fixture === KEEP_HEADER) return fixture;
		const id = typeof fixture.id === "string" ? fixture.id : `keep-auto-${index}`;
		const line = { id, parentId, timestamp: KEEP_TIMESTAMP, ...fixture };
		parentId = id;
		return line;
	});
	const file = path.join(store.sessionDir, "keep-rules.jsonl");
	await store.storage.writeText(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	const tableMask = await regexMask(dir.join("agent"), dir.join("project"), keptValuesRegex());
	const storeMaskSpy = spyOn(SessionManager.prototype, "storeMask").mockReturnValue(tableMask);
	try {
		const manager = await SessionManager.open(file, store.sessionDir, store.storage);
		await manager.rewriteEntries();
		await settle(manager, store.storage);
		await manager.close();
	} finally {
		storeMaskSpy.mockRestore();
	}
	return Bun.JSONL.parse(await store.storage.readText(file)).filter(isRecord);
}

/** The cases of `row` in its position: each kept field as written, each masked field its marker. */
function inPositionCases(row: KeepRow, storedRecord: () => unknown): void {
	for (const field of row.kept) {
		it(`${row.rule}: ${row.position} keeps ${field} as written`, () => {
			const at = joinPath(row.shape, field);
			const keptAsWritten = valueAt(storedRecord(), at) === valueAt(row.record, at);
			expect({ field: at, keptAsWritten }).toEqual({ field: at, keptAsWritten: true });
		});
	}
	for (const field of row.masked ?? []) {
		it(`${row.rule}: ${row.position} masks ${field}`, () => {
			const at = joinPath(row.shape, field);
			const marker = valueAt(storedRecord(), at) === HELD_MARKER;
			expect({ field: at, marker }).toEqual({ field: at, marker: true });
		});
	}
}

for (const backend of backends) {
	describe(`keep rules in and out of their positions with ${backend.name}`, () => {
		let stored: StoredRecord[] = [];

		beforeAll(async () => {
			const dir = TempDir.createSync("@omp-keep-rules-");
			try {
				const store = await backend.open(dir.path());
				try {
					stored = await storeKeepRuleSession(store, dir);
				} finally {
					await store.close();
				}
			} finally {
				await dir.remove();
			}
		});

		for (const [index, row] of KEEP_ROWS.entries()) {
			if (row.kind !== "btw") inPositionCases(row, () => stored[storedLineOf(row.record)]);
			for (const field of row.kept) {
				it(`${row.rule}: ${field} of ${row.position} is masked out of position`, () => {
					const markers = OUT_OF_POSITION.map(({ where, record, field: free }) => ({
						where,
						marker:
							valueAt(stored[storedLineOf(record)], joinPath(joinPath(free, `row${index}`), field)) ===
							REGEX_MARKER,
					}));
					expect(markers).toEqual(OUT_OF_POSITION.map(({ where }) => ({ where, marker: true })));
				});
			}
		}

		for (const [index, free] of FREE_SHAPES.entries()) {
			it(`masks the held value in ${free.shape} out of position`, () => {
				const masked = OUT_OF_POSITION.map(({ where, record, field }) => {
					const value = valueAt(
						stored[storedLineOf(record)],
						joinPath(joinPath(field, `free${index}`), free.field),
					);
					return {
						where,
						marker: typeof value === "string" && value.includes(ENV_MARKER) && !value.includes(ENV_VALUE),
					};
				});
				expect(masked).toEqual(OUT_OF_POSITION.map(({ where }) => ({ where, marker: true })));
			});
		}
	});
}

describe("keep rules of the /btw record", () => {
	let stored: StoredRecord = {};
	let storedTitle = "";

	beforeAll(async () => {
		const dir = TempDir.createSync("@omp-keep-rules-btw-");
		try {
			const btwMask = await regexMask(dir.join("agent"), dir.join("project"), keptValuesRegex());
			const artifactsDir = dir.join("artifacts");
			const btw = await BtwHistoryStore.open(artifactsDir, { storeMask: () => btwMask });
			await btw.upsert({ ...KEEP_BTW, title: HELD });
			await btw.flush();
			const historyDir = path.join(artifactsDir, "btw-history");
			const record: unknown = JSON.parse(await Bun.file(path.join(historyDir, `entry-${KEEP_BTW.id}.json`)).text());
			if (!isRecord(record)) throw new Error("Expected a stored /btw record");
			stored = record;
			storedTitle = await Bun.file(path.join(historyDir, `entry-${KEEP_BTW.id}.title`)).text();
		} finally {
			await dir.remove();
		}
	});

	for (const row of KEEP_ROWS) {
		if (row.kind === "btw") inPositionCases(row, () => stored);
	}

	it("KR11: masks the /btw title sidecar", () => {
		expect({ marker: storedTitle === HELD_MARKER }).toEqual({ marker: true });
	});
});

/** A Responses reasoning item as a thinking block's signature; its ciphertext matches {@link SIGNATURE_REGEX}. */
function reasoningSignature(item: StoredRecord): string {
	return JSON.stringify({ type: "reasoning", id: "rs_plain", encrypted_content: "sealedcipher01", ...item });
}

/** The regex of the signature cases: it matches each opaque signature and ciphertext they hold. */
const SIGNATURE_REGEX = "sealed[0-9a-z]+";

/** KR6: a signed block, and whether its stored copy keeps the signature as written. */
const SIGNATURE_CASES: readonly {
	readonly name: string;
	readonly block: StoredRecord;
	readonly signature: string;
	readonly kept: boolean;
}[] = [
	{
		name: "a Responses reasoning item whose reasoning_text part holds a value beside its summary",
		block: {
			type: "thinking",
			thinking: "plain summary words",
			thinkingSignature: reasoningSignature({
				summary: [{ type: "summary_text", text: "plain summary words" }],
				content: [{ type: "reasoning_text", text: HELD }],
			}),
		},
		signature: "thinkingSignature",
		kept: false,
	},
	{
		name: "a Responses reasoning item whose second reasoning_text part holds a value",
		block: {
			type: "thinking",
			thinking: "plain first part",
			thinkingSignature: reasoningSignature({
				summary: [],
				content: [
					{ type: "reasoning_text", text: "plain first part" },
					{ type: "reasoning_text", text: HELD },
				],
			}),
		},
		signature: "thinkingSignature",
		kept: false,
	},
	{
		name: "a Codex-cutoff block whose thinking is only the new suffix",
		block: {
			type: "thinking",
			thinking: "plain new suffix",
			thinkingSignature: reasoningSignature({
				summary: [],
				content: [{ type: "reasoning_text", text: `earlier ${ENV_VALUE} plain new suffix` }],
			}),
		},
		signature: "thinkingSignature",
		kept: false,
	},
	{
		name: "an opaque signature the regex matches",
		block: { type: "thinking", thinking: "plain thought", thinkingSignature: "sealedopaque01" },
		signature: "thinkingSignature",
		kept: true,
	},
	{
		name: "a reasoning item whose encrypted_content the regex matches",
		block: {
			type: "thinking",
			thinking: "plain reasoning",
			thinkingSignature: reasoningSignature({ summary: [{ type: "summary_text", text: "plain reasoning" }] }),
		},
		signature: "thinkingSignature",
		kept: true,
	},
	{
		name: "a signed text block whose text holds no value",
		block: { type: "text", text: "plain answer", textSignature: "sealedtext01" },
		signature: "textSignature",
		kept: true,
	},
];

/** An assistant message whose `providerPayload` is a `geminiNativeContent` carrier holding `parts`. */
function geminiCarrierMessage(parts: unknown[]): StoredRecord {
	return assistantRecord([{ type: "text", text: "plain" }], {
		providerPayload: { type: "geminiNativeContent", digest: "plain-digest", content: { role: "model", parts } },
	});
}

/** An assistant message whose `providerPayload` is an `openaiResponsesHistory` carrier holding `items`. */
function responsesCarrierMessage(items: unknown[]): StoredRecord {
	return assistantRecord([{ type: "text", text: "plain" }], {
		providerPayload: { type: "openaiResponsesHistory", items },
	});
}

/** A Gemini part, or an MCP item, whose one still-scanned field holds a value, beside the fields its row keeps. */
const SCANNED_CARRIER_FIELDS: readonly { readonly name: string; readonly message: StoredRecord }[] = [
	{
		name: "a geminiNativeContent part's text",
		message: geminiCarrierMessage([{ text: HELD, thoughtSignature: "plain-thought" }]),
	},
	{
		name: "a geminiNativeContent functionResponse.response",
		message: geminiCarrierMessage([
			{ functionResponse: { id: "call_plain", name: "lookup", response: { result: HELD } } },
		]),
	},
	{
		name: "a geminiNativeContent executableCode.code",
		message: geminiCarrierMessage([{ executableCode: { language: "PYTHON", code: HELD } }]),
	},
	{
		name: "a geminiNativeContent codeExecutionResult.output",
		message: geminiCarrierMessage([{ codeExecutionResult: { outcome: "OUTCOME_OK", output: HELD } }]),
	},
	{
		name: "an mcp_call item's arguments",
		message: responsesCarrierMessage([
			{
				type: "mcp_call",
				id: "mcp_plain",
				server_label: "plain-server",
				name: "lookup",
				arguments: JSON.stringify({ query: HELD }),
			},
		]),
	},
	{
		name: "an mcp_call item's output",
		message: responsesCarrierMessage([
			{
				type: "mcp_call",
				id: "mcp_plain",
				server_label: "plain-server",
				name: "lookup",
				arguments: "{}",
				output: HELD,
			},
		]),
	},
	{
		name: "an mcp_call item's error",
		message: responsesCarrierMessage([
			{
				type: "mcp_call",
				id: "mcp_plain",
				server_label: "plain-server",
				name: "lookup",
				arguments: "{}",
				error: HELD,
			},
		]),
	},
	{
		name: "an mcp_approval_response item's reason",
		message: responsesCarrierMessage([
			{ type: "mcp_approval_response", approval_request_id: "mcpr_plain", approve: false, reason: HELD },
		]),
	},
	{
		name: "an mcp_list_tools tool's description",
		message: responsesCarrierMessage([
			{
				type: "mcp_list_tools",
				server_label: "plain-server",
				tools: [{ name: "lookup", description: HELD, input_schema: {} }],
			},
		]),
	},
	{
		name: "an mcp_list_tools tool's input_schema",
		message: responsesCarrierMessage([
			{
				type: "mcp_list_tools",
				server_label: "plain-server",
				tools: [{ name: "lookup", input_schema: { type: "object", properties: { query: { description: HELD } } } }],
			},
		]),
	},
	// A Responses item keeps an image part's fields only in an element of its `content[]`, `summary[]`
	// or `output[]`, and only `type` on an object `output`; all of an object `content` or `summary` is masked.
	...(
		[
			["function_call_output", "output", "image_url"],
			["function_call_output", "output", "detail"],
			["function_call_output", "output", "file_id"],
			["message", "content", "type"],
			["message", "content", "image_url"],
			["message", "content", "detail"],
			["message", "content", "file_id"],
			["reasoning", "summary", "type"],
			["reasoning", "summary", "image_url"],
			["reasoning", "summary", "detail"],
			["reasoning", "summary", "file_id"],
		] as const
	).map(([type, key, field]) => ({
		name: `Responses ${type} item's object ${key}.${field}`,
		message: responsesCarrierMessage([
			{
				type,
				call_id: "call_plain",
				[key]: {
					type: "input_image",
					image_url: "plain-url",
					detail: "auto",
					file_id: "plain-file",
					[field]: HELD,
				},
			},
		]),
	})),
];

/** A drop rule's case: the entry a session appends, and the field its stored copy leaves out. */
type DropCase = { readonly rule: string; readonly name: string; readonly dropped: FieldPath } & (
	| { readonly message: StoredRecord }
	| { readonly preserveData: StoredRecord }
);

const DROP_CASES: readonly DropCase[] = [
	{
		rule: "KR10",
		name: "a signed thinking block whose thinking holds a value loses its signature",
		message: assistantRecord([{ type: "thinking", thinking: HELD, thinkingSignature: "opaque-thinking-signature" }]),
		dropped: "message.content.0.thinkingSignature",
	},
	{
		rule: "KR10",
		name: "a signed text block whose text holds a value loses its signature",
		message: assistantRecord([{ type: "text", text: HELD, textSignature: "opaque-text-signature" }]),
		dropped: "message.content.0.textSignature",
	},
	{
		rule: "KR10",
		name: "a signed toolCall block whose arguments hold a value loses its signature",
		message: assistantRecord([
			{
				type: "toolCall",
				id: "call-signed",
				name: "lookup",
				arguments: { query: HELD },
				thoughtSignature: "opaque-thought-signature",
			},
		]),
		dropped: "message.content.0.thoughtSignature",
	},
	{
		rule: "KR10",
		name: "a Responses payload whose output text holds a value is left out",
		message: assistantRecord([{ type: "text", text: "plain" }], {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: HELD }] }],
			},
		}),
		dropped: "message.providerPayload",
	},
	{
		rule: "KR10",
		name: "a Responses payload whose reasoning summary holds a value is left out",
		message: assistantRecord([{ type: "text", text: "plain" }], {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{
						type: "reasoning",
						id: "rs_plain",
						summary: [{ type: "summary_text", text: HELD }],
						encrypted_content: "plain-cipher",
					},
				],
			},
		}),
		dropped: "message.providerPayload",
	},
	{
		rule: "KR8",
		name: "a Responses function_call whose arguments hold a value under an id key leaves no copy",
		message: assistantRecord([{ type: "text", text: "plain" }], {
			providerPayload: {
				type: "openaiResponsesHistory",
				items: [
					{
						type: "function_call",
						id: "fc_plain",
						call_id: "call_plain",
						name: "lookup",
						arguments: JSON.stringify({ id: HELD }),
					},
				],
			},
		}),
		dropped: "message.providerPayload",
	},
	{
		rule: "KR8",
		name: "a geminiNativeContent payload whose functionCall.args.name holds a value leaves no copy",
		message: assistantRecord([{ type: "text", text: "plain" }], {
			providerPayload: {
				type: "geminiNativeContent",
				digest: "plain-digest",
				content: {
					role: "model",
					parts: [{ functionCall: { id: "call_plain", name: "lookup", args: { name: HELD } } }],
				},
			},
		}),
		dropped: "message.providerPayload",
	},
	...SCANNED_CARRIER_FIELDS.map(({ name, message }): DropCase => ({
		rule: "KR8",
		name: `a carrier whose ${name} holds a value leaves no copy`,
		message,
		dropped: "message.providerPayload",
	})),
	{
		rule: "KR10",
		name: "a cursorHistory payload whose records hold a value is left out",
		message: assistantRecord([{ type: "text", text: "plain" }], {
			providerPayload: { type: "cursorHistory", wireRoute: "plain-route", digest: "plain-digest", records: [HELD] },
		}),
		dropped: "message.providerPayload",
	},
	{
		rule: "KR10",
		name: "a classic openaiRemoteCompaction slot whose compactionItem summary holds a value is left out",
		preserveData: {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [],
				compactionItem: { type: "compaction_summary", summary: HELD },
			},
		},
		dropped: "preserveData.openaiRemoteCompaction",
	},
	{
		rule: "KR10",
		name: "a v2 openaiRemoteCompaction slot whose retained text holds a value is left out",
		preserveData: {
			openaiRemoteCompaction: {
				version: "v2",
				provider: "openai",
				replacementHistory: [{ type: "message", role: "user", content: [{ type: "input_text", text: HELD }] }],
				usedTokens: 1,
			},
		},
		dropped: "preserveData.openaiRemoteCompaction",
	},
	{
		rule: "KR10",
		name: "an anthropicCompaction slot whose content holds a value is left out",
		preserveData: { anthropicCompaction: { provider: "anthropic", content: HELD, signature: "opaque-signature" } },
		dropped: "preserveData.anthropicCompaction",
	},
	{
		rule: "KR10",
		name: "an anthropicCompaction slot whose retained file text holds a value is left out",
		preserveData: {
			anthropicCompaction: {
				provider: "anthropic",
				content: "plain summary",
				retainedFiles: [{ text: HELD, after: 1 }],
			},
		},
		dropped: "preserveData.anthropicCompaction",
	},
	{
		rule: "KR9",
		name: "a snapcompact slot whose text holds a value is left out",
		preserveData: {
			snapcompact: {
				frames: [{ data: "iVBORw0KGgoPlainFrame", mimeType: "image/png", cols: 1, rows: 1, chars: 1 }],
				totalChars: 1,
				truncatedChars: 0,
				text: HELD,
			},
		},
		dropped: "preserveData.snapcompact",
	},
	{
		rule: "KR9",
		name: "a snapcompact slot whose withoutThinking summary holds a value is left out",
		preserveData: {
			snapcompact: {
				frames: [],
				totalChars: 1,
				truncatedChars: 0,
				text: "plain archive",
				withoutThinking: {
					summary: HELD,
					archive: { frames: [], totalChars: 1, truncatedChars: 0, text: "plain archive" },
				},
			},
		},
		dropped: "preserveData.snapcompact",
	},
];

/** The still-scanned fields of an `anthropicServerTool` group: its call's `input` and its results' `url`, `title` and `page_age`. */
const SERVER_TOOL_SCANNED_FIELDS = ["input", "url", "title", "page_age"] as const;

/**
 * A text block, an `anthropicServerTool` call and its result, and a text block. Both server-tool
 * blocks carry every `cache_control` field; only the field `held` names holds a value.
 */
function serverToolGroup(held: (typeof SERVER_TOOL_SCANNED_FIELDS)[number]): unknown[] {
	const text = (field: string): string => (field === held ? HELD : `plain ${field}`);
	const cacheControl = { type: "ephemeral", ttl: "1h", scope: "plain-scope" };
	return [
		{ type: "text", text: "plain before" },
		{
			type: "anthropicServerTool",
			block: {
				type: "server_tool_use",
				id: "srvtoolu_plain",
				name: "web_search",
				input: { query: text("input") },
				cache_control: cacheControl,
			},
		},
		{
			type: "anthropicServerTool",
			block: {
				type: "web_search_tool_result",
				tool_use_id: "srvtoolu_plain",
				content: [
					{
						type: "web_search_result",
						url: text("url"),
						title: text("title"),
						page_age: text("page_age"),
						encrypted_content: "plain-cipher",
					},
				],
				cache_control: cacheControl,
			},
		},
		{ type: "text", text: "plain after" },
	];
}

/** A digit-only held value, under a secret-named variable of the stored-form cases' own mask. */
const NUMBER_VALUE = "73190428865";
const NUMBER_MARKER = "[REDACTED:env:SERVICE_NUMBER_TOKEN]";

/**
 * A tool result detail that the session line stores in another form than its own keys: through its
 * `toJSON`, as the primitive a boxed `String` holds, or as a `bigint`'s decimal string. Each holds
 * a value in that form only.
 */
const STORED_FORM_DETAILS: readonly {
	readonly name: string;
	readonly detail: () => unknown;
	readonly value: string;
	/** The stored form of the detail once masked. */
	readonly masked: unknown;
}[] = [
	{
		name: "an object with toJSON",
		detail: () => ({ toJSON: () => ({ note: HELD }) }),
		value: ENV_VALUE,
		masked: { note: HELD_MARKER },
	},
	{ name: "a boxed String", detail: () => new String(HELD), value: ENV_VALUE, masked: HELD_MARKER },
	{ name: "a bigint", detail: () => BigInt(NUMBER_VALUE), value: NUMBER_VALUE, masked: NUMBER_MARKER },
];

/** A tool name the regex of the `anthropicCompaction` tool-change cases matches. */
const CHANGED_TOOL = "lookup_ledger_records";
const CHANGED_TOOL_REGEX = "lookup_[a-z]+_records";

/** An `anthropicCompaction` carrier holding `toolChanges`, at each place KR8 names one. */
const COMPACTION_TOOL_CHANGE_PLACES: readonly {
	readonly place: string;
	readonly append: (manager: SessionManager, toolChanges: unknown[]) => void;
	readonly toolChanges: FieldPath;
}[] = [
	{
		place: "compaction.preserveData.anthropicCompaction",
		append(manager, toolChanges) {
			const userId = manager.appendMessage({ role: "user", content: "plain question", timestamp: NOW });
			manager.appendCompaction("plain summary", undefined, userId, 1, {
				preserveData: {
					anthropicCompaction: {
						provider: "anthropic",
						model: "plain-model",
						content: "plain summary",
						signature: "plain-signature",
						toolChanges,
					},
				},
			});
		},
		toolChanges: "preserveData.anthropicCompaction.toolChanges",
	},
	{
		place: "a compactionSummary message's providerPayload",
		append(manager, toolChanges) {
			manager.appendMessage({
				role: "compactionSummary",
				summary: "plain summary",
				tokensBefore: 1,
				providerPayload: {
					type: "anthropicCompaction",
					provider: "anthropic",
					content: "plain summary",
					signature: "plain-signature",
					toolChanges,
				},
				timestamp: NOW,
			} as unknown as AssistantMessage);
		},
		toolChanges: "message.providerPayload.toolChanges",
	},
];

/** `toolChanges` elements an `anthropicCompaction` keeps nothing of: each holds {@link CHANGED_TOOL} out of its declared shape. */
const UNKEPT_TOOL_CHANGES: readonly { readonly name: string; readonly element: StoredRecord }[] = [
	{ name: "the element's own name", element: { type: "tool_addition", name: CHANGED_TOOL } },
	{
		name: "an opaque written as a string",
		element: { type: "tool_addition", tool: { type: "tool_reference", name: "plain-tool" }, opaque: CHANGED_TOOL },
	},
	{
		name: "a tool written as an array",
		element: { type: "tool_removal", tool: [{ type: "tool_reference", name: CHANGED_TOOL }] },
	},
];

/** Ciphertext the regex of the server-tool element cases matches. */
const SERVER_CIPHER = "sealedserver01";

/**
 * `anthropicServerTool` result blocks holding {@link SERVER_CIPHER} in a field KR8 keeps on one
 * element type of one block type: kept there, and nowhere else.
 */
const SERVER_TOOL_ELEMENT_CASES: readonly {
	readonly name: string;
	readonly block: StoredRecord;
	readonly keeps: boolean;
}[] = [
	{
		name: "a web_search_result element of a web_search_tool_result",
		block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: [{ type: "web_search_result", encrypted_content: SERVER_CIPHER }],
		},
		keeps: true,
	},
	{
		name: "an element of another type in a web_search_tool_result",
		block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: [{ type: "plain_other_result", encrypted_content: SERVER_CIPHER }],
		},
		keeps: false,
	},
	{
		name: "a web_search_tool_result_error written as an element of a web_search_tool_result",
		block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: [{ type: "web_search_tool_result_error", error_code: SERVER_CIPHER }],
		},
		keeps: false,
	},
	{
		name: "a web_search_result written as a web_search_tool_result's object content",
		block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: { type: "web_search_result", encrypted_content: SERVER_CIPHER },
		},
		keeps: false,
	},
	{
		name: "a web_search_tool_result_error under a tool_search_tool_result",
		block: {
			type: "tool_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: { type: "web_search_tool_result_error", error_code: SERVER_CIPHER },
		},
		keeps: false,
	},
	{
		name: "a tool_references element of another type",
		block: {
			type: "tool_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: {
				type: "tool_search_tool_search_result",
				tool_references: [{ type: "plain_other_reference", tool_name: SERVER_CIPHER }],
			},
		},
		keeps: false,
	},
	{
		name: "a tool_search_tool_search_result under a web_search_tool_result",
		block: {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_plain",
			content: {
				type: "tool_search_tool_search_result",
				tool_references: [{ type: "tool_reference", tool_name: SERVER_CIPHER }],
			},
		},
		keeps: false,
	},
	{
		name: "a web_search_result element under a server_tool_use",
		block: {
			type: "server_tool_use",
			id: "srvtoolu_other",
			name: "web_search",
			content: [{ type: "web_search_result", encrypted_content: SERVER_CIPHER }],
		},
		keeps: false,
	},
];

for (const backend of backends) {
	describe(`keep rules for signatures, carriers and values by type with ${backend.name}`, () => {
		let store: StoreHarness;

		beforeEach(async () => {
			store = await backend.open(tmp.path());
		});

		afterEach(async () => {
			await store.close();
		});

		/** A session on disk whose writes apply `writeMask`. */
		async function maskedSession(writeMask: storeMask.SessionStoreMask): Promise<SessionManager> {
			spyOn(SessionManager.prototype, "storeMask").mockReturnValue(writeMask);
			const manager = SessionManager.create(cwd, store.sessionDir, store.storage);
			await manager.ensureOnDisk();
			return manager;
		}

		/** What the store holds for `manager`'s session once its writes settle. */
		async function storedText(manager: SessionManager): Promise<string> {
			await settle(manager, store.storage);
			return store.storage.readText(sessionFileOf(manager));
		}

		for (const signatureCase of SIGNATURE_CASES) {
			it(`KR6: ${signatureCase.kept ? "keeps" : "drops"} the signature of ${signatureCase.name}`, async () => {
				const manager = await maskedSession(await regexMask(tmp.join("agent"), cwd, SIGNATURE_REGEX));
				manager.appendMessage(assistantRecord([signatureCase.block]) as unknown as AssistantMessage);
				const text = await storedText(manager);
				const signature = valueAt(storedRecords(text).at(-1), `message.content.0.${signatureCase.signature}`);
				expect({
					leaked: leakedFields(text),
					signed: signature !== undefined,
					signatureAsWritten: signature === signatureCase.block[signatureCase.signature],
				}).toEqual({ leaked: [], signed: signatureCase.kept, signatureAsWritten: signatureCase.kept });
				await manager.close();
			});
		}

		for (const dropCase of DROP_CASES) {
			it(`${dropCase.rule}: ${dropCase.name}, while the live entry keeps it`, async () => {
				const manager = await maskedSession(mask);
				if ("message" in dropCase) {
					manager.appendMessage(dropCase.message as unknown as AssistantMessage);
				} else {
					const userId = manager.appendMessage({ role: "user", content: "plain question", timestamp: NOW });
					manager.appendCompaction("plain summary", undefined, userId, 1, { preserveData: dropCase.preserveData });
				}
				const text = await storedText(manager);
				const parent = dropCase.dropped.split(".");
				const key = parent.pop() ?? "";
				const storedParent = valueAt(storedRecords(text).at(-1), parent.join("."));
				const live = manager.getEntries().at(-1);
				expect({
					leaked: leakedFields(text),
					leftOut: isRecord(storedParent) && !Object.hasOwn(storedParent, key),
					liveKeepsIt: valueAt(live, dropCase.dropped) !== undefined,
					liveHoldsValue: JSON.stringify(live).includes(ENV_VALUE),
				}).toEqual({ leaked: [], leftOut: true, liveKeepsIt: true, liveHoldsValue: true });
				await manager.close();
			});
		}

		for (const field of SERVER_TOOL_SCANNED_FIELDS) {
			it(`KR10: drops an anthropicServerTool group whose ${field} holds a value with its siblings, while the live entry keeps them`, async () => {
				const manager = await maskedSession(mask);
				manager.appendMessage(assistantRecord(serverToolGroup(field)) as unknown as AssistantMessage);
				const text = await storedText(manager);
				const content = valueAt(storedRecords(text).at(-1), "message.content");
				const liveContent = valueAt(manager.getEntries().at(-1), "message.content");
				expect({
					leaked: leakedFields(text),
					storedBlocks: Array.isArray(content) ? content.length : -1,
					serverToolLeft:
						Array.isArray(content) &&
						content.some(block => isRecord(block) && block.type === "anthropicServerTool"),
					liveBlocks: Array.isArray(liveContent) ? liveContent.length : -1,
				}).toEqual({ leaked: [], storedBlocks: 2, serverToolLeft: false, liveBlocks: 4 });
				await manager.close();
			});
		}

		for (const form of STORED_FORM_DETAILS) {
			it(`masks a value a tool result's details hold as ${form.name}, in the form the session line stores it`, async () => {
				const formMask = new storeMask.SessionStoreMasker({
					env: () => ({ SERVICE_API_KEY: ENV_VALUE, SERVICE_NUMBER_TOKEN: NUMBER_VALUE }),
					agentDir: tmp.join("agent"),
				}).snapshot(cwd);
				const manager = await maskedSession(formMask);
				const detail = form.detail();
				manager.appendMessage(
					assistant([{ type: "toolCall", id: "call-form", name: "lookup", arguments: {} }], {
						stopReason: "toolUse",
					}),
				);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "call-form",
					toolName: "lookup",
					content: [{ type: "text", text: "plain" }],
					details: { report: detail },
					isError: false,
					timestamp: NOW,
				});
				const text = await storedText(manager);
				const stored = valueAt(storedRecords(text).at(-1), "message.details.report");
				expect({
					form: form.name,
					held: text.includes(form.value),
					storedMasked: JSON.stringify(stored) === JSON.stringify(form.masked),
					liveKeepsIt: valueAt(manager.getEntries().at(-1), "message.details.report") === detail,
				}).toEqual({ form: form.name, held: false, storedMasked: true, liveKeepsIt: true });
				await manager.close();
			});
		}

		for (const { place, append, toolChanges } of COMPACTION_TOOL_CHANGE_PLACES) {
			it(`KR8: keeps the raw toolChanges of ${place} byte-identical, opaque whole, under a regex that matches a tool name`, async () => {
				const manager = await maskedSession(await regexMask(tmp.join("agent"), cwd, CHANGED_TOOL_REGEX));
				const changes = [
					{
						type: "tool_addition",
						tool: { type: "tool_reference", name: CHANGED_TOOL },
						opaque: { cursor: CHANGED_TOOL, after: [CHANGED_TOOL], depth: 2 },
					},
					{ type: "tool_removal", tool: { type: "tool_reference", name: "plain-removed-tool" }, opaque: {} },
				];
				append(manager, changes);
				const stored = valueAt(storedRecords(await storedText(manager)).at(-1), toolChanges);
				expect({ place, asWritten: JSON.stringify(stored) === JSON.stringify(changes) }).toEqual({
					place,
					asWritten: true,
				});
				await manager.close();
			});

			for (const { name, element } of UNKEPT_TOOL_CHANGES) {
				it(`KR8: leaves out ${place} whose toolChanges element holds a tool name in ${name}`, async () => {
					const manager = await maskedSession(await regexMask(tmp.join("agent"), cwd, CHANGED_TOOL_REGEX));
					append(manager, [element]);
					const text = await storedText(manager);
					const carrier = toolChanges.split(".").slice(0, -1);
					const key = carrier.pop() ?? "";
					const parent = valueAt(storedRecords(text).at(-1), carrier.join("."));
					expect({
						place,
						name,
						leftOut: isRecord(parent) && !Object.hasOwn(parent, key),
						stored: text.includes(CHANGED_TOOL),
					}).toEqual({ place, name, leftOut: true, stored: false });
					await manager.close();
				});
			}
		}

		for (const { name, block, keeps } of SERVER_TOOL_ELEMENT_CASES) {
			it(`KR8: ${name} ${keeps ? "keeps its field as written" : "keeps nothing"}`, async () => {
				const manager = await maskedSession(await regexMask(tmp.join("agent"), cwd, SERVER_CIPHER));
				manager.appendMessage(
					assistantRecord([
						{ type: "text", text: "plain before" },
						{
							type: "anthropicServerTool",
							block: {
								type: "server_tool_use",
								id: "srvtoolu_plain",
								name: "web_search",
								input: { query: "plain" },
							},
						},
						{ type: "anthropicServerTool", block },
					]) as unknown as AssistantMessage,
				);
				const text = await storedText(manager);
				const content = valueAt(storedRecords(text).at(-1), "message.content");
				expect({
					name,
					serverToolLeft:
						Array.isArray(content) && content.some(item => isRecord(item) && item.type === "anthropicServerTool"),
					cipherStored: text.includes(SERVER_CIPHER),
				}).toEqual({ name, serverToolLeft: keeps, cipherStored: keeps });
				await manager.close();
			});
		}

		it("KR9: resumes a session whose snapcompact slot was left out from its compaction summary", async () => {
			const manager = await maskedSession(mask);
			const userId = manager.appendMessage({ role: "user", content: "plain question", timestamp: NOW });
			manager.appendCompaction("plain compaction summary", undefined, userId, 1, {
				preserveData: {
					snapcompact: {
						frames: [{ data: "iVBORw0KGgoPlainFrame", mimeType: "image/png", cols: 1, rows: 1, chars: 1 }],
						totalChars: 1,
						truncatedChars: 0,
						text: HELD,
					},
				},
			});
			manager.appendMessage({ role: "user", content: "plain follow-up", timestamp: NOW });
			const text = await storedText(manager);
			const file = sessionFileOf(manager);
			await manager.close();

			const reopened = await SessionManager.open(file, store.sessionDir, await store.reopen());
			const compaction = reopened.getEntries().find(entry => entry.type === "compaction");
			const messages = reopened.buildSessionContext().messages;
			expect({
				leaked: leakedFields(text),
				slotLeftOut: compaction?.type === "compaction" && compaction.preserveData?.snapcompact === undefined,
				resumesFromSummary: messages.some(
					message => message.role === "compactionSummary" && message.summary === "plain compaction summary",
				),
				keepsFollowUp: messages.some(message => message.role === "user" && message.content === "plain follow-up"),
			}).toEqual({ leaked: [], slotLeftOut: true, resumesFromSummary: true, keepsFollowUp: true });
			await reopened.close();
		});

		it("KR12: masks a resumed session again on its rewrite without nesting markers under a broad regex", async () => {
			const manager = await maskedSession(await regexMask(tmp.join("agent"), cwd, "[A-Za-z0-9_]{8,}"));
			manager.appendMessage({ role: "user", content: `${ENV_VALUE} and identifier_long_word`, timestamp: NOW });
			const first = await storedText(manager);
			const file = sessionFileOf(manager);
			await manager.close();

			// The resumed session holds the stored markers; its rewrite masks them again.
			const reopenedStorage = await store.reopen();
			const reopened = await SessionManager.open(file, store.sessionDir, reopenedStorage);
			await reopened.rewriteEntries();
			await settle(reopened, reopenedStorage);
			const second = await reopenedStorage.readText(file);
			await reopened.close();
			expect({
				leaked: leakedFields(first),
				nested: first.includes("[[REDACTED:") || second.includes("[[REDACTED:"),
				identicalAfterRewrite: second === first,
			}).toEqual({ leaked: [], nested: false, identicalAfterRewrite: true });
		});

		it("KR13: keeps object keys, numbers, booleans and null under a regex that matches their text", async () => {
			const manager = await maskedSession(await regexMask(tmp.join("agent"), cwd, "keepkey[a-z]+|48210017"));
			const data = { keepkeycount: 48210017, keepkeyflag: true, keepkeynone: null, keepkeytext: "48210017" };
			manager.appendCustomEntry("plain-by-type", { nested: data });
			manager.appendMessage(
				assistantRecord([
					{ type: "toolCall", id: "call-by-type", name: "lookup", arguments: data },
				]) as unknown as AssistantMessage,
			);
			const records = storedRecords(await storedText(manager));
			const stored = [
				{ where: "a custom entry's data", value: valueAt(records.at(-2), "data.nested") },
				{ where: "a tool call's arguments", value: valueAt(records.at(-1), "message.content.0.arguments") },
			];
			expect(
				stored.map(({ where, value }) => ({
					where,
					keys: isRecord(value) && Object.keys(value).join() === Object.keys(data).join(),
					byType:
						isRecord(value) &&
						value.keepkeycount === 48210017 &&
						value.keepkeyflag === true &&
						value.keepkeynone === null,
					stringMasked: isRecord(value) && value.keepkeytext === REGEX_MARKER,
				})),
			).toEqual(stored.map(({ where }) => ({ where, keys: true, byType: true, stringMasked: true })));
			await manager.close();
		});
	});
}

describe("keep rules hold only in the shape the list names", () => {
	const at = (type: string, fields: Record<string, unknown>) => ({
		type,
		id: "shape-entry",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		...fields,
	});
	const inMessage = (message: Record<string, unknown>) => at("message", { message });
	const replay = (fields: Record<string, unknown>) =>
		inMessage({ ...assistant([]), ...fields } as unknown as Record<string, unknown>);
	const serverTool = (element: Record<string, unknown>) =>
		replay({
			content: [
				{
					type: "anthropicServerTool",
					block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [element] },
				},
			],
		});
	// Each record puts a held value where the list keeps a field, but in another shape or on
	// another element type than the one the list names; the stored copy must not hold the value.
	const cases: Array<[string, unknown]> = [
		["a kept string field written as an array (label id)", at("label", { targetId: "t", id: [ENV_VALUE] })],
		[
			"a kept string field written as an array (tool call name)",
			replay({ content: [{ type: "toolCall", id: "call-s", name: [ENV_VALUE], arguments: {} }] }),
		],
		[
			"an object position written as an array (runtime)",
			at("label", { targetId: "t", runtime: [{ version: ENV_VALUE }] }),
		],
		[
			"an array-item position written as one object (user content)",
			inMessage({ role: "user", timestamp: 1, content: { type: "image", data: ENV_VALUE, mimeType: "image/png" } }),
		],
		[
			"a carrier's kept string field written as an array (Responses call_id)",
			replay({
				providerPayload: {
					type: "openaiResponsesHistory",
					provider: "openai",
					items: [{ type: "function_call", call_id: [ENV_VALUE] }],
				},
			}),
		],
		[
			"encrypted_content on a server-tool error element",
			serverTool({ type: "web_search_tool_result_error", encrypted_content: ENV_VALUE }),
		],
		["error_code on a server-tool result element", serverTool({ type: "web_search_result", error_code: ENV_VALUE })],
	];
	for (const [name, record] of cases) {
		it(`masks ${name}`, () => {
			expect({ name, held: JSON.stringify(maskSessionEntry(record, mask)).includes(ENV_VALUE) }).toEqual({
				name,
				held: false,
			});
		});
	}

	it("masks a held value in a tool result detail that is a URL object, as the session file stores it", async () => {
		maskWrites();
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(cwd, tmp.join("sessions"), storage);
		await manager.ensureOnDisk();
		manager.appendMessage(
			assistant([{ type: "toolCall", id: "call-u", name: "fetch", arguments: {} }], { stopReason: "toolUse" }),
		);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call-u",
			toolName: "fetch",
			content: [{ type: "text", text: "fetched" }],
			details: { link: new URL(`https://example.invalid/page?ref=${ENV_VALUE}`) },
			isError: false,
			timestamp: NOW,
		});
		await manager.flush();
		await storage.drain();
		const file = manager.getSessionFile();
		if (!file) throw new Error("Expected a session file");
		expect((await storage.readText(file)).includes(ENV_VALUE)).toBe(false);
		await manager.close();
	});
});
