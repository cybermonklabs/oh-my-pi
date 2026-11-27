import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { exec, withToolOomScore } from "@oh-my-pi/pi-utils/ptree";

const NAME = "OMP_PTREE_ENV_PROBE";

describe("ptree child environment", () => {
	afterEach(() => {
		delete Bun.env[NAME];
	});

	// omp loads `~/.env` and the agent `.env` into `Bun.env` after startup; Bun.spawn's
	// own default environment predates those writes, so `!command` config values
	// reading such a variable resolved to an empty credential.
	it("inherits values written into Bun.env after startup", async () => {
		Bun.env[NAME] = "loaded-from-dotenv";
		const result = await exec([process.execPath, "-e", `process.stdout.write(process.env.${NAME} ?? "")`]);
		expect(result.stdout).toBe("loaded-from-dotenv");
	});
});

it.skipIf(process.platform !== "linux")("execs the tool with the spawned PID and literal arguments", async () => {
	const args = ["a b", "", '$HOME; "quoted"'];
	const child = Bun.spawn(
		withToolOomScore([
			process.execPath,
			"-e",
			"console.log(JSON.stringify([process.pid, ...process.argv.slice(1)]))",
			...args,
		]),
		{ stdout: "pipe" },
	);
	const [output, code] = await Promise.all([child.stdout.text(), child.exited]);
	expect(code).toBe(0);
	expect(JSON.parse(output)).toEqual([child.pid, ...args]);
});

it.skipIf(process.platform !== "linux")("starts the tool directly when /bin/sh is missing", async () => {
	const which = spyOn(Bun, "which").mockReturnValue(null);
	try {
		const result = await exec(withToolOomScore([process.execPath, "-e", "console.log('tool ran')"]));
		expect(result.stdout).toBe("tool ran\n");
	} finally {
		which.mockRestore();
	}
});

const SCORE = "/proc/self/oom_score_adj";

/** A tool process of this build runs this test at 1000 already: start below it, so a 1000 is the spawn's. */
async function belowToolScore(): Promise<string> {
	if ((await Bun.file(SCORE).text()).trim() === "1000") await Bun.write(SCORE, "999").catch(() => 0);
	return await Bun.file(SCORE).text();
}

it.skipIf(process.platform !== "linux")("sets 1000 in the tool and its child without changing the caller", async () => {
	const before = await belowToolScore();
	const result = await exec(
		withToolOomScore(["/bin/sh", "-c", `read -r score < ${SCORE}; echo "$score"; /bin/cat ${SCORE}`]),
	);
	expect(await Bun.file(SCORE).text()).toBe(before);
	expect(result.stdout).toBe("1000\n1000\n");
});

it.skipIf(process.platform !== "linux")("looks a bare program up on the child's PATH", async () => {
	await belowToolScore();
	using dir = TempDir.createSync("@omp-oom-path-");
	fs.writeFileSync(dir.join("omp-oom-tool"), `#!/bin/sh\n/bin/cat ${SCORE}\n`, { mode: 0o755 });
	const env = { PATH: dir.path() };
	const result = await exec(withToolOomScore(["omp-oom-tool"], { env }), { env });
	expect(result.stdout).toBe("1000\n");
	// A program that PATH does not hold fails the spawn, as it does without the wrapper.
	expect(() => Bun.spawn(withToolOomScore(["omp-oom-missing-tool"], { env }), { env })).toThrow();
	// An empty PATH: Bun's spawn does not search the working directory, so neither does the wrapper's lookup,
	// although `/bin/sh` would find the program there.
	const empty = { PATH: "" };
	const spawn = (command: string[]) => Bun.spawn(command, { env: empty, cwd: dir.path() });
	expect(() => spawn(["omp-oom-tool"])).toThrow();
	expect(() => spawn(withToolOomScore(["omp-oom-tool"], { env: empty, cwd: dir.path() }))).toThrow();
});

it.skipIf(process.platform !== "linux")("runs this process's image for /proc/self/exe", async () => {
	await belowToolScore();
	const result = await exec(
		withToolOomScore([
			"/proc/self/exe",
			"-e",
			`process.stdout.write(require("node:fs").readFileSync("${SCORE}", "utf8"))`,
		]),
	);
	expect(result.stdout).toBe("1000\n");
});
