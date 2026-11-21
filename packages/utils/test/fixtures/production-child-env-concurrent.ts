/**
 * Run by `production-child-env.test.ts` as a `bun test` of its own: two concurrent tests each make a
 * production child's environment, and print the directories it made, which must be gone once this
 * run ends.
 */
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createProductionChildEnv } from "../../../../scripts/test-env";

for (const n of [1, 2]) {
	test.concurrent(`makes a production child's environment (${n})`, () => {
		// An empty PATH has no `bun`, so the helper also makes a directory for its own.
		const env = createProductionChildEnv({ PATH: "" });
		const dirs = [env.HOME, env.PATH.split(path.delimiter)[0]];
		for (const dir of dirs) expect(fs.existsSync(dir)).toBe(true);
		console.log(`DIRS ${JSON.stringify(dirs)}`);
	});
}
