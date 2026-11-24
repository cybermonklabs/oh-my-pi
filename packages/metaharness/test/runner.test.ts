import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildHarborEnv,
	buildResumeArgs,
	collectForwardEnv,
	parseArgs,
	readTrials,
	resolveResumeConfig,
	runBenchmark,
} from "../src/runner";

describe("generic agent-arg / env passthrough", () => {
	it("forwards repeated --agent-arg as a JSON array the in-container agent can parse", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--agent-arg",
			"--prewalk",
			"--agent-arg",
			"--prewalk-into",
			"--agent-arg",
			"google/gemini-3.5-flash",
		]);
		expect(cfg.agentArgs).toEqual(["--prewalk", "--prewalk-into", "google/gemini-3.5-flash"]);

		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(JSON.parse(env.OMP_BENCH_AGENT_ARGS ?? "[]")).toEqual(cfg.agentArgs);
	});

	it("omits OMP_BENCH_AGENT_ARGS when no --agent-arg was passed", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test");
		expect(env.OMP_BENCH_AGENT_ARGS).toBeUndefined();
	});

	it("explicit --providers is authoritative; the default derives from the model", () => {
		// Explicit list: exactly what was asked for — the escape hatch that lets
		// the model's own provider authenticate directly (forwarded env key)
		// while only e.g. oauth-only providers route through the gateway.
		const explicit = parseArgs(["--model", "anthropic/claude-opus-4-8", "--providers", "google"]);
		const envExplicit = buildHarborEnv(explicit, "/tmp/models.yml", null, "test");
		expect(new Set(envExplicit.OMP_BENCH_GATEWAY_PROVIDERS?.split(","))).toEqual(new Set(["google"]));
		// No flag: the model's provider is gateway-routed by default.
		const derived = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		const envDerived = buildHarborEnv(derived, "/tmp/models.yml", null, "test");
		expect(new Set(envDerived.OMP_BENCH_GATEWAY_PROVIDERS?.split(","))).toEqual(new Set(["anthropic"]));
	});

	it("collects explicit --env pairs, with an explicit value winning over a bare host-forwarded key", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--env",
			"SOME_FLAG=1",
			"--env",
			"OTHER=two words",
		]);
		const forwarded = collectForwardEnv(cfg);
		expect(forwarded.SOME_FLAG).toBe("1");
		expect(forwarded.OTHER).toBe("two words");
	});
});

describe("install modes", () => {
	it("defaults to source mode and publishes the mount contract to the agent", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		expect(cfg.install).toBe("source");
		const env = buildHarborEnv(cfg, "/tmp/models.yml", null, "test", {
			arch: "arm64",
			depsDir: "/tmp/deps",
			nodeModules: ["node_modules"],
		});
		expect(env.OMP_BENCH_INSTALL).toBe("source");
		expect(env.OMP_BENCH_SOURCE_DIR).toBe("/opt/omp/src");
		expect(env.OMP_BENCH_SOURCE_BUN).toBe("/opt/omp/bin/bun");
		expect(env.OMP_BENCH_SOURCE_ARCH).toBe("arm64");
	});

	it("omits source mount env when no mount was prepared (binary/local runs)", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--install", "local"]);
		const env = buildHarborEnv(cfg, "/tmp/models.yml", "/tmp/omp.tgz", "test");
		expect(env.OMP_BENCH_INSTALL).toBe("local");
		expect(env.OMP_BENCH_SOURCE_DIR).toBeUndefined();
		expect(env.OMP_BENCH_SOURCE_ARCH).toBeUndefined();
	});

	it("--tarball implies a local (tarball) install", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--tarball", "/tmp/omp.tgz"]);
		expect(cfg.install).toBe("local");
		expect(cfg.build).toBe(false);
	});
});

describe("parseArgs validation", () => {
	it("rejects an unknown flag", () => {
		expect(() => parseArgs(["--model", "anthropic/claude-opus-4-8", "--not-a-real-flag"])).toThrow(/unknown flag/);
	});
});

