import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { checkPythonKernelAvailability } from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, type OverlayRebuild, reloadOverlay } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** A consolidated memory summary of about 150 tokens, longer than a 10-token injection budget. */
const MEMORY_SUMMARY = Array.from({ length: 30 }, (_, index) => `Project fact ${index}: keep it.`).join("\n");

/** A Hindsight server on a `.local` host; the gateway's `fetch` spy refuses any request to it. */
const HINDSIGHT_URL = "http://hindsight.test.local:8888";

/** Overlay lines that keep a Hindsight client from calling its server, up to an open `hindsight:` block. */
const QUIET_HINDSIGHT = `${LONG_ENTRIES}hindsight:\n  autoRecall: false\n  autoRetain: false\n  mentalModelsEnabled: false\n`;

/** Overlay lines that keep Mnemopi in the process, up to an open `mnemopi:` block. */
const QUIET_MNEMOPI = `${LONG_ENTRIES}mnemopi:\n  noEmbeddings: true\n  llmMode: none\n  autoRecall: false\n  autoRetain: false\n`;

/**
 * A setting the system prompt renders only while another setting has some value, as four overlays: neither changed,
 * the masking setting changed, the masked one changed, and both.
 */
interface MaskedPair {
	name: string;
	/** The masking setting's id, then the masked one's. */
	ids: [string, string];
	/** The tools the sessions start with. */
	tools: string[];
	start: string;
	maskingChanged: string;
	maskedChanged: string;
	bothChanged: string;
	/** Writes what the sessions read besides settings into their directory before they start. */
	seed?(dir: TempDir): Promise<void>;
}

/**
 * The note on auto-QA renders while auto-QA is on, with `write` active. `dev.autoqaConsent` decides that only while
 * `dev.autoqa` is unset: an explicit `dev.autoqa` is the answer, and the consent is not read.
 */
const AUTOQA_CONSENT: MaskedPair = {
	name: "`dev.autoqaConsent` under an unset `dev.autoqa`",
	ids: ["dev.autoqa", "dev.autoqaConsent"],
	tools: ["read", "write"],
	start: `${LONG_ENTRIES}dev:\n  autoqa: false\n  autoqaConsent: denied\n`,
	maskingChanged: `${LONG_ENTRIES}dev:\n  autoqaConsent: denied\n`,
	maskedChanged: `${LONG_ENTRIES}dev:\n  autoqa: false\n  autoqaConsent: unset\n`,
	bothChanged: `${LONG_ENTRIES}dev:\n  autoqaConsent: unset\n`,
};

