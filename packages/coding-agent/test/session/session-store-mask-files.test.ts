/**
 * Contract: `secrets.maskSessionStore` also covers the session files outside the session
 * store. With the session's setting on, the `/btw` history record (its question, answer and
 * follow-up) and its title sidecar, and the subagent output files `agent://<id>` serves
 * (`<id>.md` and `<id>.json`, after the first run and after a later turn rewrites them), hold
 * the marker and no held value, while the live `/btw` record keeps the value and the store's
 * next write raises no conflict. The output files hold a multi-line held value as JSON text,
 * escaped: with the setting on they hold its marker and neither the value nor its escaped form.
 * With the setting off, every file holds the value.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Context } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, type MockResponse, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as storeMask from "@oh-my-pi/pi-coding-agent/secrets/session-store-mask";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type BtwHistoryRecord, BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubagentFollowUpTurn, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { restoreEnvValue } from "../helpers/settings-test-state";

const HELD_VALUE = "zq9-synthetic-service-4821";
const MARKER = "[REDACTED:env:SERVICE_API_KEY]";
/** A `_FILE` value with an inner newline and a quote: JSON text holds it only escaped. */
const MULTI_LINE_VALUE = 'first line of the "held" file\nsecond line of the held file';
const ESCAPED_MULTI_LINE_VALUE = JSON.stringify(MULTI_LINE_VALUE).slice(1, -1);
const FILE_MARKER = "[REDACTED:file:SERVICE_KEY_FILE]";
const NOW = 1_700_000_000_000;
const AGENT_ID = "Reporter";
const AGENT: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	tools: ["read"],
	source: "bundled",
};
/** A schema-bearing run writes its yield data to the `<id>.json` sidecar. */
const OUTPUT_SCHEMA = {
	type: "object",
	properties: { id: { type: "string" }, report: { type: "string" } },
	required: ["id", "report"],
};
const LATER_MESSAGE = "Report again.";
const LATER_TURN = "LATER_TURN_REPORT";
const MOCK_API_SOURCE = "test/session-store-masking-files";
/** A subagent case loads the executor and a session, then runs two turns. */
const CASE_TIMEOUT_MS = 30_000;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let tmp: TempDir;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	tmp = TempDir.createSync("@omp-session-store-masking-files-");
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	const home = tmp.join("home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
	// The process masker holds the test's variable and file in a fresh agent dir, never this machine's environment.
	const keyFile = tmp.join("held-key.txt");
	await Bun.write(keyFile, `${MULTI_LINE_VALUE}\n`);
	const env = { SERVICE_API_KEY: HELD_VALUE, SERVICE_KEY_FILE: keyFile };
	spyOn(storeMask, "processSessionStoreMasker").mockReturnValue(
		new storeMask.SessionStoreMasker({ env: () => env, agentDir: tmp.join("agent") }),
	);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await tmp.remove();
});

interface Holds {
	file: string;
	marker: boolean;
	value: boolean;
}

/** What a text holds, as booleans, so a failure names it without printing the value. */
function holds(file: string, text: string | undefined): Holds {
	return { file, marker: text?.includes(MARKER) === true, value: text?.includes(HELD_VALUE) === true };
}

/** A masked text holds the marker and no value; an unmasked one the value and no marker. */
function stored(file: string, masked: boolean): Holds {
	return { file, marker: masked, value: !masked };
}

interface MultiLineHolds {
	file: string;
	marker: boolean;
	value: boolean;
	escaped: boolean;
}

/** What a JSON text holds of the multi-line value: its marker, the value as written, its escaped form. */
function holdsMultiLine(file: string, text: string): MultiLineHolds {
	return {
		file,
		marker: text.includes(FILE_MARKER),
		value: text.includes(MULTI_LINE_VALUE),
		escaped: text.includes(ESCAPED_MULTI_LINE_VALUE),
	};
}

/** A masked JSON text holds the marker alone; an unmasked one the escaped form alone. */
function storedMultiLine(file: string, masked: boolean): MultiLineHolds {
	return { file, marker: masked, value: false, escaped: !masked };
}

/**
 * A titled topic with the held value in its question, answer and follow-up, checkpointed
 * running then complete as `/btw` does, through a store opened with its session's mask.
 */
async function writeBtwTopic(maskOn: boolean): Promise<{ store: BtwHistoryStore; historyDir: string }> {
	const cwd = tmp.join("btw", "project");
	await fs.mkdir(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, tmp.join("btw", "sessions"));
	manager.setStoreMasking(() => maskOn);
	await manager.ensureOnDisk();
	const artifactsDir = manager.getArtifactsDir();
	if (!artifactsDir) throw new Error("Expected a persisted session");
	const store = await BtwHistoryStore.open(artifactsDir, { storeMask: () => manager.storeMask() });
	const running: BtwHistoryRecord = {
		id: "topic",
		leafId: manager.getLeafId(),
		title: `/sitrep ${HELD_VALUE}`,
		question: `Which key deploys? ${HELD_VALUE}`,
		answer: "",
		status: "running",
		createdAt: NOW,
		updatedAt: NOW,
	};
	await store.upsert(running);
	// Each later write checks the bytes on disk against the revision the store hashed.
	const complete: BtwHistoryRecord = { ...running, answer: `The key is ${HELD_VALUE}`, status: "complete" };
	await store.upsert(complete);
	await store.upsert({
		...complete,
		followUps: [
			{
				question: `And for staging? ${HELD_VALUE}`,
				answer: `Staging uses ${HELD_VALUE} too`,
				status: "complete",
				createdAt: NOW + 1,
				updatedAt: NOW + 1,
			},
		],
	});
	await store.flush();
	await manager.close();
	return { store, historyDir: path.join(artifactsDir, "btw-history") };
}

