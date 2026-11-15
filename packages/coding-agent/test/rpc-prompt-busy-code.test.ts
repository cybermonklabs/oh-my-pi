import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

type Frame = Record<string, unknown>;

/** An RPC agent fixture spoken to over raw JSONL, so every frame of an id stays visible. */
interface FixtureAgent {
	send(command: Frame): void;
	/** The frames carrying `id`, in wire order. */
	framesWithId(id: string): Frame[];
	/** The first frame `match` accepts, waiting up to `timeoutMs` for it. */
	waitFor(match: (frame: Frame) => boolean, timeoutMs: number, message: string): Promise<Frame>;
	/** Kills the agent and removes its temp directory. */
	stop(): Promise<void>;
}

async function startAgent(fixture: string): Promise<FixtureAgent> {
	const temp = await TempDir.create("@omp-rpc-busy-code-");
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", fixture), temp.path()], {
		cwd: temp.path(),
		env: { HOME: temp.path(), TMPDIR: temp.path(), PI_CODING_AGENT_DIR: temp.path(), PI_NO_TITLE: "1" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	});
	const frames: Frame[] = [];
	let changed = Promise.withResolvers<void>();
	let ended = false;
	let readError: unknown;
	const reading = (async () => {
		try {
			for await (const frame of readJsonl<unknown>(child.stdout)) {
				if (isRecord(frame)) frames.push(frame);
				changed.resolve();
				changed = Promise.withResolvers<void>();
			}
		} catch (error) {
			readError = error;
		} finally {
			ended = true;
			changed.resolve();
		}
	})();
	const find = async (match: (frame: Frame) => boolean): Promise<Frame> => {
		for (;;) {
			const found = frames.find(match);
			if (found) return found;
			if (ended) throw new Error(`RPC stdout ended before the expected frame (${String(readError ?? "EOF")})`);
			await changed.promise;
		}
	};
	const agent: FixtureAgent = {
		send: command => {
			child.stdin.write(`${JSON.stringify(command)}\n`);
			child.stdin.flush();
		},
		framesWithId: id => frames.filter(frame => frame.id === id),
		waitFor: (match, timeoutMs, message) => withTimeout(find(match), timeoutMs, message),
		stop: async () => {
			child.kill();
			await child.exited;
			await reading;
			await temp.remove();
		},
	};
	try {
		await agent.waitFor(frame => frame.type === "ready", 20_000, `${fixture} never became ready`);
	} catch (error) {
		await agent.stop();
		throw error;
	}
	return agent;
}

const responses = (agent: FixtureAgent, id: string) =>
	agent.framesWithId(id).filter(frame => frame.type === "response");

const promptResult = (agent: FixtureAgent, id: string, timeoutMs: number) =>
	agent.waitFor(frame => frame.type === "prompt_result" && frame.id === id, timeoutMs, `No prompt_result for ${id}`);

describe("RPC prompt failures carry session_busy only when the agent was busy", () => {
	let agent: FixtureAgent | undefined;

	afterEach(async () => {
		// Bind this case's agent before awaiting: a stop that outlives the hook
		// timeout resumes after the next case has started its own.
		const own = agent;
		agent = undefined;
		await own?.stop();
	});

	test("a prompt sent while a turn streams is refused with session_busy", async () => {
		agent = await startAgent("busy-rpc-agent.ts");
		agent.send({ id: "slow", type: "prompt", message: "slow" });
		await agent.waitFor(
			frame => frame.type === "notice" && frame.message === "slow turn streaming",
			10_000,
			"The slow turn never reached the model",
		);

		agent.send({ id: "busy", type: "prompt", message: "second prompt" });
		const result = await promptResult(agent, "busy", 10_000);

		const [refusal] = responses(agent, "busy");
		expect(refusal).toMatchObject({ success: false, code: "session_busy" });
		expect(String(refusal.error)).toStartWith("Agent is already processing");
		expect(result).toMatchObject({ agentInvoked: false, status: "error", error: { code: "session_busy" } });
	}, 30_000);

	test("abort_and_prompt that meets a busy agent fails late with session_busy", async () => {
		agent = await startAgent("busy-rpc-agent.ts");
		agent.send({ id: "turn-first", type: "abort_and_prompt", message: "turn-first" });
		const result = await promptResult(agent, "turn-first", 15_000);

		const [acknowledgement, ...later] = responses(agent, "turn-first");
		expect(acknowledgement).toMatchObject({ success: true });
		expect(later.find(frame => frame.success === false)).toMatchObject({
			command: "abort_and_prompt",
			success: false,
			code: "session_busy",
		});
		expect(result).toMatchObject({ error: { code: "session_busy" } });
	}, 30_000);

	test("a prompt still blocked by another run after its 30 s wait fails with session_busy", async () => {
		agent = await startAgent("idle-retry-rpc-agent.ts");
		agent.send({ id: "two-runs", type: "prompt", message: "two-runs-first" });
		const result = await promptResult(agent, "two-runs", 75_000);
		// Run B streams until aborted; end it before the agent stops.
		agent.send({ id: "abort", type: "abort" });
		await agent.waitFor(
			frame => frame.type === "response" && frame.id === "abort",
			10_000,
			"The abort was never answered",
		);

		const [acknowledgement, ...later] = responses(agent, "two-runs");
		expect(acknowledgement).toMatchObject({ success: true });
		const failure = later.find(frame => frame.success === false);
		expect(failure).toMatchObject({ success: false, code: "session_busy" });
		expect(String(failure?.error)).toStartWith("Timed out waiting for prior agent run");
		expect(result).toMatchObject({ agentInvoked: false, status: "error", error: { code: "session_busy" } });
	}, 90_000);

	test("a prompt that fails after admission for another cause carries no code", async () => {
		agent = await startAgent("busy-rpc-agent.ts");
		agent.send({ id: "no-key", type: "prompt", message: "no-key" });
		const result = await promptResult(agent, "no-key", 15_000);

		const failure = responses(agent, "no-key").find(frame => frame.success === false);
		expect(failure).toBeDefined();
		expect(failure).not.toHaveProperty("code");
		expect(result.error).toBeDefined();
		expect(result.error).not.toHaveProperty("code");
	}, 30_000);
});