const PAIRS: MaskedPair[] = [
	AUTOQA_CONSENT,
	{
		// The local memory backend renders the consolidated summary cut to `memories.summaryInjectionTokenLimit`;
		// with memory off nothing renders it, and the build does not read the limit.
		name: "`memories.summaryInjectionTokenLimit` under `memory.backend: local`",
		ids: ["memory.backend", "memories.summaryInjectionTokenLimit"],
		tools: ["read"],
		start: LONG_ENTRIES,
		maskingChanged: `${LONG_ENTRIES}memory:\n  backend: local\n`,
		maskedChanged: `${LONG_ENTRIES}memories:\n  summaryInjectionTokenLimit: 10\n`,
		bothChanged: `${LONG_ENTRIES}memory:\n  backend: local\nmemories:\n  summaryInjectionTokenLimit: 10\n`,
		seed: async dir => {
			await Bun.write(`${getMemoryRoot(dir.path(), dir.path())}/memory_summary.md`, `${MEMORY_SUMMARY}\n`);
		},
	},
	{
		// Inline tool descriptors put each tool's description in the system prompt, the bash one with the
		// auto-background threshold; otherwise the prompt lists the tools by name, and only the bash definition
		// states the threshold.
		name: "`bash.autoBackground.thresholdMs` under `inlineToolDescriptors: on`",
		ids: ["inlineToolDescriptors", "bash.autoBackground.thresholdMs"],
		tools: ["read", "bash"],
		start: LONG_ENTRIES,
		maskingChanged: `${LONG_ENTRIES}inlineToolDescriptors: "on"\n`,
		maskedChanged: `${LONG_ENTRIES}bash:\n  autoBackground:\n    thresholdMs: 30000\n`,
		bothChanged: `${LONG_ENTRIES}inlineToolDescriptors: "on"\nbash:\n  autoBackground:\n    thresholdMs: 30000\n`,
	},
	{
		// An owned tool-call dialect puts each tool's description in the system prompt, as inline descriptors do.
		name: "`bash.autoBackground.thresholdMs` under `tools.format: xml`",
		ids: ["tools.format", "bash.autoBackground.thresholdMs"],
		tools: ["read", "bash"],
		start: LONG_ENTRIES,
		maskingChanged: `${LONG_ENTRIES}tools:\n  format: xml\n`,
		maskedChanged: `${LONG_ENTRIES}bash:\n  autoBackground:\n    thresholdMs: 30000\n`,
		bothChanged: `${LONG_ENTRIES}tools:\n  format: xml\nbash:\n  autoBackground:\n    thresholdMs: 30000\n`,
	},
	{
		// The Hindsight backend renders its instructions while `hindsight.apiUrl` names a server; with memory off
		// nothing reads the URL. Recall, retain and mental models stay off, so the client never calls the server.
		name: "`hindsight.apiUrl` under `memory.backend: hindsight`",
		ids: ["memory.backend", "hindsight.apiUrl"],
		tools: ["read"],
		start: `${QUIET_HINDSIGHT}  apiUrl: ""\n`,
		maskingChanged: `${QUIET_HINDSIGHT}  apiUrl: ""\nmemory:\n  backend: hindsight\n`,
		maskedChanged: `${QUIET_HINDSIGHT}  apiUrl: ${HINDSIGHT_URL}\n`,
		bothChanged: `${QUIET_HINDSIGHT}  apiUrl: ${HINDSIGHT_URL}\nmemory:\n  backend: hindsight\n`,
	},
	{
		// The Mnemopi backend renders its instructions cut to `mnemopi.injectionTokenLimit`; with memory off nothing
		// reads the limit. No embeddings, no model calls and no recall or retain, so nothing leaves the process.
		name: "`mnemopi.injectionTokenLimit` under `memory.backend: mnemopi`",
		ids: ["memory.backend", "mnemopi.injectionTokenLimit"],
		tools: ["read"],
		start: QUIET_MNEMOPI,
		maskingChanged: `${QUIET_MNEMOPI}memory:\n  backend: mnemopi\n`,
		maskedChanged: `${QUIET_MNEMOPI}  injectionTokenLimit: 10\n`,
		bothChanged: `${QUIET_MNEMOPI}  injectionTokenLimit: 10\nmemory:\n  backend: mnemopi\n`,
	},
];

/** A Python interpreter a probe found unusable, so the eval definitions leave Python out under it. */
const BROKEN_PYTHON = "/nonexistent/python3";

/** Pairs whose masked setting renders in a tool definition only while the masking setting has some value. */
const DECLARATION_PAIRS: MaskedPair[] = [
	{
		// The eval definitions offer Python unless a probe found `python.interpreter` unusable; with `eval.py` off
		// nothing reads the interpreter.
		name: "`python.interpreter` under `eval.py: true`",
		ids: ["eval.py", "python.interpreter"],
		tools: ["read", "bash", "eval"],
		start: `${LONG_ENTRIES}eval:\n  py: false\n`,
		maskingChanged: `${LONG_ENTRIES}eval:\n  py: true\n`,
		maskedChanged: `${LONG_ENTRIES}eval:\n  py: false\npython:\n  interpreter: ${BROKEN_PYTHON}\n`,
		bothChanged: `${LONG_ENTRIES}eval:\n  py: true\npython:\n  interpreter: ${BROKEN_PYTHON}\n`,
		seed: async dir => {
			await checkPythonKernelAvailability(dir.path(), BROKEN_PYTHON, { forceProbe: true });
		},
	},
];

const MINUTE_MS = 60_000;

/** When the requests between the first request and the bound are made, in minutes after the first request. */
const EARLY_REQUEST_MINUTES = [0.75, 1.5, 2.5, 3.5, 4.5, 5.25] as const;

/** The calls of the session a reload of these overlays may start. */
const RELOAD_CALLS: readonly OverlayRebuild[] = [
	"refreshBaseSystemPrompt",
	"reconcileBuiltinTools",
	"holdToolDeclarationChange",
];

/**
 * Rewrites the overlay and reloads it as the config watcher does, then waits for each call of the session the change
 * starts. The auto-QA listener reaches its rebuild only after awaiting the workspace roots, so the wait takes one turn
 * of the event loop.
 */
const reload = (harness: Harness, content: string): Promise<void> =>
	reloadOverlay(harness, content, RELOAD_CALLS, { eventLoopTurn: true });

