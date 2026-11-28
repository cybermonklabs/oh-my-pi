import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { setToolOomScore } from "../src/oom-score";

// Failure mode: a tool process whose OOM adjustment the write cannot change fails to start, where it should run with
// the value it has. The writes go to files of a temporary directory in place of `/proc/self/oom_score_adj`.
describe.skipIf(process.platform !== "linux")("setToolOomScore", () => {
	it("writes 1000 where the write is allowed", () => {
		using dir = TempDir.createSync("@omp-oom-score-");
		const score = dir.join("oom_score_adj");
		fs.writeFileSync(score, "0\n");
		setToolOomScore(score);
		expect(fs.readFileSync(score, "utf8")).toBe("1000");
	});

	// Root writes a read-only file all the same.
	it.skipIf(process.getuid?.() === 0)("leaves the value and goes on where the file is read-only", () => {
		using dir = TempDir.createSync("@omp-oom-score-");
		const score = dir.join("oom_score_adj");
		fs.writeFileSync(score, "0\n");
		fs.chmodSync(score, 0o444);
		expect(() => setToolOomScore(score)).not.toThrow();
		expect(fs.readFileSync(score, "utf8")).toBe("0\n");
	});

	it("leaves the value and goes on where the path is no file it can write", () => {
		using dir = TempDir.createSync("@omp-oom-score-");
		const directory = dir.join("oom_score_adj");
		fs.mkdirSync(directory);
		expect(() => setToolOomScore(directory)).not.toThrow();
		expect(fs.statSync(directory).isDirectory()).toBe(true);
		const missing = dir.join("missing", "oom_score_adj");
		expect(() => setToolOomScore(missing)).not.toThrow();
		expect(fs.existsSync(missing)).toBe(false);
	});
});
