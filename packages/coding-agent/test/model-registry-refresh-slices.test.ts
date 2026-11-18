import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const offlineFetch: FetchImpl = () => Promise.reject(new Error("network disabled in model-registry slicing test"));

/**
 * A clock that advances 1 ms per read. Discovery reads it before each unit of
 * work, so every pass is split into slices no matter how fast the machine is.
 */
function mockSteadyClock(): void {
	let now = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => now++);
}

/** A clock that never advances: no slice expires, so a pass runs unsliced. */
function mockFrozenClock(): void {
	vi.spyOn(performance, "now").mockImplementation(() => 1_000);
}

/**
 * Counts event loop turns until stopped. It ticks on `setTimeout(0)`, one of
 * the two macrotasks a sliced pass yields to, so `onTurn` runs about once per
 * slice rather than on every pass through the event loop.
 */
function countTurns(onTurn?: () => void): { turns: () => number; stop: () => void } {
	let turns = 0;
	let running = true;
	const tick = () => {
		if (!running) return;
		turns++;
		onTurn?.();
		setTimeout(tick, 0);
	};
	setTimeout(tick, 0);
	return { turns: () => turns, stop: () => (running = false) };
}

/** Every model in order, with every field JSON can carry. */
function catalogText(models: readonly Model<Api>[]): string[] {
	return models.map(model => JSON.stringify(model));
}

