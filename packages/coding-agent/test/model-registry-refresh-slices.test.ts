import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
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

/** Counts event loop turns until stopped. */
function countTurns(onTurn?: () => void): { turns: () => number; stop: () => void } {
	let turns = 0;
	let running = true;
	const tick = () => {
		if (!running) return;
		turns++;
		onTurn?.();
		setImmediate(tick);
	};
	setImmediate(tick);
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
});
