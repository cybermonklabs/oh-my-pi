/**
 * A first-turn memory recall (Hindsight, Mnemopi) goes out as the system prompt's own last block, after the memory
 * instructions. Every later build of the prompt must lay it out the same way: a build that put the recall inside the
 * memory instructions instead would never match the prompt that went out, so a kept or held prompt would never count
 * as unchanged, and its release would rewrite the whole cached prompt. Each case changes nothing the prompt shows and
 * expects the prompt to stay as cached past five minutes.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, RELOAD_CALLS, reloadOverlay, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	GATEWAY,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	textOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The Hindsight server the settings name; the `fetch` spy answers it, so no request leaves the process. */
const HINDSIGHT_URL = "http://127.0.0.1:1";

/** The one memory the Hindsight bank recalls. */
const MEMORY = "The deploy host is alpha-7.";

/** The pods' Hindsight `memory.yml` on one-hour cache entries, its server the test's. */
const HINDSIGHT_MEMORY = `providers:
  cacheRetention: long
memory:
  backend: hindsight
hindsight:
  apiUrl: ${HINDSIGHT_URL}
  bankId: fleet-bank
  scoping: per-project-tagged
  recallTypes: [world, experience, observation]
  recallMaxTokens: 2000
  retainMode: last-turn
  retainEveryNTurns: 1
  retainOverlapTurns: 0
  mentalModelsEnabled: false
`;

/** Mnemopi on a database in `dir`, without embeddings or a model, its recall cut to a small budget. */
function mnemopiMemory(dir: TempDir): string {
	return `providers:
  cacheRetention: long
compaction:
  enabled: false
memory:
  backend: mnemopi
mnemopi:
  scoping: global
  dbPath: ${dir.join("mnemopi.db")}
  noEmbeddings: true
  llmMode: none
  autoRetain: false
  injectionTokenLimit: 300
`;
}

const MINUTE_MS = 60_000;

