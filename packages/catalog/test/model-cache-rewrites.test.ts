import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	closeModelCache,
	getModelCacheWriteStats,
	readModelCache,
	readModelCacheSteps,
	writeModelCache,
} from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { modelsDevCatalogFallback } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { __resetDirsFromEnvForTests, getModelDbPath, setAgentDir } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

const TTL_MS = 24 * 60 * 60 * 1000;

function spec(id: string, provider = "rewrite-test"): ModelSpec<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://rewrite.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function model(id: string, provider = "rewrite-test"): Model<"openai-completions"> {
	return buildModel(spec(id, provider));
}

interface PayloadRow {
	updated_at: number;
	authoritative: number;
	models: string;
}

function payloadRow(dbPath: string, providerId: string): PayloadRow | null {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query<PayloadRow, [string]>("SELECT updated_at, authoritative, models FROM model_cache WHERE provider_id = ?")
			.get(providerId);
	} finally {
		db.close();
	}
}

function payloadWrites(): number {
	return getModelCacheWriteStats().payloadWrites;
}

describe("model cache write churn", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-cache-rewrites-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("advances freshness of an unchanged refresh without rewriting the payload row", () => {
		const models = [model("a"), model("b")];
		const before = payloadWrites();
		writeModelCache("rewrite-test", 1_000, models, true, "fp", dbPath);
		expect(payloadWrites() - before).toBe(1);

		writeModelCache("rewrite-test", 2_000, [model("a"), model("b")], true, "fp", dbPath);
		expect(payloadWrites() - before).toBe(1);
		// The multi-MB record is untouched; freshness lives in the side row.
		expect(payloadRow(dbPath, "rewrite-test")?.updated_at).toBe(1_000);
		const refreshed = readModelCache("rewrite-test", TTL_MS, () => 2_500, dbPath);
		expect(refreshed?.updatedAt).toBe(2_000);
		expect(refreshed?.fresh).toBe(true);
		expect(refreshed?.authoritative).toBe(true);

		// An identical repeat is a complete no-op.
		const skippedBefore = getModelCacheWriteStats().skippedWrites;
		writeModelCache("rewrite-test", 2_000, models, true, "fp", dbPath);
		expect(getModelCacheWriteStats().skippedWrites - skippedBefore).toBe(1);
		expect(payloadWrites() - before).toBe(1);
	});

	it("flips authority without rewriting an unchanged payload", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		const before = payloadWrites();
		writeModelCache("rewrite-test", 2_000, [model("a")], false, "fp", dbPath);
		expect(payloadWrites()).toBe(before);
		const entry = readModelCache("rewrite-test", TTL_MS, () => 2_000, dbPath);
		expect(entry?.authoritative).toBe(false);
		expect(entry?.updatedAt).toBe(2_000);
		// The side row carries freshness and retry authority only; the payload still
		// records that its models came from an authoritative discovery result.
		expect(entry?.payloadAuthoritative).toBe(true);
		expect(payloadRow(dbPath, "rewrite-test")?.authoritative).toBe(1);
	});

	it("rewrites a changed payload and drops the stale freshness row", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		writeModelCache("rewrite-test", 2_000, [model("a")], true, "fp", dbPath);
		const before = payloadWrites();
		writeModelCache("rewrite-test", 3_000, [model("a"), model("c")], false, "fp", dbPath);
		expect(payloadWrites() - before).toBe(1);
		const entry = readModelCache("rewrite-test", TTL_MS, () => 3_000, dbPath);
		expect(entry?.models.map(m => m.id)).toEqual(["a", "c"]);
		expect(entry?.updatedAt).toBe(3_000);
		expect(entry?.authoritative).toBe(false);
		const db = new Database(dbPath, { readonly: true });
		const refreshRows = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache_refresh").get();
		db.close();
		expect(refreshRows?.count).toBe(0);
	});

	it("ignores a side row left behind by a payload another writer replaced", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		writeModelCache("rewrite-test", 5_000, [model("a")], true, "fp", dbPath);
		// Simulate an older binary rewriting the payload without knowing the side table.
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET updated_at = 3000, authoritative = 0 WHERE provider_id = 'rewrite-test'");
		db.close();
		const entry = readModelCache("rewrite-test", TTL_MS, () => 3_000, dbPath);
		expect(entry?.updatedAt).toBe(3_000);
		expect(entry?.authoritative).toBe(false);
	});

	/** Serialized `models` payload for `ids`, as this binary writes it. */
	function payloadFor(ids: string[]): string {
		const otherPath = path.join(tempDir, "payload-source.db");
		writeModelCache(
			"rewrite-test",
			1_000,
			ids.map(id => model(id)),
			true,
			"fp",
			otherPath,
		);
		const row = payloadRow(otherPath, "rewrite-test");
		if (!row) throw new Error("expected payload row");
		return row.models;
	}

	it("re-reads a row an older binary replaced without recording its payload hash", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
		const replacement = payloadFor(["a", "legacy"]);
		const db = new Database(dbPath);
		db.run(
			`INSERT OR REPLACE INTO model_cache (
				provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
				header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version, models
			)
			SELECT provider_id, version, materialization_policy, updated_at, authoritative, static_fingerprint,
				header_omitted_model_ids, unrestorable_header_model_ids, header_restore_version, ?
			FROM model_cache WHERE provider_id = 'rewrite-test'`,
			[replacement],
		);
		db.close();
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual([
			"a",
			"legacy",
		]);
	});

	it("re-reads and rewrites a payload edited in place", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
		const edited = payloadFor(["a", "edited"]);
		const db = new Database(dbPath);
		db.run("UPDATE model_cache SET models = ? WHERE provider_id = 'rewrite-test'", [edited]);
		db.close();
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual([
			"a",
			"edited",
		]);

		// Writing the original snapshot again must replace the edited row, not skip it as unchanged.
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		expect(readModelCache("rewrite-test", TTL_MS, () => 1_000, dbPath)?.models.map(m => m.id)).toEqual(["a"]);
	});

	it("does not re-persist an unchanged snapshot while discovery keeps failing", async () => {
		let online = true;
		let clock = 10_000;
		const options = {
			providerId: "failing-discovery-test",
			staticModels: [spec("static-a", "failing-discovery-test")],
			cacheDbPath: dbPath,
			now: () => clock,
			fetchDynamicModels: async () => {
				if (!online) throw new Error("offline");
				return [spec("dynamic-a", "failing-discovery-test")];
			},
		};
		await resolveProviderModels(options, "online");
		online = false;
		clock += 60_000;
		await resolveProviderModels(options, "online");
		const before = payloadWrites();
		const row = payloadRow(dbPath, "failing-discovery-test");
		for (let attempt = 0; attempt < 3; attempt++) {
			clock += 5 * 60_000;
			await resolveProviderModels(options, "online");
		}
		expect(payloadWrites()).toBe(before);
		expect(payloadRow(dbPath, "failing-discovery-test")).toEqual(row);
		// Freshness still advances so the non-authoritative retry backoff holds.
		const entry = readModelCache("failing-discovery-test", TTL_MS, () => clock, dbPath);
		expect(entry?.updatedAt).toBe(clock);
		expect(entry?.authoritative).toBe(false);
		expect(entry?.models.map(m => m.id).sort()).toEqual(["dynamic-a", "static-a"]);
	});

	it("reads back every bundled provider snapshot it writes", () => {
		const rejected: string[] = [];
		for (const providerId of getBundledProviders()) {
			const models = getBundledModels(providerId as GeneratedProvider);
			writeModelCache(providerId, Date.now(), models, false, "fp", dbPath);
			const entry = readModelCache(providerId, TTL_MS, Date.now, dbPath);
			if (entry?.models.length !== models.length) rejected.push(providerId);
		}
		expect(rejected).toEqual([]);
	});

	it("keeps an offline fallback snapshot instead of writing and deleting it every startup", async () => {
		const offlineFetch: FetchImpl = async () => {
			throw new Error("offline");
		};
		const modelsDev = modelsDevCatalogFallback("azure", offlineFetch);
		if (!modelsDev) throw new Error("azure has no shared catalog fallback");
		const options = { providerId: "azure", modelsDev, cacheDbPath: dbPath };
		const bundled = getBundledModels("azure");
		expect(bundled.length).toBeGreaterThan(0);
		expect(bundled.some(m => m.baseUrl === "")).toBe(true);

		await resolveProviderModels(options, "online");
		const snapshot = readModelCache("azure", TTL_MS, Date.now, dbPath);
		expect(snapshot?.models.length).toBe(bundled.length);

		const before = payloadWrites();
		await resolveProviderModels(options, "online");
		expect(payloadWrites()).toBe(before);
		expect(readModelCache("azure", TTL_MS, Date.now, dbPath)?.models.length).toBe(bundled.length);
	});
});

