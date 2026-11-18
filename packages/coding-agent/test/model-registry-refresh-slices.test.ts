import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { EVENT_LOOP_SLICE_MS } from "@oh-my-pi/pi-utils/event-loop-slice";

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
 * A clock that does not advance until `start()`, then advances 1 ms per read.
 * While it is still, no slice expires: a pass's discoveries finish in
 * microtasks, and a fetcher that waits for one timer resolves after all of them.
 */
function mockClockStillUntilStarted(): { start: () => void } {
	let now = 1_000;
	let running = false;
	vi.spyOn(performance, "now").mockImplementation(() => (running ? now++ : now));
	return { start: () => (running = true) };
}

/**
 * Waits until a discovery of `provider` has listed exactly `modelIds`, then for
 * one more timer. When that discovery was the last of its pass, the pass's
 * fetches have all resolved by then, and it has its place in the commit order.
 * Throws with the last discovery state when that has not happened in 4 s, inside
 * the test's 5 s timeout. (`performance.now` is mocked here; `Date.now` is not.)
 */
async function untilDiscovered(registry: ModelRegistry, provider: string, modelIds: string[]): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (registry.getProviderDiscoveryState(provider)?.models.join("\n") !== modelIds.join("\n")) {
		if (Date.now() > deadline) {
			throw new Error(
				`${provider} never listed ${JSON.stringify(modelIds)}; last state: ${JSON.stringify(registry.getProviderDiscoveryState(provider))}`,
			);
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	await new Promise(resolve => setTimeout(resolve, 0));
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
		const reference = new ModelRegistry(authStorage, tempDir.join("reference", "models.yml"), {
			fetch: offlineFetch,
		});
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

	describe("a commit over a composed full snapshot", () => {
		const row = (id: string) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		/** A registry whose models config exists, so a refresh keeps the composed snapshot. */
		const snapshotRegistry = (dir: string): ModelRegistry => {
			const modelsPath = tempDir.join(dir, "models.yml");
			fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
			fs.writeFileSync(modelsPath, "providers: {}\n");
			const registry = new ModelRegistry(authStorage, modelsPath, { fetch: offlineFetch });
			registry.registerProvider(
				"snapshot-provider",
				{
					baseUrl: "https://snapshot.example.com/v1",
					apiKey: "SNAPSHOT_KEY",
					api: "openai-completions",
					fetchDynamicModels: async () => [row("snapshot-model")],
				},
				"ext://snapshot",
			);
			return registry;
		};
		const inSnapshot = (registry: ModelRegistry, provider: string, id: string): boolean =>
			registry.getAll("all").some(model => model.provider === provider && model.id === id);
		/**
		 * Refreshes a new snapshot registry on a clock that moves 1 ms per read, and counts the reads.
		 * `onTurn` runs on each pass through the event loop with the reads so far.
		 */
		const clockReads = async (
			dir: string,
			compose: boolean,
			onTurn?: (registry: ModelRegistry, reads: number) => void,
		) => {
			const registry = snapshotRegistry(dir);
			if (compose) registry.getAll();
			let now = 1_000;
			let reads = 0;
			vi.spyOn(performance, "now").mockImplementation(() => {
				reads++;
				return now++;
			});
			const loop = countTurns(onTurn && (() => onTurn(registry, reads)));
			await registry.refresh("online");
			loop.stop();
			vi.restoreAllMocks();
			return { registry, reads };
		};

		test("rebuilds it in slices, and the snapshot it commits is unchanged", async () => {
			// Reference: the same refresh on a clock that never ends a slice.
			mockFrozenClock();
			const reference = snapshotRegistry("reference");
			reference.getAll();
			await reference.refresh("online");
			const expected = catalogText(reference.getAll());
			vi.restoreAllMocks();

			// The rebuild checks the slice once per model in each of its per-model steps, so a refresh
			// over a composed snapshot reads the clock more than once per snapshot model beyond the
			// same refresh without one.
			const lazy = await clockReads("lazy", false);
			const composed = await clockReads("composed", true);
			const snapshotSize = composed.registry.getAll("all").length;
			expect(snapshotSize).toBeGreaterThan(1_000);
			expect(inSnapshot(composed.registry, "snapshot-provider", "snapshot-model")).toBe(true);
			expect(composed.reads - lazy.reads).toBeGreaterThan(snapshotSize);
			expect(catalogText(composed.registry.getAll())).toEqual(expected);
		});
		/** True while the pass's commit holds the discovered model and the published snapshot does not yet. */
		const insideRebuild = (registry: ModelRegistry): boolean => {
			const { snapshot, unsubscribe } = registry.subscribeMirror(() => {});
			unsubscribe();
			const committed = (snapshot.discovery?.catalog?.models ?? []).some(
				model => model.provider === "snapshot-provider" && model.id === "snapshot-model",
			);
			return committed && !inSnapshot(registry, "snapshot-provider", "snapshot-model");
		};

		test("whose inputs change during every rebuild still ends, and keeps every change", async () => {
			// The rebuild's reads come after the reads a refresh without a snapshot takes in all; start
			// the changes halfway through them, once the commit has run.
			const lazy = await clockReads("lazy", false);
			const composed = await clockReads("composed", true);
			const churnFrom = lazy.reads + Math.floor((composed.reads - lazy.reads) / 2);
			// From then on, each turn registers a provider with one model: a change to what the rebuild read.
			let registrations = 0;
			let firstInsideRebuild = false;
			const { registry } = await clockReads("churn", true, (target, reads) => {
				if (reads < churnFrom) return;
				if (registrations === 0) firstInsideRebuild = insideRebuild(target);
				registrations++;
				target.registerProvider(
					`churn-${registrations}`,
					{
						baseUrl: "https://churn.example.com/v1",
						apiKey: "CHURN_KEY",
						api: "openai-completions",
						models: [row(`churn-model-${registrations}`)],
					},
					"ext://churn",
				);
			});
			expect(firstInsideRebuild).toBe(true);
			expect(registrations).toBeGreaterThan(3);
			expect(inSnapshot(registry, "snapshot-provider", "snapshot-model")).toBe(true);
			const missing = Array.from({ length: registrations }, (_, index) => index + 1).filter(
				index => !inSnapshot(registry, `churn-${index}`, `churn-model-${index}`),
			);
			expect(missing).toEqual([]);
		});

		test("ends when the snapshot is composed again during it, so a later removal stays removed", async () => {
			const lazy = await clockReads("lazy", false);
			const composed = await clockReads("composed", true);
			const actFrom = lazy.reads + Math.floor((composed.reads - lazy.reads) / 2);
			// Halfway through the rebuild: unregister the discovered provider, then compose the snapshot
			// again from the state without it.
			let acted = false;
			let actedInsideRebuild = false;
			const { registry } = await clockReads("reload", true, (target, reads) => {
				if (acted || reads < actFrom) return;
				acted = true;
				actedInsideRebuild = insideRebuild(target);
				target.unregisterProvider("snapshot-provider");
				target.getAll();
			});
			expect(actedInsideRebuild).toBe(true);
			expect(inSnapshot(registry, "snapshot-provider", "snapshot-model")).toBe(false);
		});
	});

	describe("the work before a pass's first merge", () => {
		/**
		 * For each listed provider in the order their keys were first peeked, the clock reads so far.
		 * Each slice check reads the clock once, so two providers whose lookups ran back to back in
		 * one unit of work have the same count.
		 */
		const clockReadsAtFirstPeek = async (
			providers: ReadonlySet<string>,
			refresh: () => Promise<void>,
		): Promise<number[]> => {
			let now = 1_000;
			let reads = 0;
			vi.spyOn(performance, "now").mockImplementation(() => {
				reads++;
				return now++;
			});
			const seen = new Set<string>();
			const readsAtPeek: number[] = [];
			const peek = authStorage.keys.peek.bind(authStorage.keys);
			vi.spyOn(authStorage.keys, "peek").mockImplementation((provider, options) => {
				if (providers.has(provider) && !seen.has(provider)) {
					seen.add(provider);
					readsAtPeek.push(reads);
				}
				return peek(provider, options);
			});
			await refresh();
			vi.restoreAllMocks();
			return readsAtPeek;
		};
		/** The fewest clock reads between two consecutive first peeks. */
		const fewestReadsBetween = (readsAtPeek: number[]): number =>
			Math.min(...readsAtPeek.slice(1).map((reads, index) => reads - readsAtPeek[index]));

		test("checks the slice before each built-in provider's key lookup", async () => {
			const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { fetch: offlineFetch });
			// The standard descriptors and the three special ones the registry builds its own options for.
			const descriptorIds = new Set([
				...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
				"google-antigravity",
				"google-gemini-cli",
				"openai-codex",
			]);
			const readsAtPeek = await clockReadsAtFirstPeek(descriptorIds, () => registry.refresh("offline"));
			expect(readsAtPeek.length).toBeGreaterThan(20);
			expect(fewestReadsBetween(readsAtPeek)).toBeGreaterThan(0);
		});

		test("checks the slice before each configured provider's cache read", async () => {
			const providers = Object.fromEntries(
				Array.from({ length: 20 }, (_, index) => [
					`gateway-${index}`,
					{
						baseUrl: `https://gateway-${index}.example.com/v1`,
						api: "openai-completions",
						apiKey: "GATEWAY_KEY_UNSET",
						discovery: { type: "openai-models-list" },
					},
				]),
			);
			const modelsPath = tempDir.join("configured", "models.json");
			fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
			fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
			const registry = new ModelRegistry(authStorage, modelsPath, { fetch: offlineFetch });
			let now = 1_000;
			let reads = 0;
			vi.spyOn(performance, "now").mockImplementation(() => {
				reads++;
				return now++;
			});
			// The clock reads so far at each read of a provider's cache row (the query that reads the payload).
			const readsAtRowRead: number[] = [];
			const query = Database.prototype.query;
			vi.spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
				if (sql.startsWith("SELECT m.*")) readsAtRowRead.push(reads);
				return query.call(this, sql);
			} as typeof Database.prototype.query);
			// Online with no key: each provider reads its cache row, then peeks its key and stops.
			await registry.refreshDiscoverableProviders(Object.keys(providers), "online");
			vi.restoreAllMocks();
			// Each provider's row is read more than once in a pass; every read comes after a check.
			expect(readsAtRowRead.length).toBeGreaterThanOrEqual(20);
			expect(fewestReadsBetween(readsAtRowRead)).toBeGreaterThan(0);
		});
	});

	test("a pass whose fetches resolved first does not overwrite the rows of a pass that fetched later", async () => {
		const clock = mockClockStillUntilStarted();
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
		registry.registerProvider(
			"ordered-provider",
			{
				baseUrl: "https://ordered.example.com/v1",
				apiKey: "ORDERED_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					if (fetches > 1) return [row("model-v2")];
					// Every other discovery of the full pass has finished, so its fetches resolve with this one.
					await new Promise(resolve => setTimeout(resolve, 0));
					clock.start();
					return [row("model-v1")];
				},
			},
			"ext://ordered",
		);
		// The full pass fetches v1, and its fetches resolve; it then merges the whole catalog in slices.
		const fullPass = registry.refresh("online");
		await untilDiscovered(registry, "ordered-provider", ["model-v1"]);
		expect(registry.find("ordered-provider", "model-v1")).toBeUndefined();
		// A scoped pass starts during that merge and fetches v2; it commits after the full pass.
		await registry.refreshDiscoverableProviders(["ordered-provider"], "online");
		await fullPass;
		expect(fetches).toBe(2);
		expect(registry.find("ordered-provider", "model-v2")).toBeDefined();
		expect(registry.find("ordered-provider", "model-v1")).toBeUndefined();
	});

	test("a pass that starts first but whose fetches resolve last commits last", async () => {
		const clock = mockClockStillUntilStarted();
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
		const { promise: lateFetchMayResolve, resolve: letLateFetchResolve } = Promise.withResolvers<void>();
		registry.registerProvider(
			"ordered-provider",
			{
				baseUrl: "https://ordered.example.com/v1",
				apiKey: "ORDERED_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					if (fetches > 1) return [row("model-early")];
					await lateFetchMayResolve;
					clock.start();
					return [row("model-late")];
				},
			},
			"ext://ordered",
		);
		// The full pass starts first; its fetch waits. It reaches the fetch only after
		// collecting every provider's options, so the scoped pass starts once it has.
		const fullPass = registry.refresh("online");
		const deadline = Date.now() + 4_000;
		while (fetches === 0) {
			if (Date.now() > deadline) throw new Error("the full pass never fetched");
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		// The scoped pass starts later and its fetch resolves first, so it commits without waiting for the full pass.
		await registry.refreshDiscoverableProviders(["ordered-provider"], "online");
		expect(registry.find("ordered-provider", "model-early")).toBeDefined();
		// The full pass's fetch resolves last, so its rows replace the scoped pass's.
		letLateFetchResolve();
		await fullPass;
		expect(fetches).toBe(2);
		expect(registry.find("ordered-provider", "model-late")).toBeDefined();
		expect(registry.find("ordered-provider", "model-early")).toBeUndefined();
	});

	test("a discovered catalog under another provider id is relabelled in slices", async () => {
		const row = (index: number) => ({
			id: `model-${index}`,
			name: `model-${index}`,
			provider: "upstream-provider",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});
		// Under a clock that moves 1 ms per read, each sliced step reads it once per row, plus one read
		// per slice of EVENT_LOOP_SLICE_MS reads, so the reads per extra row count the sliced steps.
		const clockReads = async (count: number): Promise<number> => {
			const registry = new ModelRegistry(authStorage, tempDir.join(`models-${count}.yml`), {
				fetch: offlineFetch,
			});
			const rows = Array.from({ length: count }, (_, index) => row(index));
			registry.registerProvider(
				"relabel-provider",
				{
					baseUrl: "https://relabel.example.com/v1",
					apiKey: "RELABEL_KEY",
					api: "openai-completions",
					fetchDynamicModels: async () => rows,
				},
				"ext://relabel",
			);
			let now = 1_000;
			let reads = 0;
			vi.spyOn(performance, "now").mockImplementation(() => {
				reads++;
				return now++;
			});
			await registry.refreshDiscoverableProviders(["relabel-provider"], "online");
			vi.restoreAllMocks();
			expect(registry.find("relabel-provider", `model-${count - 1}`)?.provider).toBe("relabel-provider");
			return reads;
		};
		const readsPerRow = ((await clockReads(2_000)) - (await clockReads(1_000))) / 1_000;
		// Measured: 6 sliced steps per row; 5 with the relabel unsliced. An exact count, so a step
		// that gains a per-row check cannot hide an unsliced relabel.
		expect(readsPerRow).toBeCloseTo(6 * (1 + 1 / EVENT_LOOP_SLICE_MS), 1);
	});

	test("a pass that stops before its commit does not let a later pass commit before an earlier one", async () => {
		const clock = mockClockStillUntilStarted();
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
		registry.registerProvider(
			"chained-provider",
			{
				baseUrl: "https://chained.example.com/v1",
				apiKey: "CHAINED_KEY",
				api: "openai-completions",
				fetchDynamicModels: async () => {
					fetches++;
					if (fetches > 1) return [row("model-v2")];
					await new Promise(resolve => setTimeout(resolve, 0));
					clock.start();
					return [row("model-v1")];
				},
			},
			"ext://chained",
		);
		const order: string[] = [];
		// A: a full pass whose fetches resolve with v1; it then merges in slices.
		const fullPass = registry.refresh("online").then(() => order.push("full"));
		await untilDiscovered(registry, "chained-provider", ["model-v1"]);
		// B: a pass with nothing to commit, which stops between A and C.
		await registry.refreshDiscoverableProviders(["no-such-provider"], "online").then(() => order.push("stopped"));
		expect(registry.find("chained-provider", "model-v1")).toBeUndefined();
		// C: a later pass that fetches v2 and must commit after A.
		const laterPass = registry
			.refreshDiscoverableProviders(["chained-provider"], "online")
			.then(() => order.push("later"));
		await Promise.all([fullPass, laterPass]);
		expect(order).toEqual(["stopped", "full", "later"]);
		expect(registry.find("chained-provider", "model-v2")).toBeDefined();
		expect(registry.find("chained-provider", "model-v1")).toBeUndefined();
	});

	test("a cache-served pass during an online pass's merge keeps the list the online pass fetched", async () => {
		const clock = mockClockStillUntilStarted();
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
		const gatewayFetch: FetchImpl = async input => {
			if (String(input) !== "http://127.0.0.1:9992/v1/models") throw new Error(`offline: ${String(input)}`);
			listCalls++;
			if (listCalls === 1) return Response.json({ data: [{ id: "keep-model" }, { id: "gone-model" }] });
			// Every other discovery of the online pass has finished, so its fetches resolve with this one.
			await new Promise(resolve => setTimeout(resolve, 0));
			clock.start();
			return Response.json({ data: [{ id: "keep-model" }] });
		};
		// An earlier start cached both rows.
		await new ModelRegistry(authStorage, modelsPath, { fetch: gatewayFetch }).refresh("online");
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gatewayFetch });
		expect(registry.find("gateway", "gone-model")).toBeDefined();
		// The online pass fetches a list without gone-model, writes the cache, then merges in slices.
		const onlinePass = registry.refresh("online");
		await untilDiscovered(registry, "gateway", ["keep-model"]);
		expect(registry.find("gateway", "gone-model")).toBeDefined();
		// A scoped pass during that merge reads the fresh cache; it commits after the online pass.
		await registry.refreshDiscoverableProviders(["gateway"], "online-if-uncached");
		expect(registry.find("gateway", "gone-model")).toBeUndefined();
		await onlinePass;
		expect(listCalls).toBe(2);
		expect(registry.find("gateway", "keep-model")).toBeDefined();
		expect(registry.find("gateway", "gone-model")).toBeUndefined();
	});

	test("a pass whose configuration is reloaded during its merge does not commit what it merged before", async () => {
		const clock = mockClockStillUntilStarted();
		const modelsPath = tempDir.join("cfg", "models.json");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "http://127.0.0.1:9993",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		const gatewayFetch: FetchImpl = async input => {
			if (String(input) !== "http://127.0.0.1:9993/v1/models") throw new Error(`offline: ${String(input)}`);
			// Every other discovery of the online pass has finished, so its fetches resolve with this one.
			await new Promise(resolve => setTimeout(resolve, 0));
			clock.start();
			return Response.json({ data: [{ id: "removed-model" }] });
		};
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gatewayFetch });
		const onlinePass = registry.refresh("online");
		await untilDiscovered(registry, "gateway", ["removed-model"]);
		expect(registry.find("gateway", "removed-model")).toBeUndefined();
		// During the online pass's merge the gateway leaves the configuration, and
		// the next refresh reloads it: the online pass's merge read a provider that is gone.
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(modelsPath, later, later);
		const reloadingPass = registry.refresh("offline");
		await Promise.all([onlinePass, reloadingPass]);
		expect(registry.find("gateway", "removed-model")).toBeUndefined();
	});

	test("a pass whose configuration is reloaded while it waits for an earlier commit does not commit what it merged", async () => {
		const clock = mockClockStillUntilStarted();
		const modelsPath = tempDir.join("cfg", "models.json");
		fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "http://127.0.0.1:9994",
						api: "openai-completions",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);
		let listCalls = 0;
		const gatewayFetch: FetchImpl = async input => {
			if (String(input) !== "http://127.0.0.1:9994/v1/models") throw new Error(`offline: ${String(input)}`);
			listCalls++;
			if (listCalls > 1) return Response.json({ data: [{ id: "scoped-model" }] });
			// Every other discovery of the full pass has finished, so its fetches resolve with this one.
			await new Promise(resolve => setTimeout(resolve, 0));
			clock.start();
			return Response.json({ data: [{ id: "full-model" }] });
		};
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: gatewayFetch });
		// The full pass merges the whole catalog in slices; the scoped pass merges one
		// provider, then waits for the full pass's commit.
		const fullPass = registry.refresh("online");
		await untilDiscovered(registry, "gateway", ["full-model"]);
		const scopedPass = registry.refreshDiscoverableProviders(["gateway"], "online");
		await untilDiscovered(registry, "gateway", ["scoped-model"]);
		for (let turn = 0; turn < 50; turn++) await new Promise(resolve => setTimeout(resolve, 0));
		expect(registry.find("gateway", "full-model")).toBeUndefined();
		// While the scoped pass waits, the gateway leaves the configuration and the next refresh reloads it.
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		const later = new Date(Date.now() + 60_000);
		fs.utimesSync(modelsPath, later, later);
		await Promise.all([fullPass, scopedPass, registry.refresh("offline")]);
		expect(listCalls).toBe(2);
		expect(registry.find("gateway", "scoped-model")).toBeUndefined();
		expect(registry.find("gateway", "full-model")).toBeUndefined();
	});

	test("a refresh awaited by createAgentSession takes its turns without waiting for a pending timer", async () => {
		// With a default role configured, creation awaits refresh("online-if-uncached")
		// before it rejects, whatever credentials the environment holds.
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
		agents.register({
			id: "owned-worker",
			displayName: "B",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		fs.mkdirSync(tempDir.join("project"));
		// A turn that waited for the next timer would take up to this period each time.
		const pendingTimer = setInterval(() => {}, 20_000);
		try {
			await expect(
				createAgentSession({
					cwd: tempDir.join("project"),
					agentDir: tempDir.join("agent"),
					modelRegistry: registry,
					settings: Settings.isolated({ modelRoles: { default: "no-such-provider/no-such-model" } }),
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
		expect(Number.isNaN(refreshMs)).toBe(false);
		// Far below one 20 s timer period, and far above what a loaded machine adds to a refresh.
		expect(refreshMs).toBeLessThan(10_000);
	}, 30_000);
});