interface Harness {
	session: AgentSession;
	settings: Settings;
	requests: MessagesRequest[];
	overlay: string;
	/** Puts the real `fetch` back. */
	restoreFetch(): void;
}

/** The requests of one session whose settings changed in two reloads, by when they were made. */
interface TwoBatchRun {
	/** The request before either change. */
	first: MessagesRequest;
	/** The requests made under five minutes after the first change. */
	early: MessagesRequest[];
	/** The first request made five minutes after the second change, which is more than five after the first. */
	atBound: MessagesRequest;
}

describe("a prompt setting and the setting that masks it, changed in two reloads on a bound prompt", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		// Newest first: each session is disposed before the directory it writes under is removed.
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/** A clock `Date.now` reads, moved by the test. */
	function startClock(): { advance(ms: number): void; now(): number } {
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		return {
			advance: ms => {
				now += ms;
			},
			now: () => now,
		};
	}

	/** A session on the gateway's claude-opus-5-5 with `pair`'s tools, whose settings load `overlay` as a `--config` file. */
	async function startSession(pair: MaskedPair, overlay: string): Promise<Harness> {
		const dir = TempDir.createSync("@pi-settings-masked-batches-");
		cleanups.push(() => dir.remove());
		await pair.seed?.(dir);
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const { requests, restore: restoreFetch } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: pair.tools,
			contextFiles: [],
			skills: [],
		});
		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		// A session done starting: its memory backend's state and tools are in place before the first request.
		await session.settleMemoryBackend();
		return { session, settings, requests, overlay: overlayPath, restoreFetch };
	}

	/**
	 * The first request of a session started on `pair.start` whose overlay is rewritten to `overlay` before it sends
	 * anything: what those settings send through the same live path, with no bound prompt to hold them for. A memory
	 * backend's tools, which a live switch adds, are in it.
	 */
	async function firstRequestOn(pair: MaskedPair, overlay: string): Promise<MessagesRequest> {
		const reference = await startSession(pair, pair.start);
		await reload(reference, overlay);
		await reference.session.settleMemoryBackend();
		await reference.session.prompt("a session on these settings");
		reference.restoreFetch();
		const [request] = reference.requests;
		if (!request) throw new Error("Expected the reference session's request");
		return request;
	}

	/** The system prompt of the first request of a session started on `overlay`. */
	async function systemOnSettings(pair: MaskedPair, overlay: string): Promise<string> {
		return withoutCacheControl((await firstRequestOn(pair, overlay)).system);
	}

	/**
	 * Starts on `pair.start`, sends the first request, reloads `firstChange` 30 s later and `pair.bothChanged` 30 s
	 * after that, with a request between them, then rebuilds the prompt once for no settings change and sends a
	 * request a minute, which keeps the one-hour entry warm, up to 5 min 15 s after the first request. The last
	 * request comes five minutes after the second change. No request falls between five minutes after the first
	 * change and five after the second, so the last request is the first one due whichever change the hold dates from.
	 */
	async function changeInTwoBatches(pair: MaskedPair, firstChange: string): Promise<TwoBatchRun> {
		const clock = startClock();
		const harness = await startSession(pair, pair.start);
		const startedAt = clock.now();
		const at = (minutes: number): void => clock.advance(startedAt + minutes * MINUTE_MS - clock.now());
		await harness.session.prompt("first");
		at(0.5);
		await reload(harness, firstChange);
		at(0.75);
		await harness.session.prompt("between the two changes");
		at(1);
		await reload(harness, pair.bothChanged);
		at(1.5);
		await harness.session.prompt("after both changes");
		// A rebuild no settings change started, such as a rule file edit or an MCP server connecting.
		await harness.session.refreshBaseSystemPrompt();
		for (const minutes of [2.5, 3.5, 4.5, 5.25]) {
			at(minutes);
			await harness.session.prompt(`${minutes} minutes after the first request`);
		}
		at(6);
		await harness.session.prompt("five minutes after the second change");

		const [first, ...early] = harness.requests;
		const atBound = early.pop();
		if (!first || !atBound) throw new Error("Expected the requests around the changes");
		expect(early).toHaveLength(6);
		return { first, early, atBound };
	}

	/** When the first early request whose `part` differs from the first request's was made, in minutes; undefined when none. */
	function firstChangeAt(run: TwoBatchRun, part: "system" | "tools"): number | undefined {
		const sent = withoutCacheControl(run.first[part]);
		const index = run.early.findIndex(request => withoutCacheControl(request[part]) !== sent);
		return index === -1 ? undefined : EARLY_REQUEST_MINUTES[index];
	}

	describe.each(PAIRS)("$name", pair => {
		describe.each([
			{ order: "the masking setting first", firstChange: pair.maskingChanged },
			{ order: "the masked setting first", firstChange: pair.maskedChanged },
		])("$order", ({ firstChange }) => {
			/** The system prompts of sessions started on the masked change, the masking change, and both. */
			let masked: string;
			let unmasked: string;
			let rebuilt: string;
			let run: TwoBatchRun;

			beforeAll(async () => {
				masked = await systemOnSettings(pair, pair.maskedChanged);
				unmasked = await systemOnSettings(pair, pair.maskingChanged);
				rebuilt = await systemOnSettings(pair, pair.bothChanged);
				run = await changeInTwoBatches(pair, firstChange);
			}, 60_000);

			it("keeps the system prompt and tool definitions of every request under five minutes as sent", () => {
				// Preconditions: the masked setting renders nothing in the system prompt under the masking setting's
				// first value, and changes it under its second.
				expect(masked).toBe(withoutCacheControl(run.first.system));
				expect(rebuilt).not.toBe(unmasked);
				// The minute of the first early request that sent other bytes, for each part; none for either.
				expect({ system: firstChangeAt(run, "system"), tools: firstChangeAt(run, "tools") }).toEqual({
					system: undefined,
					tools: undefined,
				});
			});

			it("sends both changes in the system prompt of the first request five minutes after them", () => {
				expect(withoutCacheControl(run.atBound.system)).toBe(rebuilt);
			});

			it("names both settings in the notice of the held change", () => {
				const last = run.early.at(-1);
				if (!last) throw new Error("Expected the early requests");
				const notices = textOf(last.messages.slice(run.first.messages.length));

				expect(notices).toContain("is held");
				// The notice says any setting it does not name is unaffected; both changes reach the prompt at the
				// rebuild.
				for (const id of pair.ids) expect(notices).toContain(`\`${id}\``);
			});
		});
	});

	describe.each(DECLARATION_PAIRS)("$name, the masked setting first", pair => {
		it("keeps the system prompt and tool definitions of every request under five minutes as sent", async () => {
			const masked = await firstRequestOn(pair, pair.maskedChanged);
			const unmasked = await firstRequestOn(pair, pair.maskingChanged);
			const rebuilt = await firstRequestOn(pair, pair.bothChanged);
			const run = await changeInTwoBatches(pair, pair.maskedChanged);

			// Preconditions: the masked setting renders nothing in the tool definitions under the masking setting's
			// first value, and changes them under its second.
			expect(withoutCacheControl(masked.tools)).toBe(withoutCacheControl(run.first.tools));
			expect(withoutCacheControl(rebuilt.tools)).not.toBe(withoutCacheControl(unmasked.tools));
			expect({ system: firstChangeAt(run, "system"), tools: firstChangeAt(run, "tools") }).toEqual({
				system: undefined,
				tools: undefined,
			});
		}, 60_000);
	});

	describe("`dev.autoqaConsent` changed in an earlier reload and again in the one that changes `dev.autoqa`", () => {
		it("names the masked setting in the notice with the value the prompt was built with", async () => {
			const harness = await startSession(AUTOQA_CONSENT, AUTOQA_CONSENT.start);
			await harness.session.prompt("first");
			// The consent moves while the explicit `dev.autoqa: false` keeps it unread.
			await reload(harness, `${LONG_ENTRIES}dev:\n  autoqa: false\n  autoqaConsent: granted\n`);
			await harness.session.prompt("between the two changes");
			// `dev.autoqa` unset: the build reads the consent, which moves again.
			await reload(harness, AUTOQA_CONSENT.bothChanged);
			await harness.session.prompt("after both changes");

			const [first, , last] = harness.requests;
			if (!first || !last) throw new Error("Expected the requests around the changes");
			const notices = textOf(last.messages.slice(first.messages.length));
			// Precondition: the change is held, and the system prompt is the one built under `denied`.
			expect(notices).toContain("is held");
			expect(withoutCacheControl(last.system)).toBe(withoutCacheControl(first.system));
			expect(notices).toContain('`dev.autoqaConsent`: `"denied"` → `"unset"`');
			expect(notices).not.toContain('"granted"');
		}, 60_000);
	});
});