describe("readModelCacheSteps", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-cache-steps-"));
		dbPath = path.join(tempDir, "models.db");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
			dbPath = "";
		}
	});

	it("reads a provider's row in one unit and parses it in the next", () => {
		const models = Array.from({ length: 200 }, (_, index) => model(`m-${index}`));
		writeModelCache("rewrite-test", 1_000, models, true, "fp", dbPath);
		// The payload's parse is the only JSON.parse of a text this long.
		let payloadParses = 0;
		const parse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
			if (text.length > 10_000) payloadParses++;
			return parse(text, reviver);
		});
		// A path of its own, so no earlier read of this process memoized the row.
		const steps = readModelCacheSteps<"openai-completions">("rewrite-test", TTL_MS, () => 1_000, dbPath);
		const read = steps.next();
		expect(read.done).toBe(false);
		expect(payloadParses).toBe(0);
		const parsed = steps.next();
		expect(parsed.done).toBe(true);
		expect(payloadParses).toBe(1);
		expect(parsed.value?.models.map(entry => entry.id)).toEqual(models.map(entry => entry.id));
		// A second read finds the memoized parse and takes one unit.
		const again = readModelCacheSteps<"openai-completions">("rewrite-test", TTL_MS, () => 1_000, dbPath).next();
		expect(again.done).toBe(true);
		expect(again.value?.models).toHaveLength(models.length);
	});

	it("does not memoize a parse of the row a write from this process replaced after the read", async () => {
		// The shared default connection: a write here does not move its data_version, so only the
		// memo's own bookkeeping keeps a stale parse out. The agent directory is the test's own, so the
		// shared database it opens is never the one a running omp uses.
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = path.join(tempDir, "agent");
		await fs.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		try {
			expect(getModelDbPath().startsWith(agentDir)).toBe(true);
			writeModelCache("stale-memo-test", 1_000, [model("a", "stale-memo-test")], true, "fp");
			const steps = readModelCacheSteps<"openai-completions">("stale-memo-test", TTL_MS, () => 1_000);
			expect(steps.next().done).toBe(false);
			// Another pass writes the row between this read and its parse.
			writeModelCache("stale-memo-test", 2_000, [model("b", "stale-memo-test")], true, "fp");
			expect(steps.next().value?.models.map(entry => entry.id)).toEqual(["a"]);
			// The next read, e.g. the same pass's re-read on its row turn, sees the write.
			const next = readModelCache<"openai-completions">("stale-memo-test", TTL_MS, () => 2_000);
			expect(next?.models.map(entry => entry.id)).toEqual(["b"]);
		} finally {
			closeModelCache();
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			__resetDirsFromEnvForTests();
		}
	});

	it("deletes a corrupt row only if no write replaced it between the read and the parse", () => {
		writeModelCache("rewrite-test", 1_000, [model("a")], true, "fp", dbPath);
		const corrupt = (updatedAt: number) => {
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET models = ?, updated_at = ? WHERE provider_id = 'rewrite-test'", [
				"[{not json",
				updatedAt,
			]);
			db.close();
		};
		corrupt(1_500);
		const steps = readModelCacheSteps<"openai-completions">("rewrite-test", TTL_MS, () => 2_000, dbPath);
		expect(steps.next().done).toBe(false);
		// A write lands between the read and the parse.
		writeModelCache("rewrite-test", 2_000, [model("b")], true, "fp", dbPath);
		expect(steps.next().value).toBeNull();
		expect(readModelCache("rewrite-test", TTL_MS, () => 2_000, dbPath)?.models.map(entry => entry.id)).toEqual(["b"]);
		// With no write between them, the corrupt row is deleted, as an unsliced read deletes it.
		corrupt(2_500);
		expect(readModelCache("rewrite-test", TTL_MS, () => 3_000, dbPath)).toBeNull();
		expect(payloadRow(dbPath, "rewrite-test")).toBeNull();
	});
});