describe("ModelRegistry discovery slicing", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-registry-refresh-slices-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	test("a refresh returns to the event loop while it merges, and the catalog it commits is unchanged", async () => {
		// Reference: the same refresh unsliced, run to completion before any comparison.
		mockFrozenClock();
		const reference = new ModelRegistry(authStorage, tempDir.join("reference", "models.yml"), { fetch: offlineFetch });
		await reference.refresh("offline");
		const expected = catalogText(reference.getAll());
		vi.restoreAllMocks();

		mockSteadyClock();
		const registry = new ModelRegistry(authStorage, tempDir.join("sliced", "models.yml"), { fetch: offlineFetch });
		const loop = countTurns();
		await registry.refresh("offline");
		loop.stop();
		// Without slicing, timers and socket reads wait for the whole merge of thousands of models.
		expect(loop.turns()).toBeGreaterThan(0);
		const actual = catalogText(registry.getAll());
		vi.restoreAllMocks();
		expect(actual.length).toBeGreaterThan(100);
		expect(actual).toEqual(expected);
	});

	test("a refresh whose inputs change during every merge still ends, and commits its discovery", async () => {
		mockSteadyClock();
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { fetch: offlineFetch });
		registry.registerProvider(
			"sliced-runtime-provider",
			{
				baseUrl: "https://runtime.example.com/v1",
				apiKey: "RUNTIME_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => [
					{
						id: "dynamic-model",
						name: "Dynamic Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 8_192,
					},
				],
			},
			"ext://runtime",
		);
		// A runtime registration changes what a discovery merge reads; one lands on every turn.
		let registrations = 0;
		const churn = countTurns(() => {
			registrations++;
			registry.registerProvider("openai", { headers: { "x-churn": String(registrations) } }, "ext://churn");
		});
		await registry.refresh("online");
		churn.stop();
		expect(registrations).toBeGreaterThan(3);
		expect(registry.find("sliced-runtime-provider", "dynamic-model")).toBeDefined();
	});

	test("a pass whose fetches resolved first does not overwrite the rows of a pass that fetched later", async () => {
		mockSteadyClock();
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { fetch: offlineFetch });
		const row = (id: string) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		let fetches = 0;
		const { promise: firstFetchDone, resolve: firstFetchResolved } = Promise.withResolvers<void>();
		registry.registerProvider(
			"ordered-provider",
			{
				baseUrl: "https://ordered.example.com/v1",
				apiKey: "ORDERED_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					if (fetches > 1) return [row("model-v2")];
					// The full pass's other discoveries finish first, so its fetches resolve with this one.
					await new Promise(resolve => setTimeout(resolve, 300));
					queueMicrotask(firstFetchResolved);
					return [row("model-v1")];
				},
			},
			"ext://ordered",
		);
		// The full pass fetches v1, and its fetches resolve; it then merges the whole catalog in slices.
		const fullPass = registry.refresh("online");
		await firstFetchDone;
		for (let turn = 0; turn < 2; turn++) await new Promise(resolve => setTimeout(resolve, 0));
		let fullPassDone = false;
		void fullPass.then(() => (fullPassDone = true));
		// A scoped pass starts during that merge, fetches v2 and commits first.
		await registry.refreshDiscoverableProviders(["ordered-provider"], "online");
		expect(fullPassDone).toBe(false);
		await fullPass;
		expect(fetches).toBe(2);
		expect(registry.find("ordered-provider", "model-v2")).toBeDefined();
		expect(registry.find("ordered-provider", "model-v1")).toBeUndefined();
	});

	test("a pass that commits after a cache-served pass still drops cached rows the endpoint no longer lists", async () => {
		mockSteadyClock();
		const modelsPath = tempDir.join("cfg", "models.json");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "http://127.0.0.1:9992",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		let listCalls = 0;
		const { promise: secondListDone, resolve: secondListResolved } = Promise.withResolvers<void>();
		const gatewayFetch: FetchImpl = async input => {
			if (String(input) !== "http://127.0.0.1:9992/v1/models") throw new Error(`offline: ${String(input)}`);
			listCalls++;
			if (listCalls === 1) return Response.json({ data: [{ id: "keep-model" }, { id: "gone-model" }] });
			// The online pass's other discoveries finish first, so its fetches resolve with this one.
			await new Promise(resolve => setTimeout(resolve, 300));
			queueMicrotask(secondListResolved);
			return Response.json({ data: [{ id: "keep-model" }] });
		};
		// An earlier start cached both rows.
		await new ModelRegistry(authStorage, modelsPath, { fetch: gatewayFetch }).refresh("online");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gatewayFetch });
		expect(registry.find("gateway", "gone-model")).toBeDefined();
		// The online pass fetches a list without gone-model, writes the cache, then merges in slices.
		const onlinePass = registry.refresh("online");
		await secondListDone;
		for (let turn = 0; turn < 2; turn++) await new Promise(resolve => setTimeout(resolve, 0));
		let onlinePassDone = false;
		void onlinePass.then(() => (onlinePassDone = true));
		// A scoped pass during that merge reads the fresh cache and commits first.
		await registry.refreshDiscoverableProviders(["gateway"], "online-if-uncached");
		expect(onlinePassDone).toBe(false);
		await onlinePass;
		expect(listCalls).toBe(2);
		expect(registry.find("gateway", "keep-model")).toBeDefined();
		expect(registry.find("gateway", "gone-model")).toBeUndefined();
	});

	test("a static reload during a merge lets the older pass commit again, so a built-in provider keeps its discovered rows", async () => {
		mockSteadyClock();
		const modelsPath = tempDir.join("cfg", "models.json");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		const writeConfig = (withOther: boolean, mtimeMs: number) => {
			const providers: Record<string, unknown> = {
				openai: { baseUrl: "https://proxy.example.com/v1", apiKey: "TEST_KEY", api: "openai-responses" },
			};
			if (withOther) {
				providers.other = {
					baseUrl: "https://other.example.com/v1",
					apiKey: "OTHER_KEY",
					api: "openai-completions",
					models: [
						{
							id: "other-model",
							name: "other-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100_000,
							maxTokens: 8_000,
						},
					],
				};
			}
			fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
			fs.utimesSync(modelsPath, new Date(mtimeMs), new Date(mtimeMs));
		};
		writeConfig(false, 1_700_000_000_000);
		let listCalls = 0;
		const { promise: firstListDone, resolve: firstListResolved } = Promise.withResolvers<void>();
		const proxyFetch: FetchImpl = async input => {
			if (String(input) !== "https://proxy.example.com/v1/models") throw new Error(`offline: ${String(input)}`);
			listCalls++;
			if (listCalls === 1) {
				// The online pass's other discoveries finish first, so its fetches resolve with this one.
				await new Promise(resolve => setTimeout(resolve, 300));
				queueMicrotask(firstListResolved);
			}
			return Response.json({ data: [{ id: "gpt-9.9-proxy" }] });
		};
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: proxyFetch });
		registry.getAll();
		// The online pass fetches gpt-9.9-proxy, writes the cache, then merges in slices.
		const onlinePass = registry.refresh("online");
		await firstListDone;
		for (let turn = 0; turn < 2; turn++) await new Promise(resolve => setTimeout(resolve, 0));
		let onlinePassDone = false;
		void onlinePass.then(() => (onlinePassDone = true));
		// A scoped pass reads that cache and commits first.
		await registry.refreshDiscoverableProviders(["openai"], "online-if-uncached");
		expect(registry.find("openai", "gpt-9.9-proxy")).toBeDefined();
		// models.yml changes and another provider refreshes: a static reload drops the scoped pass's rows.
		writeConfig(true, 1_700_000_100_000);
		await registry.refreshProvider("other", "offline");
		expect(onlinePassDone).toBe(false);
		await onlinePass;
		expect(registry.find("openai", "gpt-9.9-proxy")).toBeDefined();
	});

	test("a refresh awaited by createAgentSession takes its turns without waiting for a pending timer", async () => {
		// No model has auth here, so creation awaits refresh("online-if-uncached") before it rejects.
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { fetch: offlineFetch });
		const refresh = registry.refresh.bind(registry);
		let refreshMs = Number.NaN;
		registry.refresh = async (...args: Parameters<ModelRegistry["refresh"]>) => {
			const startedAt = performance.now();
			try {
				return await refresh(...args);
			} finally {
				refreshMs = performance.now() - startedAt;
			}
		};
		const agents = new AgentRegistry();
		agents.register({ id: "owned-worker", displayName: "B", kind: "sub", parentId: "Main", session: null, status: "idle" });
		fs.mkdirSync(tempDir.join("project"));
		// A turn that waited for the next timer would take up to this period each time.
		const pendingTimer = setInterval(() => {}, 2_000);
		try {
			await expect(
				createAgentSession({
					cwd: tempDir.join("project"),
					agentDir: tempDir.join("agent"),
					modelRegistry: registry,
					settings: Settings.isolated(),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					agentRegistry: agents,
					agentId: "owned-worker",
					agentDisplayName: "A",
					parentTaskPrefix: "owned-worker",
					parentAgentId: "Main",
					taskDepth: 1,
					expectedAgentRef: null,
				}),
			).rejects.toThrow("already owned by another session generation");
		} finally {
			clearInterval(pendingTimer);
		}
		expect(refreshMs).toBeLessThan(1_500);
	}, 30_000);
});
