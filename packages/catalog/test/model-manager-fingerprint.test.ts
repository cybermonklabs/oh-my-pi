import { describe, expect, it } from "bun:test";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";

describe("fingerprintStaticModels", () => {
	it("hashes exactly JSON.stringify of the catalog, so cache rows written by a build that serialized it in one step still match", () => {
		const prefix = fingerprintStaticModels([], { additive: true }).slice(0, -":empty".length);
		let checked = 0;
		for (const provider of getBundledProviders()) {
			const models = getBundledModels(provider);
			if (models.length === 0) continue;
			expect(fingerprintStaticModels(models, { additive: true })).toBe(
				`${prefix}:${Bun.hash(JSON.stringify(models)).toString(36)}`,
			);
			checked++;
		}
		expect(checked).toBeGreaterThan(10);
	});
});
