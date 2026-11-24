/**
 * The scope of a Mnemopi recall (what a recorded recall is compared with, as `omp render` and a resumed session read
 * it) names the database each recalled bank lives in, the shared bank's configured one and every other bank's own under
 * `banks/` beside it, and creates nothing: reading a transcript leaves the memories directory as it found it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { memoryRecallScope } from "@oh-my-pi/pi-coding-agent/session/session-memory";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("the scope of a Mnemopi recall", () => {
	it("names each recalled bank's database without creating a directory", () => {
		using tempDir = TempDir.createSync("@pi-mnemopi-recall-scope-");
		const memories = tempDir.join("memories");
		const dbPath = path.join(memories, "mnemopi.db");
		const settings = Settings.isolated({
			"memory.backend": "mnemopi",
			"mnemopi.dbPath": dbPath,
			"mnemopi.scoping": "per-project-tagged",
		});

		const scope = memoryRecallScope(settings, tempDir.path(), tempDir.path());

		if (scope === undefined) throw new Error("Expected a Mnemopi recall scope");
		const [backend, banks] = JSON.parse(scope) as [string, Array<[string, string]>];
		expect(backend).toBe("mnemopi");
		// The project's bank and the shared one: the project's lives in a database of its own.
		const own = banks.filter(([, file]) => file !== dbPath);
		expect(own.length).toBeGreaterThan(0);
		for (const [bank, file] of own) expect(file).toBe(path.join(memories, "banks", bank, "mnemopi.db"));
		expect(fs.existsSync(memories)).toBe(false);
	});
});