interface OutputFiles {
	md: string;
	json: string;
}

async function readOutputFiles(artifactsDir: string): Promise<OutputFiles> {
	return {
		md: await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text(),
		json: await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text(),
	};
}

/** Yields `{ id, report }`, both holding the held value; the report names the turn and holds the multi-line value. */
function respond(context: Context): MockResponse {
	if (context.messages.at(-1)?.role === "toolResult") return { content: ["ok"] };
	const label = JSON.stringify(context.messages).includes(LATER_MESSAGE) ? LATER_TURN : "FIRST_RUN_REPORT";
	// `id` is kept as written only on a session entry; in yield data it is the model's text.
	const data = { id: HELD_VALUE, report: `${label}: deploy with ${HELD_VALUE} after ${MULTI_LINE_VALUE}` };
	return { content: [{ type: "toolCall", id: `yield-${label}`, name: "yield", arguments: { type: "result", data } }] };
}

/** A structured subagent run on pi-ai's mock model, then a later turn that yields again. */
async function runSubagentTwice(maskOn: boolean): Promise<{ afterRun: OutputFiles; afterLaterTurn: OutputFiles }> {
	const cwd = tmp.join("home", "work");
	const artifactsDir = tmp.join("artifacts");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(artifactsDir, { recursive: true });
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const mock = createMockModel({ handler: async context => respond(context) });
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"secrets.maskSessionStore": maskOn,
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	try {
		const first = await runSubprocess({
			cwd,
			artifactsDir,
			agent: AGENT,
			task: "Report the deploy key.",
			index: 0,
			id: AGENT_ID,
			modelOverride: "mock/mock-model",
			authStorage,
			modelRegistry,
			settings,
			enableLsp: false,
			enableMCP: false,
			enableIrc: false,
			outputSchema: OUTPUT_SCHEMA,
		});
		if (first.exitCode !== 0) throw new Error("The subagent's run failed");
		const afterRun = await readOutputFiles(artifactsDir);
		// No settings of its own: the turn reads the live subagent session's, which read through to the run's.
		const later = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: AGENT,
			outputSchema: OUTPUT_SCHEMA,
			message: LATER_MESSAGE,
			artifactsDir,
			storeMaskCwd: settings.getCwd(),
		});
		if (later.exitCode !== 0) throw new Error("The subagent's later turn failed");
		return { afterRun, afterLaterTurn: await readOutputFiles(artifactsDir) };
	} finally {
		authStorage.close();
	}
}

describe("secrets.maskSessionStore on the files outside the session store", () => {
	for (const maskOn of [true, false]) {
		const outcome = `${maskOn ? "markers" : "the value"} while the setting is ${maskOn ? "on" : "off"}`;

		it(`stores the /btw record and its title with ${outcome}, the live record keeping the value`, async () => {
			const { store, historyDir } = await writeBtwTopic(maskOn);

			const recordText = await Bun.file(path.join(historyDir, "entry-topic.json")).text();
			const record = JSON.parse(recordText) as BtwHistoryRecord;
			const followUp = record.followUps?.[0];
			expect([
				holds("record", recordText).value,
				holds("question", record.question),
				holds("answer", record.answer),
				holds("follow-up question", followUp?.question),
				holds("follow-up answer", followUp?.answer),
				holds("title", await Bun.file(path.join(historyDir, "entry-topic.title")).text()),
			]).toEqual([
				!maskOn,
				stored("question", maskOn),
				stored("answer", maskOn),
				stored("follow-up question", maskOn),
				stored("follow-up answer", maskOn),
				stored("title", maskOn),
			]);
			// What the overlay shows in this process.
			const live = store.getRecords()[0];
			expect([
				holds("live question", live?.question),
				holds("live answer", live?.answer),
				holds("live follow-up", live?.followUps?.[0]?.answer),
				holds("live title", live?.title),
			]).toEqual([
				stored("live question", false),
				stored("live answer", false),
				stored("live follow-up", false),
				stored("live title", false),
			]);
		});

		it(
			`stores the subagent's <id>.md and <id>.json with ${outcome}, after the run and after a later turn`,
			async () => {
				const { afterRun, afterLaterTurn } = await runSubagentTwice(maskOn);

				expect([
					holds("<id>.md after the run", afterRun.md),
					holds("<id>.json after the run", afterRun.json),
				]).toEqual([stored("<id>.md after the run", maskOn), stored("<id>.json after the run", maskOn)]);
				// The later turn rewrote both files: they carry its report.
				expect([afterLaterTurn.md.includes(LATER_TURN), afterLaterTurn.json.includes(LATER_TURN)]).toEqual([
					true,
					true,
				]);
				expect([
					holds("<id>.md after the later turn", afterLaterTurn.md),
					holds("<id>.json after the later turn", afterLaterTurn.json),
				]).toEqual([
					stored("<id>.md after the later turn", maskOn),
					stored("<id>.json after the later turn", maskOn),
				]);
				expect([
					holdsMultiLine("<id>.md after the run", afterRun.md),
					holdsMultiLine("<id>.json after the run", afterRun.json),
					holdsMultiLine("<id>.md after the later turn", afterLaterTurn.md),
					holdsMultiLine("<id>.json after the later turn", afterLaterTurn.json),
				]).toEqual([
					storedMultiLine("<id>.md after the run", maskOn),
					storedMultiLine("<id>.json after the run", maskOn),
					storedMultiLine("<id>.md after the later turn", maskOn),
					storedMultiLine("<id>.json after the later turn", maskOn),
				]);
			},
			CASE_TIMEOUT_MS,
		);
	}
});
