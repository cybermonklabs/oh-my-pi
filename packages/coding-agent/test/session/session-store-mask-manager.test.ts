/**
 * Contract: with session store masking on, every write `SessionManager` and the
 * collab guest make to a session store holds a marker in place of each held
 * secret value — entries, header, title slot, title field, draft, replica,
 * the title and recaps in history.db — while the live in-memory session keeps
 * the real values. Provider replay state is never stored half-masked: a
 * changed signed block loses its signature, a changed carrier is dropped, and
 * ciphertext, images and ids are kept byte for byte. Each session file case
 * runs against every session store backend; history.db is written for file
 * storage only.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	closeSessionIndex,
	listSessionRecaps,
	lookupSessionTitle,
} from "@oh-my-pi/pi-coding-agent/session/session-index";
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
	storeMask.setSessionStoreMasking(false);
	await tmp.remove();
});

/** Every session writer gets the test's mask, as when the setting is on. */
function maskWrites(): void {
	spyOn(storeMask, "sessionStoreMaskFor").mockReturnValue(mask);
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

		it("stores values as written while the setting is at its default", async () => {
			const manager = await onDisk();
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

	it("records the title and the recap as written while the setting is off", async () => {
		const release = bindEffects(Settings.isolated({ "secrets.maskSessionStore": false }));
		try {
			const manager = await fileSession();
			await manager.setSessionName(said(ENV_VALUE), "user");
			manager.recordRecap(said(FILE_VALUE));

			const id = manager.getSessionId();
			expect(lookupSessionTitle(id)).toBe(said(ENV_VALUE));
			expect(listSessionRecaps({ sessionIds: [id] }).map(entry => entry.recap)).toEqual([said(FILE_VALUE)]);
			await manager.close();
		} finally {
			release();
		}
	});
});

describe("session store masking switch", () => {
	it("hands writers a mask only while masking is on, driven by secrets.maskSessionStore", () => {
		// The process masker reads only the test's directories, never this machine's environment.
		spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
			new storeMask.SessionStoreMasker({ env: () => ({}), agentDir: tmp.join("agent") }),
		);
		expect(storeMask.sessionStoreMaskFor(cwd)).toBeNull();
		storeMask.setSessionStoreMasking(true);
		expect(storeMask.sessionStoreMaskFor(cwd)).toBeInstanceOf(storeMask.SessionStoreMask);
		storeMask.setSessionStoreMasking(false);
		expect(storeMask.sessionStoreMaskFor(cwd)).toBeNull();

		const release = bindEffects(Settings.isolated({ "secrets.maskSessionStore": true }));
		try {
			expect(storeMask.sessionStoreMaskFor(cwd)).toBeInstanceOf(storeMask.SessionStoreMask);
		} finally {
			release();
		}
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
		const manager = SessionManager.create(cwd, tmp.join("sessions"), storage);
		await manager.ensureOnDisk();

		manager.appendMessage({ role: "user", content: said(FILE_VALUE), timestamp: NOW });
		await settle(manager, storage);
		expect(build).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalledWith(tokenFile, expect.anything());
		expect(open).not.toHaveBeenCalledWith(tokenFile, expect.anything());

		// Turned on mid-session: the same manager's next write builds the masker, reads the file and masks.
		storeMask.setSessionStoreMasking(true);
		manager.appendMessage({ role: "user", content: said(FILE_VALUE), timestamp: NOW });
		await settle(manager, storage);
		expect(build).toHaveBeenCalled();
		expect(stat).toHaveBeenCalledWith(tokenFile, expect.anything());
		expect(open).toHaveBeenCalledWith(tokenFile, expect.anything());
		const stored = storedRecords(await storage.readText(sessionFileOf(manager))).map(
			record => messageOf(record).content,
		);
		expect(stored).toEqual([said(FILE_VALUE), said(FILE_MARKER)]);
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
		settings: Settings.isolated(),
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
		maskWrites();
		// The guest writes its replica under the config root; keep it in the test's temp dir.
		spyOn(utils, "getConfigRootDir").mockReturnValue(tmp.path());
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
