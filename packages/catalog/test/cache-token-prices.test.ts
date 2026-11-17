import { describe, expect, it } from "bun:test";
import { calculateUsageCost, getCacheTokenPrices } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, Usage } from "@oh-my-pi/pi-catalog/types";

// claude-opus-5-5's card, per million tokens.
const opus: ModelCost = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

// A long-context tier above 200,000 prompt tokens, and half price outside 01:00-04:00 UTC on weekdays.
const tiered: ModelCost = {
	input: 1,
	output: 2,
	cacheRead: 0.1,
	cacheWrite: 1.25,
	longContext: { inputThreshold: 200_000, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 3.75 },
	timeBased: {
		offPeakMultiplier: 0.5,
		peakWindows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 60, endMinute: 240 }],
	},
};
const peak = Date.parse("2026-09-07T02:00:00Z");
const offPeak = Date.parse("2026-09-07T05:00:00Z");

function usage(input: number, cacheRead: number, cacheWrite: number, cttl?: Usage["cttl"]): Usage {
	return {
		input,
		output: 0,
		cacheRead,
		cacheWrite,
		...(cttl ? { cttl } : {}),
		totalTokens: input + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("getCacheTokenPrices", () => {
	it("prices a one-hour write at twice input and a five-minute write at the cacheWrite card", () => {
		const oneHour = getCacheTokenPrices(opus, "1h", 600_000);
		const fiveMinute = getCacheTokenPrices(opus, "5m", 600_000);
		expect(oneHour.write * 1_000_000).toBeCloseTo(8, 12);
		expect(fiveMinute.write * 1_000_000).toBeCloseTo(5, 12);
		expect(oneHour.read * 1_000_000).toBeCloseTo(0.2, 12);
		expect(fiveMinute.read * 1_000_000).toBeCloseTo(0.2, 12);
	});

	it("prices at the long-context tier and off-peak rate the bill charges", () => {
		for (const [cacheRead, timestamp, tierInput, tierRead, multiplier] of [
			[150_000, peak, 1, 0.1, 1],
			[250_000, offPeak, 3, 0.3, 0.5],
		] as const) {
			const promptTokens = 1_000 + cacheRead + 10_000;
			const prices = getCacheTokenPrices(tiered, "1h", promptTokens, timestamp);
			expect(prices.write * 1_000_000).toBeCloseTo(tierInput * 2 * multiplier, 12);
			expect(prices.read * 1_000_000).toBeCloseTo(tierRead * multiplier, 12);
			const billed = calculateUsageCost(tiered, usage(1_000, cacheRead, 10_000, { ephemeral1h: 10_000 }), timestamp);
			expect(prices.write * 10_000).toBeCloseTo(billed.cacheWrite, 15);
			expect(prices.read * cacheRead).toBeCloseTo(billed.cacheRead, 15);
		}
	});
});

describe("calculateUsageCost cache writes", () => {
	it("bills a five-minute and one-hour split exactly as before the shared rate", () => {
		// 261,000 prompt tokens select the tier (input 3, cacheWrite 3.75); off-peak halves it.
		const split = calculateUsageCost(
			tiered,
			usage(1_000, 250_000, 10_000, { ephemeral5m: 3_000, ephemeral1h: 6_000 }),
			offPeak,
		);
		// The 1,000 write tokens the breakdown misses bill at the five-minute rate.
		expect(split.cacheWrite).toBe(((3.75 / 1000000) * (3_000 + 1_000) + ((3 * 2) / 1000000) * 6_000) * 0.5);
		const flat = calculateUsageCost(tiered, usage(1_000, 250_000, 10_000), offPeak);
		expect(flat.cacheWrite).toBe((3.75 / 1000000) * 10_000 * 0.5);
	});
});
