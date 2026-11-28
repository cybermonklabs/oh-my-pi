import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	Shell,
	type ShellCommandRequest,
	type ShellCommandResult,
	type ShellRunOptions,
	shellReservedCommandNames,
} from "../native/index.js";

type Handler = (request: ShellCommandRequest) => Promise<ShellCommandResult>;

async function run(
	shell: Shell,
	command: string,
	commands?: { names: string[]; handler: Handler },
	options: Omit<ShellRunOptions, "command" | "commands"> = {},
) {
	let output = "";
	const result = await shell.run({ command, commands, ...options }, (error, chunk) => {
		if (error) throw error;
		output += chunk;
	});
	return { result, output };
}

function quote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-shell-commands-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const SCORE = "/proc/self/oom_score_adj";

/**
 * Whether a process can hold an OOM adjustment below 1000, the value of tool processes (Linux): a child of this
 * one tries, so this process keeps its own. A test that a tool process of this build runs starts at 1000, and an
 * external's 1000 shows that its spawn set it only below that; the test skips where it cannot be.
 */
const BELOW_TOOL_SCORE =
	process.platform === "linux" &&
	Bun.spawnSync([
		"/bin/sh",
		"-c",
		`{ read -r s < ${SCORE}; [ "$s" -lt 1000 ] || printf 999 > ${SCORE}; read -r s < ${SCORE}; [ "$s" -lt 1000 ]; } 2>/dev/null`,
	]).exitCode === 0;

/** Set in the test process {@link belowToolScore} starts: the name of the test it runs there. */
const ALONE = "OMP_TEST_BELOW_TOOL_SCORE";
/** How long that process may run before it is killed. */
const ALONE_DEADLINE_MS = 60_000;
/** The timeout of a test that calls {@link belowToolScore}: past that deadline and the reading of the output. */
const ALONE_TIMEOUT_MS = ALONE_DEADLINE_MS + 15_000;

/**
 * Run test `name` of this file again, alone, in a `bun test` process of its own whose OOM adjustment is below 1000,
 * and fail where it fails there; in that process, run `test` with that value, `baseline`. The value of this test
 * runner never changes. The process leads a group of its own, is killed where it outlasts
 * {@link ALONE_DEADLINE_MS}, and whatever it left in its group is killed once it ended.
 */
