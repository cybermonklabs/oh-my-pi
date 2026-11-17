/**
 * Contract: with `secrets.maskSessionStore` on, the selective-commit journal of a session
 * (`changes.jsonl` and its blobs, in the artifacts directory) holds no held value. The command text
 * of a shell call holds the marker, and a file snapshot that masking would change is not stored
 * (`undefined`, as an oversized one), since `/commit` needs each snapshot byte for byte. With the
 * setting off, the journal holds the values. Drives a real `createAgentSession` with the real bash
 * and write tools and pi-ai's mock model.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	type CallRecord,
	type ChangeRecord,
	ChangeJournal,
	type JournalRecord,
} from "@oh-my-pi/pi-coding-agent/commit/selective/journal";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const HELD_VALUE = "zq9-synthetic-journal-7315";
const MARKER = "[REDACTED:env:SERVICE_API_KEY]";
/** The first `createAgentSession` in a process loads most of the agent. */
const CASE_TIMEOUT_MS = 30_000;

let tmp: TempDir;
let cwd: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tmp = TempDir.createSync("@omp-session-store-masking-journal-");
	cwd = tmp.join("project");
	await fs.mkdir(cwd, { recursive: true });
	resetSettingsForTest();
	// The bash executor reads the global settings; keep them off the developer's config.
	await Settings.init({ inMemory: true, cwd });
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("openai", "test-key");
	// The process masker holds the test's variable, never this machine's environment.
	spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
		new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: HELD_VALUE }), agentDir: tmp.join("agent") }),
	);
});

afterEach(async () => {
	vi.restoreAllMocks();
	authStorage.close();
	resetSettingsForTest();
	await tmp.remove();
});

function call(id: string, name: string, args: Record<string, unknown>): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

interface Run {
	journal: ChangeJournal;
	records: JournalRecord[];
	/** `changes.jsonl` as written. */
	text: string;
	/** The content of every blob the journal stored. */
	blobs: string[];
}

/**
 * One prompt: the model runs `echo <held value>`, writes `held.txt` with the value and writes it
 * again with other text that holds it, then writes `plain.txt` with no value.
 */
async function runSession(maskSessionStore: boolean): Promise<Run> {
	const storage = new FileSessionStorage();
	const { session } = await createAgentSession({
		cwd,
		agentDir: tmp.join("agent"),
		modelRegistry: new ModelRegistry(authStorage, tmp.join("models.yml")),
		sessionManager: SessionManager.create(cwd, tmp.join("sessions"), storage),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"secrets.maskSessionStore": maskSessionStore,
		}),
		model: getBundledModel("openai", "gpt-4o-mini"),
		toolNames: ["bash", "write"],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		cacheWarming: false,
		rules: [],
		workspaceTree: { rootPath: cwd, rendered: "project/", truncated: false, totalLines: 1, agentsMdFiles: [] },
	});
	try {
		session.agent.streamFn = createMockModel({
			responses: [
				call("call-echo", "bash", { command: `echo ${HELD_VALUE}` }),
				call("call-write-held", "write", { path: "held.txt", content: `key=${HELD_VALUE}\n` }),
				call("call-rewrite-held", "write", { path: "held.txt", content: `key=${HELD_VALUE}\nmode=prod\n` }),
				call("call-write-plain", "write", { path: "plain.txt", content: "plain\n" }),
				{ content: ["done"] },
			],
		}).stream;
		await session.prompt("echo the key and write the files");
		const dir = session.sessionManager.getArtifactsDir();
		if (!dir) throw new Error("Expected an artifacts directory");
		const journal = ChangeJournal.at(dir);
		const records = await journal.read();
		const blobDir = path.join(dir, "blobs");
		const blobs: string[] = [];
		for (const name of await fs.readdir(blobDir)) {
			blobs.push(new TextDecoder().decode(Bun.gunzipSync(await fs.readFile(path.join(blobDir, name)))));
		}
		return { journal, records, text: await Bun.file(path.join(dir, "changes.jsonl")).text(), blobs };
	} finally {
		await session.dispose();
		await storage.drain();
	}
}

function shellCall(records: readonly JournalRecord[]): CallRecord {
	const found = records.find((record): record is CallRecord => record.type === "call" && record.tool === "bash");
	if (!found) throw new Error("No bash call record");
	return found;
}

function changesOf(records: readonly JournalRecord[], file: string): ChangeRecord[] {
	return records.filter(
		(record): record is ChangeRecord => record.type === "change" && path.basename(record.path) === file,
	);
}

describe("session store masking of the selective-commit journal", () => {
	it(
		"records the marker for a shell call and leaves out each file snapshot that holds the value",
		async () => {
			const run = await runSession(true);

			// Booleans only, so a failure does not print the value.
			expect({
				journal: run.text.includes(HELD_VALUE),
				blobs: run.blobs.some(blob => blob.includes(HELD_VALUE)),
			}).toEqual({ journal: false, blobs: false });

			const echo = shellCall(run.records);
			expect({ label: echo.label, script: echo.script }).toEqual({
				label: `echo ${MARKER}`,
				script: `echo ${MARKER}`,
			});

			// Not stored, as an oversized snapshot: `/commit` treats the file as one it did not record.
			const held = changesOf(run.records, "held.txt");
			expect(held.map(record => ({ before: record.before, after: record.after }))).toEqual([
				{ before: null, after: undefined },
				{ before: undefined, after: undefined },
			]);

			// A snapshot with no value is stored as written.
			const plain = changesOf(run.records, "plain.txt");
			expect(plain).toHaveLength(1);
			expect(plain[0].before).toBeNull();
			const plainBlob = plain[0].after;
			if (typeof plainBlob !== "string") throw new Error("Expected a stored plain.txt snapshot");
			expect(await run.journal.blob(plainBlob)).toBe("plain\n");
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"records the value while the session's setting is off",
		async () => {
			const run = await runSession(false);

			const echo = shellCall(run.records);
			expect({
				label: echo.label.includes(HELD_VALUE),
				script: echo.script?.includes(HELD_VALUE),
			}).toEqual({ label: true, script: true });

			const held = changesOf(run.records, "held.txt");
			expect(held).toHaveLength(2);
			const stored = held[1].after;
			if (typeof stored !== "string") throw new Error("Expected a stored held.txt snapshot");
			expect((await run.journal.blob(stored))?.includes(HELD_VALUE)).toBe(true);
		},
		CASE_TIMEOUT_MS,
	);
});
