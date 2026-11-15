import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { invalidateMessageCache } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type {
	BankProfileResponse,
	CreateBankOptions,
	RetainOptions,
	RetainResponse,
} from "@oh-my-pi/pi-coding-agent/hindsight/client";
import { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { prepareRetentionTranscript, sliceLastTurnsByUserBoundary } from "@oh-my-pi/pi-coding-agent/hindsight/content";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import { countUserTurns, extractLastTurns, extractMessages } from "@oh-my-pi/pi-coding-agent/hindsight/transcript";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value a cold entry keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/** Turns before the cut: their 12 cold entries outnumber the records a cold store keeps parsed. */
const OLDER_TURNS = 6;
const KEPT = OLDER_TURNS + 1;
const NEWEST = OLDER_TURNS + 2;

/** `OLDER_TURNS` turns before the cut of `c1` (cold), one turn it keeps, one after it. */
async function writeSession(dir: string): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	const ids: string[] = [];
	for (let turn = 1; turn <= OLDER_TURNS; turn++) ids.push(`u${turn}`, `a${turn}`);
	ids.push(`u${KEPT}`, "c1", `a${KEPT}`, `u${NEWEST}`, `a${NEWEST}`);
	const entries = ids.map((id, index) => {
		const parentId = index === 0 ? null : ids[index - 1]!;
		if (id === "c1") {
			return {
				type: "compaction",
				id,
				parentId,
				timestamp: TIMESTAMP,
				summary: `c1 ${BODY}`,
				firstKeptEntryId: `u${KEPT}`,
				tokensBefore: 1000,
			};
		}
		const message = id.startsWith("u")
			? { role: "user", content: `${id} ${BODY}`, timestamp: 1 }
			: assistant(`${id} ${BODY}`);
		return { type: "message", id, parentId, timestamp: TIMESTAMP, message };
	});
	await Bun.write(file, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

function open(file: string, coldStore: boolean): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true, coldStore });
}

class FakeHindsightApi extends HindsightApi {
	transcripts: string[] = [];

	constructor() {
		super({ baseUrl: "http://localhost" });
	}

	override async createBank(_bankId: string, _options?: CreateBankOptions): Promise<BankProfileResponse> {
		return {};
	}

	override async retain(_bankId: string, transcript: string, _options?: RetainOptions): Promise<RetainResponse> {
		this.transcripts.push(transcript);
		return {};
	}
}

function config(overrides: Partial<HindsightConfig>): HindsightConfig {
	return {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		globalScope: false,
		bankMission: "",
		retainMission: null,
		autoRecall: false,
		autoRetain: true,
		retainMode: "full-session",
		retainEveryNTurns: 1,
		retainOverlapTurns: 0,
		retainContext: "omp",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: ["world", "experience"],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 30_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 30_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
		...overrides,
	};
}

/** The transcript a full-session retain sends for every message of `sessionManager`. */
function wholeTranscript(sessionManager: SessionManager): string | null {
	return prepareRetentionTranscript(extractMessages(sessionManager), true, { includeTimestamps: true }).transcript;
}

describe("Hindsight per-turn reads of a session whose older bodies are cold", () => {
	it("counts user turns as a manager holding every entry does, reading each older body once", async () => {
		using dir = TempDir.createSync("@omp-hindsight-cold-");
		const file = await writeSession(dir.path());
		const cold = await open(file, true);
		const whole = await open(file, false);
		expect(cold.coldStoreStats().coldEntries).toBe(OLDER_TURNS * 2);

		expect(countUserTurns(cold)).toBe(countUserTurns(whole));
		// Reading the older answers pushes the older questions out of the store's few parsed records.
		for (let turn = 1; turn <= OLDER_TURNS; turn++) expect(JSON.stringify(cold.getEntry(`a${turn}`))).toContain(BODY);
		const beforeSecondCount = cold.coldStoreStats().materializations;
		expect(countUserTurns(cold)).toBe(NEWEST);
		expect(cold.coldStoreStats().materializations).toBe(beforeSecondCount);
	});

	it("slices the last turns from the newest entries only", async () => {
		using dir = TempDir.createSync("@omp-hindsight-cold-");
		const file = await writeSession(dir.path());
		const cold = await open(file, true);
		const whole = await open(file, false);

		const lastTurns = extractLastTurns(cold, 2);
		expect(lastTurns.map(message => message.content.split(" ")[0])).toEqual([
			`u${KEPT}`,
			`a${KEPT}`,
			`u${NEWEST}`,
			`a${NEWEST}`,
		]);
		expect(lastTurns).toEqual(sliceLastTurnsByUserBoundary(extractMessages(whole), 2));
		expect(cold.coldStoreStats().materializations).toBe(0);
	});

	it("retains the whole session from the messages after the last retained entry, rebuilding after an in-place rewrite", async () => {
		using dir = TempDir.createSync("@omp-hindsight-cold-");
		const cold = await open(await writeSession(dir.path()), true);
		const client = new FakeHindsightApi();
		const state = new HindsightSessionState({
			sessionId: "cold-session",
			client,
			bankId: "bank",
			config: config({}),
			session: { sessionManager: cold } as object as AgentSession,
			banksSet: new Set<string>(),
			agentDir: dir.path(),
		});

		await state.maybeRetainOnAgentEnd();
		expect(client.transcripts.at(-1)).toBe(wholeTranscript(cold)!);

		cold.appendMessage({ role: "user", content: `u-next ${BODY}`, timestamp: 5 });
		cold.appendMessage(assistant(`a-next ${BODY}`));
		const materializations = cold.coldStoreStats().materializations;
		await state.maybeRetainOnAgentEnd();
		expect(cold.coldStoreStats().materializations).toBe(materializations);
		expect(client.transcripts.at(-1)).toBe(wholeTranscript(cold)!);

		// A message already retained is rewritten in place (as an elide does): the next retain starts over.
		const kept = cold.getEntry(`a${KEPT}`);
		if (kept?.type !== "message" || kept.message.role !== "assistant") throw new Error("kept answer missing");
		kept.message.content = [{ type: "text", text: "kept answer rewritten" }];
		invalidateMessageCache(kept.message);
		cold.appendMessage({ role: "user", content: "u-last", timestamp: 6 });
		await state.maybeRetainOnAgentEnd();
		expect(client.transcripts.at(-1)).toContain("kept answer rewritten");
		expect(client.transcripts.at(-1)).toBe(wholeTranscript(cold)!);
	});
});