describe("a system prompt whose first-turn recall went out as its last block", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one) whose settings load an overlay of `overlay`: runs
	 * `steps`, then exits. The `fetch` spy answers the gateway and the Hindsight server.
	 */
	async function runProcess(
		dir: TempDir,
		overlay: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, reload: (content: string) => Promise<void>) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlayPath = dir.join("overlay.yml");
		await Bun.write(overlayPath, overlay);
		const settings = await Settings.loadIsolated({
			cwd: dir.path(),
			agentDir: dir.path(),
			configFiles: [overlayPath],
		});
		const requests: MessagesRequest[] = [];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (input, init) => {
				const url = new URL(String(input));
				if (url.href === `${GATEWAY}/v1/messages`) {
					requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
					return answer(requests.length, { cacheWriteTokens: 100 });
				}
				if (url.origin !== HINDSIGHT_URL) throw new Error(`Unexpected request to ${url.href}`);
				if (url.pathname.endsWith("/memories/recall")) {
					return Response.json({ results: [{ id: "m1", text: MEMORY, type: "world" }] });
				}
				const bank = /^\/v1\/default\/banks\/([^/]+)$/.exec(url.pathname);
				if (bank) return Response.json({ bank_id: decodeURIComponent(bank[1]) });
				return Response.json({});
			}),
		);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.settleMemoryBackend();
			await steps(session, content =>
				reloadOverlay({ session, settings, overlay: overlayPath }, content, RELOAD_CALLS),
			);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
			fetchSpy.mockRestore();
		}
	}

	it("lets a resumed process's kept prompt settle when a setting changed meanwhile is set back (Hindsight)", async () => {
		using dir = TempDir.createSync("@pi-recall-block-layout-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const live = await runProcess(dir, `${HINDSIGHT_MEMORY}personality: default\n`, undefined, async session => {
			await session.prompt("first");
		});
		// The configuration moved to `pragmatic` while no process ran; the sync sets it back before the first prompt.
		const resumed = await runProcess(
			dir,
			`${HINDSIGHT_MEMORY}personality: pragmatic\n`,
			live.sessionFile,
			async (session, reload) => {
				await reload(`${HINDSIGHT_MEMORY}personality: default\n`);
				await session.prompt("second");
				setClock(6 * MINUTE_MS);
				await session.prompt("third");
			},
		);

		const [first] = live.requests;
		const [second, third] = resumed.requests;
		if (!first || !second || !third) throw new Error("Expected the two processes' requests");
		// Preconditions: the recall went out as a block once, and the resumed process sends the stored prompt.
		expect(copiesIn(first.system, MEMORY)).toBe(1);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		// The prompt was written under `default`: nothing is held, and nothing rewrites it six minutes on.
		expect(textOf(second.messages.slice(first.messages.length))).not.toContain("`personality`");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);

	it("releases a restored held prompt byte for byte when its change was set back (Hindsight)", async () => {
		using dir = TempDir.createSync("@pi-recall-block-layout-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		// A change held on the prompt is set back before the process exits, before the held rebuild.
		const live = await runProcess(
			dir,
			`${HINDSIGHT_MEMORY}personality: default\n`,
			undefined,
			async (session, reload) => {
				await session.prompt("first");
				await reload(`${HINDSIGHT_MEMORY}personality: pragmatic\n`);
				setClock(MINUTE_MS);
				await session.prompt("after the change");
				await reload(`${HINDSIGHT_MEMORY}personality: default\n`);
				setClock(2 * MINUTE_MS);
				await session.prompt("after the change was set back");
			},
		);
		setClock(3 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			`${HINDSIGHT_MEMORY}personality: default\n`,
			live.sessionFile,
			async session => {
				await session.prompt("after the resume");
				setClock(6 * MINUTE_MS);
				await session.prompt("after the held change is due");
			},
		);

		const [first] = live.requests;
		const [restoredRequest, released] = resumed.requests;
		if (!first || !restoredRequest || !released) throw new Error("Expected the two processes' requests");
		// Preconditions: the recall went out as a block once, and the resumed process sends the stored prompt.
		expect(copiesIn(first.system, MEMORY)).toBe(1);
		expect(withoutCacheControl(restoredRequest.system)).toBe(withoutCacheControl(first.system));
		// The held change is due, and the process's own build is the stored prompt: the release changes no byte.
		expect(withoutCacheControl(released.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);

	it("holds nothing for a setting the prompt does not show, and keeps the prompt (Hindsight)", async () => {
		using dir = TempDir.createSync("@pi-recall-block-layout-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		setClock(0);
		const { requests } = await runProcess(dir, HINDSIGHT_MEMORY, undefined, async (session, reload) => {
			await session.prompt("first");
			// The prompt renders `task.maxConcurrency` only with the `task` tool, which this session lacks.
			await reload(`${HINDSIGHT_MEMORY}task:\n  maxConcurrency: 4\n`);
			setClock(MINUTE_MS);
			await session.prompt("after the change");
			setClock(6 * MINUTE_MS);
			await session.prompt("six minutes on");
		});

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		expect(copiesIn(first.system, MEMORY)).toBe(1);
		expect(textOf(second.messages.slice(first.messages.length))).not.toContain("task.maxConcurrency");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);

	it("holds nothing for a setting the prompt does not show, and keeps the prompt (Mnemopi)", async () => {
		using dir = TempDir.createSync("@pi-recall-block-layout-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		// Mnemopi starts in the background: wait for it before writing memories.
		const started = Promise.withResolvers<void>();
		const start = mnemopiBackend.start;
		vi.spyOn(mnemopiBackend, "start").mockImplementation(async options => {
			await start.call(mnemopiBackend, options);
			started.resolve();
		});
		setClock(0);
		const memory = mnemopiMemory(dir);
		const { requests } = await runProcess(dir, memory, undefined, async (session, reload) => {
			await started.promise;
			const state = getMnemopiSessionState(session);
			if (!state) throw new Error("Expected Mnemopi to start");
			state.rememberScoped("The deploy host is alpha-7.");
			state.rememberScoped(`The deploy host runbook: ${"drain the queue, then rotate the keys. ".repeat(5)}`);
			state.rememberScoped(`The deploy host checklist: ${"restart the workers, then watch the logs. ".repeat(5)}`);
			await session.prompt("Where is the deploy host?");
			await reload(`${memory}task:\n  maxConcurrency: 4\n`);
			setClock(MINUTE_MS);
			await session.prompt("after the change");
			setClock(6 * MINUTE_MS);
			await session.prompt("six minutes on");
		});

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		// Precondition: the first-turn recall, cut to the budget, went out in the system prompt.
		expect(copiesIn(first.system, "Treat recalled memories as background knowledge")).toBe(1);
		expect(textOf(second.messages.slice(first.messages.length))).not.toContain("task.maxConcurrency");
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
	}, 60_000);
});