describe("environment backends", () => {
	it("apple-container swaps the default gateway host to the vmnet bridge address", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8", "--environment", "apple-container"]);
		expect(cfg.envType).toBe("apple-container");
		expect(cfg.gatewayUrl).toBe("http://192.168.64.1:4000");
	});

	it("an explicit --gateway-url wins over the apple-container default, regardless of flag order", () => {
		const cfg = parseArgs([
			"--model",
			"anthropic/claude-opus-4-8",
			"--gateway-url",
			"http://10.0.0.5:9999",
			"--environment",
			"apple-container",
		]);
		expect(cfg.gatewayUrl).toBe("http://10.0.0.5:9999");
	});

	it("rejects --host-network with apple-container (compose overlay is docker-only)", () => {
		expect(() =>
			parseArgs(["--model", "anthropic/claude-opus-4-8", "--environment", "apple-container", "--host-network"]),
		).toThrow(/docker-only/);
	});

	it("rejects an invalid --environment value", () => {
		expect(() => parseArgs(["--model", "anthropic/claude-opus-4-8", "--environment", "podman"])).toThrow(
			/--environment must be/,
		);
	});
});

describe("live-trial cost probe", () => {
	const usageEvent = (cost: number, input: number, output: number): string =>
		`${JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				usage: { input, output, cacheRead: 0, cost: { total: cost } },
			},
		})}\n`;

	it("accumulates usage incrementally across appended transcript writes", () => {
		const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-runner-test-"));
		try {
			const agentDir = path.join(jobDir, "task__abc", "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			const log = path.join(agentDir, "omp.txt");

			// First flush: one complete event plus a partial line mid-write.
			fs.writeFileSync(log, `${usageEvent(0.5, 100, 10)}{"type":"mess`);
			let [trial] = readTrials(jobDir);
			expect(trial.status).toBe("running");
			expect(trial.costUsd).toBeCloseTo(0.5);
			expect(trial.tokIn).toBe(100);

			// Second flush completes the partial line and appends another event.
			// Only appended bytes are parsed: the first event must count once.
			fs.appendFileSync(log, `age_end"}\n${usageEvent(0.25, 40, 4)}`);
			[trial] = readTrials(jobDir);
			expect(trial.costUsd).toBeCloseTo(0.75);
			expect(trial.tokIn).toBe(140);
			expect(trial.tokOut).toBe(14);
		} finally {
			fs.rmSync(jobDir, { recursive: true, force: true });
		}
	});
});
describe("resume", () => {
	const mkJob = (opts: {
		envType?: string;
		managerConfig?: Record<string, unknown>;
		runnerConfig?: Record<string, unknown>;
	}): { jobsDir: string; jobName: string } => {
		const jobsDir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-resume-test-"));
		const jobName = "job-x";
		const jobDir = path.join(jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(
			path.join(jobDir, "config.json"),
			JSON.stringify({ environment: { type: opts.envType ?? "docker" } }),
		);
		if (opts.managerConfig) {
			fs.writeFileSync(
				path.join(jobDir, "manager.json"),
				JSON.stringify({
					benchmark: "harbor",
					jobName,
					dataset: "swe-bench/swe-bench-verified",
					config: opts.managerConfig,
				}),
			);
		}
		if (opts.runnerConfig) {
			const benchDir = path.join(jobsDir, "_bench", jobName);
			fs.mkdirSync(benchDir, { recursive: true });
			fs.writeFileSync(path.join(benchDir, "runner-config.json"), JSON.stringify(opts.runnerConfig));
		}
		return { jobsDir, jobName };
	};

	it("recovers the full launch config from manager.json (API-launched runs)", () => {
		const { jobsDir, jobName } = mkJob({
			managerConfig: {
				benchmark: "harbor",
				model: "openai/gpt-5.6-sol",
				include: ["swe-bench/django__django-13837"],
				timeoutMultiplier: 2,
				extraArgs: ["--providers", "openai-codex", "--agent-arg", "--downshift", "--env", "FOO=bar"],
			},
		});
		try {
			const cfg = resolveResumeConfig(parseArgs(["--resume", jobName, "--jobs-dir", jobsDir]));
			expect(cfg.jobName).toBe(jobName);
			expect(cfg.jobsDir).toBe(jobsDir);
			expect(cfg.models).toEqual(["openai/gpt-5.6-sol"]);
			expect(cfg.dataset).toBe("swe-bench/swe-bench-verified");
			expect(cfg.timeoutMultiplier).toBe(2);
			expect(cfg.providers).toEqual(["openai-codex"]);
			expect(cfg.agentArgs).toEqual(["--downshift"]);
			expect(cfg.env).toEqual({ FOO: "bar" });
		} finally {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	it("prefers the runner-config.json snapshot and forces the recorded container backend", () => {
		const { jobsDir, jobName } = mkJob({
			envType: "apple-container",
			managerConfig: { model: "wrong/model" },
			runnerConfig: { models: ["anthropic/claude-opus-4-8"], envType: "docker" },
		});
		try {
			const cfg = resolveResumeConfig(
				parseArgs(["--resume", jobName, "--jobs-dir", jobsDir, "--filter-error-type", "RewardFileNotFoundError"]),
			);
			expect(cfg.models).toEqual(["anthropic/claude-opus-4-8"]);
			// config.json's recorded backend wins, incl. the gateway host swap.
			expect(cfg.envType).toBe("apple-container");
			expect(cfg.gatewayUrl).toContain("192.168.64.1");
			// resume-invocation knobs come from the CLI, not the snapshot
			expect(cfg.filterErrorTypes).toEqual(["RewardFileNotFoundError"]);
		} finally {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	it("rejects a job dir without a recorded launch config or without harbor's config.json", () => {
		const { jobsDir, jobName } = mkJob({});
		try {
			expect(() => resolveResumeConfig(parseArgs(["--resume", jobName, "--jobs-dir", jobsDir]))).toThrow(
				/no recorded launch config/,
			);
			expect(() => resolveResumeConfig(parseArgs(["--resume", "ghost", "--jobs-dir", jobsDir]))).toThrow(
				/no harbor config.json/,
			);
		} finally {
			fs.rmSync(jobsDir, { recursive: true, force: true });
		}
	});

	it("re-adds harbor's CancelledError default when explicit -f filters would replace it", () => {
		const withFilters = parseArgs(["--resume", "j", "--filter-error-type", "RewardFileNotFoundError"]);
		expect(buildResumeArgs(withFilters, "/jobs/j")).toEqual([
			"job",
			"resume",
			"-p",
			"/jobs/j",
			"-f",
			"CancelledError",
			"-f",
			"RewardFileNotFoundError",
		]);
		// No explicit filters → no -f flags: harbor's own default applies.
		const bare = parseArgs(["--resume", "j"]);
		expect(buildResumeArgs(bare, "/jobs/j")).toEqual(["job", "resume", "-p", "/jobs/j"]);
	});
});

describe("harbor telemetry", () => {
	const savedEnv = {
		HOME: process.env.HOME,
		PATH: process.env.PATH,
		HARBOR_TELEMETRY: process.env.HARBOR_TELEMETRY,
	};
	const roots: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	});

	/**
	 * Put a stand-in `harbor` first on PATH that records its argv and the
	 * HARBOR_TELEMETRY it was started with, and capture the runner's output.
	 * The runner looks harbor up through a login shell, whose /etc/profile may
	 * reset PATH, so the temporary HOME's .bash_profile puts the stub first too.
	 */
	const stubHarbor = (): { jobsDir: string; argv: () => string[]; telemetry: () => string; stdout: string[] } => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-telemetry-test-"));
		roots.push(root);
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		const argvFile = path.join(root, "harbor.argv");
		const telemetryFile = path.join(root, "harbor.telemetry");
		fs.writeFileSync(
			path.join(bin, "harbor"),
			[
				"#!/bin/sh",
				`printf '%s\\n' "$@" > '${argvFile}'`,
				`printf '%s' "\${HARBOR_TELEMETRY-__unset__}" > '${telemetryFile}'`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		fs.writeFileSync(path.join(root, ".bash_profile"), `PATH='${bin}':"$PATH"; export PATH\n`);
		process.env.HOME = root;
		process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
		// The progress loop sleeps 10 s per frame off a terminal.
		const realSleep = Bun.sleep.bind(Bun);
		vi.spyOn(Bun, "sleep").mockImplementation(() => realSleep(10));
		const stdout: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(String(chunk));
			return true;
		});
		return {
			jobsDir: path.join(root, "jobs"),
			argv: () => fs.readFileSync(argvFile, "utf8").split("\n").filter(Boolean),
			telemetry: () => fs.readFileSync(telemetryFile, "utf8"),
			stdout,
		};
	};

	const newRun = (jobsDir: string, jobName: string, ...extra: string[]) =>
		parseArgs(["--agent", "nop", "--tasks", "1", "--jobs-dir", jobsDir, "--job-name", jobName, ...extra]);

	it("starts `harbor run` with HARBOR_TELEMETRY=0", async () => {
		delete process.env.HARBOR_TELEMETRY;
		const harbor = stubHarbor();
		const run = await runBenchmark(newRun(harbor.jobsDir, "telemetry-run"));
		expect(run.exitCode).toBe(0);
		expect(harbor.argv()[0]).toBe("run");
		expect(harbor.telemetry()).toBe("0");
	});

	it("starts `harbor job resume` with HARBOR_TELEMETRY=0", async () => {
		delete process.env.HARBOR_TELEMETRY;
		const harbor = stubHarbor();
		const jobName = "telemetry-resume";
		const jobDir = path.join(harbor.jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });
		fs.writeFileSync(path.join(jobDir, "config.json"), JSON.stringify({ environment: { type: "docker" } }));
		const benchDir = path.join(harbor.jobsDir, "_bench", jobName);
		fs.mkdirSync(benchDir, { recursive: true });
		fs.writeFileSync(
			path.join(benchDir, "runner-config.json"),
			JSON.stringify({ agent: "nop", tasks: 1, models: ["anthropic/claude-sonnet-4-6"] }),
		);
		const cfg = resolveResumeConfig(parseArgs(["--resume", jobName, "--jobs-dir", harbor.jobsDir]));
		const run = await runBenchmark(cfg);
		expect(run.exitCode).toBe(0);
		expect(harbor.argv().slice(0, 4)).toEqual(["job", "resume", "-p", jobDir]);
		expect(harbor.telemetry()).toBe("0");
	});

	it("keeps a HARBOR_TELEMETRY value the caller set", async () => {
		const harbor = stubHarbor();
		process.env.HARBOR_TELEMETRY = "1";
		const run = await runBenchmark(newRun(harbor.jobsDir, "telemetry-explicit"));
		expect(run.exitCode).toBe(0);
		expect(harbor.telemetry()).toBe("1");
	});

	it("prints the --dry-run harbor command with HARBOR_TELEMETRY=0", async () => {
		delete process.env.HARBOR_TELEMETRY;
		const harbor = stubHarbor();
		await runBenchmark(newRun(harbor.jobsDir, "telemetry-dry-run", "--dry-run"));
		expect(harbor.stdout.filter(line => line.startsWith("HARBOR_TELEMETRY=0 harbor run "))).toHaveLength(1);
	});

	it("sets HARBOR_TELEMETRY=0 for a managed agent and reads a blank value as unset", () => {
		const cfg = parseArgs(["--model", "anthropic/claude-opus-4-8"]);
		delete process.env.HARBOR_TELEMETRY;
		expect(buildHarborEnv(cfg, "/tmp/models.yml", null, "test").HARBOR_TELEMETRY).toBe("0");
		process.env.HARBOR_TELEMETRY = " ";
		expect(buildHarborEnv(cfg, "/tmp/models.yml", null, "test").HARBOR_TELEMETRY).toBe("0");
	});
});
