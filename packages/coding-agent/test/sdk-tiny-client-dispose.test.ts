import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiEmbedClient } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import type {
	MnemopiEmbedServerRequest,
	MnemopiEmbedServerResponse,
} from "@oh-my-pi/pi-coding-agent/mnemopi/embed-protocol";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as sharedWorker from "@oh-my-pi/pi-coding-agent/subprocess/shared-worker";
import type { RefCountedWorkerHandle } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as titleClient from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type { TinyWorkerRequest, TinyWorkerResponse } from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const modelSpec: ModelSpec<Api> = {
	id: "tiny-client-dispose",
	name: "Tiny client dispose",
	api: "test-tiny-client-dispose",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
};
const model = buildModel(modelSpec);

const TINY_MODEL = "qwen3-1.7b";
const EMBED_MODEL = "fast-bge-base-en-v1.5";

/** Stands in for the tiny-model worker; replies only when the test emits one. */
class FakeTinyWorker {
	#messageHandlers = new Set<(message: TinyWorkerResponse) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#requests: TinyWorkerRequest[] = [];
	#waiters: Array<(request: TinyWorkerRequest) => void> = [];

	send(message: TinyWorkerRequest): void {
		if (message.type === "ping") return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter(message);
		else this.#requests.push(message);
	}

