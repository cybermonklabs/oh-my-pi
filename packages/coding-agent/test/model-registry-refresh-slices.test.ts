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
