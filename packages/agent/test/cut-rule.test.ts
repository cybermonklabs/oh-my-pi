import { describe, expect, it } from "bun:test";
import { type ContextCutInputs, decideContextCut, meanPromptGrowth } from "@oh-my-pi/pi-agent-core/compaction/cut-rule";

// claude-opus-5-5 with one-hour writes: w = $8 and r = $0.20 per million tokens, so (w - r) / r = 39.
const writePrice = 8 / 1_000_000;
const readPrice = 0.2 / 1_000_000;
const HOUR_MS = 3_600_000;

// A 21,500-token prune at position 100,000 of a 600,000-token prompt, ten minutes into a one-hour
// cache entry, with the threshold at 850,000 and 1,000 tokens of growth a request. It leaves
// 478,500 tokens to write again, so it pays only from N >= 478,500 * 39 / 21,500 = 867.98.
const prune: ContextCutInputs = {
	promptTokens: 600_000,
	prefixTokens: 100_000,
	removedTokens: 21_500,
	readPrice,
	writePrice,
	thresholdTokens: 850_000,
	growthPerRequest: 1_000,
	idleMs: 600_000,
	lifeMs: HOUR_MS,
	forced: false,
};

describe("decideContextCut", () => {
	it("holds a prune whose saved reads before the threshold cost less than its rewrite", () => {
		const decision = decideContextCut(prune);
		expect(decision).toMatchObject({ admitted: false, reason: "waits", requestsToThreshold: 271 });
		expect(decision.saving).toBeCloseTo(271 * 21_500 * readPrice, 12);
		expect(decision.writeCost).toBeCloseTo(478_500 * (writePrice - readPrice), 12);
	});

	it("admits the prune at 868 requests to the threshold and holds it at 867", () => {
		// floor(271,500 / 312.5) = 868 and floor(271,500 / 313) = 867.
		expect(decideContextCut({ ...prune, growthPerRequest: 312.5 })).toMatchObject({
			admitted: true,
			reason: "pays",
			requestsToThreshold: 868,
		});
		expect(decideContextCut({ ...prune, growthPerRequest: 313 })).toMatchObject({
			admitted: false,
			reason: "waits",
			requestsToThreshold: 867,
		});
	});

	it("holds a cut whose saved reads only equal its rewrite", () => {
		// N = floor((910 - 900) / 1) = 10: saving 10 * 100 * 1 = 1,000 = (1,000 - 400 - 100) * (3 - 1).
		const tie = { ...prune, promptTokens: 1_000, prefixTokens: 400, removedTokens: 100, thresholdTokens: 910 };
		const decision = decideContextCut({ ...tie, readPrice: 1, writePrice: 3, growthPerRequest: 1 });
		expect(decision).toEqual({
			admitted: false,
			reason: "waits",
			requestsToThreshold: 10,
			saving: 1_000,
			writeCost: 1_000,
		});
	});

	it("admits a threshold compaction that keeps only the tools and system prompt", () => {
		// Keeps 30,000 tokens cached and sends 60,000: 30,000 to write again, paid back from N >= 2.
		const decision = decideContextCut({
			...prune,
			promptTokens: 850_000,
			prefixTokens: 30_000,
			removedTokens: 790_000,
		});
		expect(decision).toMatchObject({ admitted: true, reason: "pays", requestsToThreshold: 790 });
		expect(decision.writeCost).toBeCloseTo(30_000 * (writePrice - readPrice), 12);
	});

	it("admits a held prune once the last request's cache entry has lapsed", () => {
		expect(decideContextCut({ ...prune, idleMs: HOUR_MS })).toMatchObject({ admitted: true, reason: "lapsed" });
		expect(decideContextCut({ ...prune, idleMs: HOUR_MS - 1 })).toMatchObject({ admitted: false, reason: "waits" });
	});

	it("admits a held prune the request cannot be served without", () => {
		expect(decideContextCut({ ...prune, forced: true })).toMatchObject({ admitted: true, reason: "forced" });
	});

	it("admits a cut on a model without cache prices that the same figures hold on a priced one", () => {
		expect(decideContextCut(prune)).toMatchObject({ admitted: false, reason: "waits" });
		const free = decideContextCut({ ...prune, readPrice: 0, writePrice: 0 });
		expect(free).toMatchObject({ admitted: true, reason: "pays", saving: 0, writeCost: 0 });
	});

	it("admits a cut on degenerate figures that leaves nothing to write, and reports them finite and non-negative", () => {
		// NaN removed and idle count as 0, negative growth as 1, a cut position past the prompt end as nothing to write.
		const decision = decideContextCut({
			...prune,
			removedTokens: Number.NaN,
			prefixTokens: 700_000,
			growthPerRequest: -5,
			idleMs: Number.NaN,
		});
		expect(decision).toEqual({
			admitted: true,
			reason: "pays",
			requestsToThreshold: 250_000,
			saving: 0,
			writeCost: 0,
		});
	});
});

describe("meanPromptGrowth", () => {
	it("averages the growth of the last 20 requests only", () => {
		// One 50,000-token jump, then 20 requests growing 1,000 tokens each.
		const sizes = [0, 50_000, ...Array.from({ length: 20 }, (_, i) => 51_000 + i * 1_000)];
		expect(meanPromptGrowth(sizes)).toBe(1_000);
	});

	it("leaves a cut's shrink out of the growth", () => {
		expect(meanPromptGrowth([100_000, 102_000, 20_000, 22_000])).toBe(2_000);
	});

	it("floors growth at one token", () => {
		expect(meanPromptGrowth([500_000])).toBe(1);
		expect(meanPromptGrowth([500_000, 500_000])).toBe(1);
	});
});