	/** Resolves with the next non-ping request the client sends. */
	nextRequest(): Promise<TinyWorkerRequest> {
		const queued = this.#requests.shift();
		if (queued) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<TinyWorkerRequest>();
		this.#waiters.push(resolve);
		return promise;
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {}

	ref(): void {}

	unref(): void {}

	emit(message: TinyWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

/** Stands in for the machine-shared embedding server; answers only when the test emits a reply. */
class FakeEmbedServer implements RefCountedWorkerHandle<MnemopiEmbedServerRequest, MnemopiEmbedServerResponse> {
	#handlers = new Set<(message: MnemopiEmbedServerResponse) => void>();
	#waiters: Array<(id: string) => void> = [];
	terminated = false;

	send(message: MnemopiEmbedServerRequest): void {
		if (message.type === "embed") this.#waiters.shift()?.(message.id);
	}

	/** Resolves with the id of the next embed request the client sends. */
	nextEmbed(): Promise<string> {
		const { promise, resolve } = Promise.withResolvers<string>();
		this.#waiters.push(resolve);
		return promise;
	}

	onMessage(handler: (message: MnemopiEmbedServerResponse) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}

	onError(): () => void {
		return () => {};
	}

	ref(): void {}

	unref(): void {}

	emit(message: MnemopiEmbedServerResponse): void {
		for (const handler of this.#handlers) handler(message);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}
}

// The tiny-model client and the Mnemopi embedding client are process singletons; terminating
// one fails every request in flight, so only the process exit may shut them down, once.
describe("process-wide model clients on session dispose", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			if (!session.isDisposed) await session.dispose();
		}
		await titleClient.tinyTitleClient.terminate();
		await mnemopiEmbedClient.terminate();
		vi.restoreAllMocks();
	});

	const starter = (tempDir: TempDir) => {
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (
			settings: Settings,
			extra: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "taskDepth" | "agentId" | "bindProcessState"> = {},
		): Promise<AgentSession> => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				...extra,
			});
			sessions.push(session);
			return session;
		};
		return { start, close: () => authStorage.close() };
	};

	/**
	 * The embedding server every embedding request of this process reaches, and an embed in flight on it,
	 * as another session's memory recall makes, with the id the server got.
	 */
	const embedServer = (tempDir: TempDir) => {
		const server = new FakeEmbedServer();
		vi.spyOn(sharedWorker, "connectSharedWorker").mockResolvedValue(
			server as unknown as RefCountedWorkerHandle<unknown, unknown>,
		);
		const embedInFlight = async () => {
			const sent = server.nextEmbed();
			const vectors = mnemopiEmbedClient.embed(EMBED_MODEL, tempDir.path(), ["recall query"], undefined);
			return { vectors, id: await sent };
		};
		return { server, embedInFlight };
	};

	it("keeps pending requests alive until the parent's first dispose", async () => {
		using tempDir = TempDir.createSync("@pi-tiny-client-dispose-");
		const { start, close } = starter(tempDir);
		const worker = new FakeTinyWorker();
		vi.spyOn(titleClient, "tinyWorkerUsesMlx").mockReturnValue(false);
		vi.spyOn(titleClient, "connectTinyWorker").mockResolvedValue(worker);
		const client = titleClient.tinyTitleClient;
		try {
			const parentSettings = Settings.isolated({ "compaction.enabled": false });
			const parent = await start(parentSettings);
			const sub = await start(createSubagentSettings(parentSettings), {
				parentTaskPrefix: "0-Sub",
				taskDepth: 1,
				agentId: "0-Sub",
			});
			const helper = await start(await parentSettings.cloneForCwd(tempDir.path()), { bindProcessState: false });

			// A subagent or helper finishing leaves the parent's request running.
			const first = client.complete(TINY_MODEL, "first");
			const firstRequest = await worker.nextRequest();
			await sub.dispose();
			await helper.dispose();
			worker.emit({ type: "text", id: firstRequest.id, text: "kept" });
			expect(await first).toBe("kept");

			// The parent's dispose for the process exit fails what is still in flight.
			const second = client.complete(TINY_MODEL, "second");
			await worker.nextRequest();
			await parent.dispose();
			expect(await second).toBeNull();

			// A repeat dispose must not cancel requests made after the first one.
			const third = client.complete(TINY_MODEL, "third");
			const thirdRequest = await worker.nextRequest();
			await parent.dispose();
			worker.emit({ type: "text", id: thirdRequest.id, text: "after" });
			expect(await third).toBe("after");
		} finally {
			close();
		}
	});

	it("keeps pending requests alive when a session that binds process state ends while the process goes on", async () => {
		// If this regresses, closing one ACP session (a dispose that says it stops) drops the tiny-model client's
		// connections as the process exit does: a tiny-model request another session the server serves has in flight
		// fails.
		using tempDir = TempDir.createSync("@pi-tiny-client-stop-");
		const { start, close } = starter(tempDir);
		const worker = new FakeTinyWorker();
		vi.spyOn(titleClient, "tinyWorkerUsesMlx").mockReturnValue(false);
		vi.spyOn(titleClient, "connectTinyWorker").mockResolvedValue(worker);
		const client = titleClient.tinyTitleClient;
		try {
			const settings = Settings.isolated({ "compaction.enabled": false });
			const closed = await start(settings, { agentId: "acp:closed" });
			await start(await settings.cloneForCwd(tempDir.path()), { agentId: "acp:kept" });

			const pending = client.complete(TINY_MODEL, "the kept session's request");
			const request = await worker.nextRequest();
			await closed.dispose({ ownedJobsEnd: "stop" });
			worker.emit({ type: "text", id: request.id, text: "kept" });
			expect(await pending).toBe("kept");
		} finally {
			close();
		}
	});

	it("keeps another session's embedding request answered when a subagent's session ends", async () => {
		// If this regresses, every subagent's end drops the process's embedding-server connections: a memory recall
		// or consolidation the parent or another session has in flight fails.
		using tempDir = TempDir.createSync("@pi-embed-client-subagent-");
		const { start, close } = starter(tempDir);
		const { server, embedInFlight } = embedServer(tempDir);
		try {
			const parentSettings = Settings.isolated({ "compaction.enabled": false });
			await start(parentSettings);
			const sub = await start(createSubagentSettings(parentSettings), {
				parentTaskPrefix: "0-Sub",
				taskDepth: 1,
				agentId: "0-Sub",
			});

			const request = await embedInFlight();
			await sub.dispose();
			server.emit({ type: "vectors", id: request.id, vectors: [[0.5]] });

			expect(await request.vectors).toEqual([[0.5]]);
			expect(server.terminated).toBe(false);
		} finally {
			close();
		}
	});

	it("keeps the other session's embedding request answered when an ACP session closes beside it", async () => {
		// If this regresses, closing one ACP session (a dispose that says it stops) drops the embedding-server
		// connections as the process exit does: a memory request the session the server goes on serving has in flight
		// fails.
		using tempDir = TempDir.createSync("@pi-embed-client-acp-close-");
		const { start, close } = starter(tempDir);
		const { server, embedInFlight } = embedServer(tempDir);
		try {
			const settings = Settings.isolated({ "compaction.enabled": false });
			const closed = await start(settings, { agentId: "acp:closed" });
			await start(await settings.cloneForCwd(tempDir.path()), { agentId: "acp:kept" });

			const request = await embedInFlight();
			await closed.dispose({ ownedJobsEnd: "stop" });
			server.emit({ type: "vectors", id: request.id, vectors: [[0.25]] });

			expect(await request.vectors).toEqual([[0.25]]);
			expect(server.terminated).toBe(false);
		} finally {
			close();
		}
	});

	it("drops the embedding-server connections at the process exit", async () => {
		// If this regresses, the process exit leaves its embedding-server connections open: an SDK embedder that goes
		// on keeps a transport whose requests can outlive every session that made them.
		using tempDir = TempDir.createSync("@pi-embed-client-exit-");
		const { start, close } = starter(tempDir);
		const { server, embedInFlight } = embedServer(tempDir);
		try {
			const parent = await start(Settings.isolated({ "compaction.enabled": false }));

			const request = await embedInFlight();
			await parent.dispose();

			await expect(request.vectors).rejects.toThrow("mnemopi embed worker terminated");
			expect(server.terminated).toBe(true);
		} finally {
			close();
		}
	});
});
