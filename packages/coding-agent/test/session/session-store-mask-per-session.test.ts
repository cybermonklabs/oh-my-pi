/**
 * Contract: `secrets.maskSessionStore` applies per session. Two top-level sessions
 * in one process, each made by `createAgentSession` with its own settings, one with
 * the setting on and one with it off, store the same held value: whichever session
 * opened first, the session with the setting on stores the marker and no value,
 * and the session with it off stores the value.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";

const HELD_VALUE = "zq9-synthetic-service-4821";
const MARKER = "[REDACTED:env:SERVICE_API_KEY]";
/** Listed only in the secrets.yml of one session's own agent dir (`createAgentSession`'s `agentDir`). */
const AGENT_DIR_VALUE = "kx7-synthetic-agent-dir-3958";
const NOW = 1_700_000_000_000;
/** The first `createAgentSession` in a process loads most of the agent, and each case opens two sessions. */
const CASE_TIMEOUT_MS = 30_000;

interface OpenSession {
	session: AgentSession;
	storage: FileSessionStorage;
}

let authDir: TempDir;
let modelRegistry: ModelRegistry;
let tmp: TempDir;
const opened: AgentSession[] = [];

beforeAll(async () => {
	authDir = TempDir.createSync("@omp-session-store-masking-per-session-auth-");
	modelRegistry = new ModelRegistry(await discoverAuthStorage(authDir.path()));
});

afterAll(async () => {
	modelRegistry.authStorage.close();
	await authDir.remove();
});

beforeEach(() => {
	tmp = TempDir.createSync("@omp-session-store-masking-per-session-");
	// The process masker holds the test's variable in a fresh agent dir, never this machine's environment.
	spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
		new storeMask.SessionStoreMasker({ env: () => ({ SERVICE_API_KEY: HELD_VALUE }), agentDir: tmp.join("agent") }),
	);
});

afterEach(async () => {
	for (const session of opened.splice(0)) await session.dispose();
	vi.restoreAllMocks();
	await tmp.remove();
});

/** A top-level session in its own project, with its own file-storage session and settings. */
async function openSession(name: string, maskSessionStore: boolean): Promise<OpenSession> {
	const cwd = tmp.join(name, "project");
	await fs.mkdir(cwd, { recursive: true });
	const storage = new FileSessionStorage();
	const { session } = await createAgentSession({
		cwd,
		agentDir: tmp.join(name, "agent"),
		modelRegistry,
		sessionManager: SessionManager.create(cwd, tmp.join(name, "sessions"), storage),
		settings: Settings.isolated({ "secrets.maskSessionStore": maskSessionStore }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: cwd, rendered: "project/", truncated: false, totalLines: 1, agentsMdFiles: [] },
	});
	opened.push(session);
	return { session, storage };
}

/** Appends a user message holding the held value; returns its line as the session store holds it. */
async function storeHeldValue({ session, storage }: OpenSession): Promise<string> {
	const manager = session.sessionManager;
	await manager.ensureOnDisk();
	manager.appendMessage({ role: "user", content: `deploy with ${HELD_VALUE}`, timestamp: NOW });
	await manager.flush();
	await storage.drain();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Expected a session file");
	const line = (await storage.readText(file))
		.split("\n")
		.find(text => text.trim() !== "" && isUserMessage(JSON.parse(text)));
	if (line === undefined) throw new Error("No stored user message");
	return line;
}

function isUserMessage(record: unknown): boolean {
	return isRecord(record) && record.type === "message" && isRecord(record.message) && record.message.role === "user";
}

/** What a stored line holds, as booleans, so a failure names the session without printing the value. */
function holds(session: string, line: string): { session: string; marker: boolean; value: boolean } {
	return { session, marker: line.includes(MARKER), value: line.includes(HELD_VALUE) };
}

describe("secrets.maskSessionStore per session", () => {
	for (const onFirst of [true, false]) {
		it(
			`masks the stored entry of the session with the setting on, opened ${onFirst ? "first" : "second"}, and only that one`,
			async () => {
				const first = await openSession("first", onFirst);
				const second = await openSession("second", !onFirst);

				const firstLine = await storeHeldValue(first);
				const secondLine = await storeHeldValue(second);

				const masked = { marker: true, value: false };
				const unmasked = { marker: false, value: true };
				expect(holds("opened first", firstLine)).toEqual({
					session: "opened first",
					...(onFirst ? masked : unmasked),
				});
				expect(holds("opened second", secondLine)).toEqual({
					session: "opened second",
					...(onFirst ? unmasked : masked),
				});
			},
			CASE_TIMEOUT_MS,
		);
	}
});

describe("secrets.maskSessionStore with a session's own agent dir", () => {
	it(
		"masks a value that only the secrets.yml of the session's agent dir lists",
		async () => {
			// The real process masker: the session's agent dir is not the process agent dir.
			vi.restoreAllMocks();
			await Bun.write(tmp.join("own", "agent", "secrets.yml"), `- type: plain\n  content: "${AGENT_DIR_VALUE}"\n`);
			const { session, storage } = await openSession("own", true);
			const manager = session.sessionManager;
			await manager.ensureOnDisk();
			manager.appendMessage({ role: "user", content: `deploy with ${AGENT_DIR_VALUE}`, timestamp: NOW });
			await manager.flush();
			await storage.drain();
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected a session file");
			const stored = await storage.readText(file);
			expect({
				value: stored.includes(AGENT_DIR_VALUE),
				marker: stored.includes("[REDACTED:secrets.yml:"),
			}).toEqual({ value: false, marker: true });
		},
		CASE_TIMEOUT_MS,
	);
});
