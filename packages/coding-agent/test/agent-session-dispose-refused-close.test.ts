/**
 * A session's dispose closes its session manager last. When that close fails, dispose still drops what a
 * close that lands drops, then rejects with the close's error: the agent's copy of the transcript, the
 * session manager's entries unless the manager holds them for a later send (a close the store refused
 * for an outage, SessionManager.holdsTranscript), and the account pools. A handler that outlives the drain
 * deadline is reset again once it settles, by the same deferred pass as after a close that lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { assistant, type FullDisk, fsError, heldIds, installFullDisk, until } from "./helpers/refusing-session-stores";

const PROVIDER_SESSION_ID = "pooled-provider-session";

describe("AgentSession dispose when the final close fails", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-dispose-refused-close-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "runtime-key");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose().catch(() => undefined);
		vi.restoreAllMocks();
		authStorage.close();
		AsyncJobManager.resetForTests();
		tempDir.removeSync();
	});

	function bundledModel() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		return model;
	}

	/**
	 * A session on a file store whose session directory accepts writes until `disk.full` is set, with a
	 * transcript on disk and one more answer the store refused, held in memory. With `stallUntil`, its
	 * `message_end` handler holds dispose past its drain deadline until that promise resolves. With
	 * `accountPoolScope`, the session is pooled to account c.
	 */
	async function refusedSession(
		refusal: "ENOSPC" | "EACCES",
		options: { stallUntil?: Promise<void>; accountPoolScope?: SessionAccountPoolScope } = {},
	): Promise<{ session: AgentSession; disk: FullDisk }> {
		const model = bundledModel();
		const sessionDir = tempDir.join("sessions");
		const disk = installFullDisk(fpath => fpath.startsWith(sessionDir + path.sep), false);
		const sessionManager = await SessionManager.open(path.join(sessionDir, "Refused.jsonl"), undefined, undefined, {
			initialCwd: tempDir.path(),
		});
		const baseRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const modelRegistry = options.accountPoolScope?.registry(baseRegistry) ?? baseRegistry;
		const reached = Promise.withResolvers<void>();
		let extensionRunner: ExtensionRunner | undefined;
		if (options.stallUntil) {
			const stallUntil = options.stallUntil;
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("message_end", async () => {
						reached.resolve();
						await stallUntil;
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"stalled-message-end",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
			...(options.accountPoolScope
				? { providerSessionId: PROVIDER_SESSION_ID, accountPoolScope: options.accountPoolScope }
				: {}),
		});
		sessions.push(session);

		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "the question" }], timestamp: Date.now() },
			assistant("the stored answer"),
		];
		session.agent.replaceMessages(messages);
		sessionManager.appendMessage({ role: "user", content: "the question", timestamp: Date.now() });
		sessionManager.appendMessage(assistant("the stored answer"));
		await sessionManager.flush();
		disk.error = () =>
			refusal === "EACCES"
				? fsError("EACCES", "EACCES: permission denied, open")
				: fsError("ENOSPC", "ENOSPC: no space left on device, write");
		disk.full = true;
		sessionManager.appendMessage(assistant("the refused answer"));
		session.agent.appendMessage(assistant("the refused answer"));
		expect(session.agent.state.messages.length).toBe(3);
		expect(sessionManager.getEntries().length).toBe(3);

		if (options.stallUntil) {
			session.agent.emitExternalEvent({ type: "message_end", message: assistant("a late answer") });
			await reached.promise;
		}
		return { session, disk };
	}

	it("a close the store refused for permission drops the agent's copy and the manager's entries", async () => {
		const { session, disk } = await refusedSession("EACCES");

		await expect(session.dispose()).rejects.toThrow("EACCES");

		expect(disk.refused).toBeGreaterThan(0);
		expect({
			holds: session.sessionManager.holdsTranscript(),
			agent: session.agent.state.messages.length,
			manager: session.sessionManager.getEntries().length,
		}).toEqual({ holds: false, agent: 0, manager: 0 });
	});

	it("a close that fails with an error that is no refusal drops both copies too", async () => {
		const { session, disk } = await refusedSession("ENOSPC");
		disk.full = false;
		vi.spyOn(session.sessionManager, "close").mockRejectedValue(new Error("the writer failed to close"));

		await expect(session.dispose()).rejects.toThrow("the writer failed to close");

		expect({
			holds: session.sessionManager.holdsTranscript(),
			agent: session.agent.state.messages.length,
			manager: session.sessionManager.getEntries().length,
		}).toEqual({ holds: false, agent: 0, manager: 0 });
	});

	it("a close the store refused for an outage drops the agent's copy and leaves the manager's entries to the send", async () => {
		const { session } = await refusedSession("ENOSPC");
		const held = heldIds(session.sessionManager);

		await expect(session.dispose()).rejects.toThrow("ENOSPC");

		expect({
			holds: session.sessionManager.holdsTranscript(),
			agent: session.agent.state.messages.length,
			manager: heldIds(session.sessionManager).slice(0, held.length),
		}).toEqual({ holds: true, agent: 0, manager: held });
	});

	it("after a refused close at the drain deadline, a handler that settles later is reset again", async () => {
		const stall = Promise.withResolvers<void>();
		const { session } = await refusedSession("EACCES", { stallUntil: stall.promise });
		const reset = vi.spyOn(session.agent, "reset");

		try {
			await expect(session.dispose({ drainTimeoutMs: 20 })).rejects.toThrow("EACCES");
			expect(reset.mock.calls.length).toBe(1);
		} finally {
			stall.resolve();
		}
		await until(() => reset.mock.calls.length === 2, "the deferred pass after the refused close");
		expect({
			agent: session.agent.state.messages.length,
			manager: session.sessionManager.getEntries().length,
		}).toEqual({ agent: 0, manager: 0 });
	});

	it("the deferred pass after a close refused for an outage keeps the manager's held entries", async () => {
		const stall = Promise.withResolvers<void>();
		const { session } = await refusedSession("ENOSPC", { stallUntil: stall.promise });
		const reset = vi.spyOn(session.agent, "reset");
		const held = heldIds(session.sessionManager);

		try {
			await expect(session.dispose({ drainTimeoutMs: 20 })).rejects.toThrow("ENOSPC");
		} finally {
			stall.resolve();
		}
		await until(() => reset.mock.calls.length === 2, "the deferred pass after the refused close");
		expect({
			holds: session.sessionManager.holdsTranscript(),
			agent: session.agent.state.messages.length,
			manager: heldIds(session.sessionManager).slice(0, held.length),
		}).toEqual({ holds: true, agent: 0, manager: held });
	});

	it("a failed close lifts the session's account pool", async () => {
		await authStorage.credentials.set(
			"anthropic",
			["a", "b", "c"].map(suffix => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 60 * 60_000,
				accountId: `account-${suffix}`,
				email: `${suffix}@example.com`,
				orgId: `org-${suffix}`,
			})),
		);
		const accountPoolScope = new SessionAccountPoolScope(
			authStorage,
			{ anthropic: ["email:c@example.com|org:org-c"] },
			PROVIDER_SESSION_ID,
		);
		const { session } = await refusedSession("EACCES", { accountPoolScope });
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");

		await expect(session.dispose()).rejects.toThrow("EACCES");

		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});
});