async function belowToolScore(name: string, test: (baseline: string) => Promise<void>): Promise<void> {
	if (Bun.env[ALONE] === name) {
		if ((await Bun.file(SCORE).text()).trim() === "1000") await Bun.write(SCORE, "999");
		const baseline = await Bun.file(SCORE).text();
		if (baseline.trim() === "1000") throw new Error("this process's OOM adjustment stayed at 1000");
		await test(baseline);
		return;
	}
	const pattern = `${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", pattern], {
		cwd: process.cwd(),
		env: { ...Bun.env, [ALONE]: name },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		detached: true,
		timeout: ALONE_DEADLINE_MS,
		killSignal: "SIGKILL",
	});
	const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
		([stdout, stderr]) => stdout + stderr,
	);
	let exitCode: number;
	try {
		exitCode = await child.exited;
	} finally {
		try {
			// What the test left in the process's group.
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// The group is empty.
		}
	}
	// A wall-clock bound on purpose: a process the test left may hold the pipes.
	const said = await Promise.race([output, Bun.sleep(5_000).then(() => "<the test process's output stayed open>")]);
	if (child.signalCode === "SIGKILL") throw new Error(`the test ran past ${ALONE_DEADLINE_MS} ms: ${said}`);
	expect(exitCode, said).toBe(0);
	expect(said, "the test process ran no test").toMatch(/^\s*1 pass$/m);
}

describe("Shell session commands", () => {
	const EXTERNAL_SCORE = "sets the score of an external command and its child, not the host";
	it.skipIf(!BELOW_TOOL_SCORE)(
		EXTERNAL_SCORE,
		async () => {
			await belowToolScore(EXTERNAL_SCORE, async before => {
				const { result, output } = await run(
					new Shell(),
					`/bin/cat ${SCORE}; /bin/sh -c 'read -r score < ${SCORE}; printf "%s\\n" "$score"; /bin/cat ${SCORE}; :'`,
				);
				expect(await Bun.file(SCORE).text()).toBe(before);
				expect(result.exitCode).toBe(0);
				expect(output).toBe("1000\n1000\n1000\n");
			});
		},
		ALONE_TIMEOUT_MS,
	);

	it("passes name, argv, cwd and dash-requested stdin through the handler", async () => {
		await withTempDir(async root => {
			const cwd = path.join(root, "nested");
			await fs.mkdir(cwd);
			const requests: ShellCommandRequest[] = [];
			const { result, output } = await run(
				new Shell(),
				"printf payload | probe read - | tr a-z A-Z; printf 'a\\nb\\n' | while read -r l; do probe \"$l\"; done",
				{
					names: ["probe"],
					handler: async request => {
						requests.push(request);
						await Promise.resolve();
						return { stdout: `${request.stdin}:${request.argv.join(",")}\n`, stderr: "", exitCode: 0 };
					},
				},
				{ cwd },
			);
			expect(result.exitCode).toBe(0);
			expect(output).toBe("PAYLOAD:READ,-\n:a\n:b\n");
			expect(requests.map(request => request.name)).toEqual(["probe", "probe", "probe"]);
			expect(requests.map(request => request.stdin)).toEqual(["payload", "", ""]);
			for (const request of requests) {
				expect(await fs.realpath(request.cwd)).toBe(await fs.realpath(cwd));
			}
		});
	});

	it("routes every command of a pipeline to the handler", async () => {
		const requests: ShellCommandRequest[] = [];
		const { result, output } = await run(new Shell(), "upper hello | wrap -", {
			names: ["upper", "wrap"],
			handler: async request => {
				requests.push(request);
				const stdout =
					request.name === "upper"
						? `${request.argv.join(" ").toUpperCase()}\n`
						: `[${request.stdin.trimEnd()}]\n`;
				return { stdout, stderr: "", exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("[HELLO]\n");
		expect(requests.map(request => [request.name, request.argv])).toEqual([
			["upper", ["hello"]],
			["wrap", ["-"]],
		]);
	});

	it("reaches the handler even when an earlier run defined a function of the same name", async () => {
		const shell = new Shell();
		const defined = await run(shell, "github() { echo function; }");
		expect(defined.result.exitCode).toBe(0);
		let calls = 0;
		const { result, output } = await run(shell, "github pr_view", {
			names: ["github"],
			handler: async request => {
				calls++;
				return { stdout: `tool:${request.argv.join(",")}\n`, stderr: "", exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("tool:pr_view\n");
		expect(calls).toBe(1);
	});

	it("maps rejections, throws and malformed replies to status 1 with the command name", async () => {
		const shell = new Shell();
		const reply = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: async () => ({ stdout: "partial\n", stderr: "diag\n", exitCode: 300 }),
		});
		expect(reply.output).toBe("partial\ndiag\ns=255\n");

		const rejected = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: async () => {
				await Promise.resolve();
				throw new Error("js handler rejected");
			},
		});
		expect(rejected.output).toBe("probe: js handler rejected\ns=1\n");

		const thrown = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: () => {
				throw new Error("sync throw");
			},
		});
		expect(thrown.output).toEndWith("s=1\n");
		expect(thrown.output).toStartWith("probe: ");

		const malformed = await run(shell, 'probe 2>&1; echo "s=$?"', {
			names: ["probe"],
			handler: async () => JSON.parse('{"stdout":1}'),
		});
		expect(malformed.output).toEndWith("s=1\n");
		expect(malformed.output).toStartWith("probe: ");
	});

	it("never reaches the handler for reserved names", async () => {
		const reserved = shellReservedCommandNames();
		for (const name of ["cd", "echo", "grep", "timeout", "if"]) {
			expect(reserved).toContain(name);
		}
		expect(reserved).not.toContain("omp_unused_command_name");

		let calls = 0;
		const { result, output } = await run(new Shell(), "echo hi; github", {
			names: ["echo", "github"],
			handler: async request => {
				calls++;
				return { stdout: `${request.name}\n`, stderr: "", exitCode: 0 };
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("hi\ngithub\n");
		expect(calls).toBe(1);
	});

	it("scopes commands to their run, including background jobs that outlive it", async () => {
		await withTempDir(async root => {
			const shell = new Shell();
			const go = quote(path.join(root, "go"));
			const late = quote(path.join(root, "late"));
			let staleCalls = 0;
			const first = await run(
				shell,
				`{ while [ ! -e ${go} ]; do sleep 0.01; done; omp_probe late 2>/dev/null; echo "status=$?" > ${late}; } & printf done`,
				{
					names: ["omp_probe"],
					handler: async () => {
						staleCalls++;
						return { stdout: "must-not-run", stderr: "", exitCode: 0 };
					},
				},
			);
			expect(first.output).toBe("done");

			const second = await run(shell, `touch ${go}; while [ ! -s ${late} ]; do sleep 0.01; done; cat ${late}`);
			expect(second.result.exitCode).toBe(0);
			expect(second.output).toBe("status=127\n");
			expect(staleCalls).toBe(0);
		});
	});

	it("cancels a pending call on timeout and serves the next run", async () => {
		const shell = new Shell();
		const timedOut = await run(
			shell,
			"probe pending",
			{
				names: ["probe"],
				handler: () => new Promise<ShellCommandResult>(() => {}),
			},
			{ timeoutMs: 50 },
		);
		expect(timedOut.result.timedOut).toBeTrue();
		expect(timedOut.result.exitCode).toBeUndefined();

		const after = await run(shell, "probe after", {
			names: ["probe"],
			handler: async () => ({ stdout: "after", stderr: "", exitCode: 0 }),
		});
		expect(after.result.exitCode).toBe(0);
		expect(after.output).toBe("after");
	});

	it("cancels a pending call when the run's signal aborts", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const active = run(
			new Shell(),
			"probe pending",
			{
				names: ["probe"],
				handler: () => {
					started.resolve();
					return new Promise<ShellCommandResult>(() => {});
				},
			},
			{ signal: controller.signal },
		);
		await started.promise;
		controller.abort();
		const cancelled = await active;
		expect(cancelled.result.cancelled).toBeTrue();
		expect(cancelled.result.exitCode).toBeUndefined();
	});
});
