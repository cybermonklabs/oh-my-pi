import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LiveSessionCallbacks, LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import { RpcLiveBridge, type RpcLiveSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-live";
import type { RpcLiveFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

class FakeLiveSession implements RpcLiveSession {
	muted = false;
	stopCalls = 0;
	/** What the controller reports once started; `undefined` models a session that ended first. */
	sdpAnswer: string | undefined;
	readonly started = Promise.withResolvers<void>();
	#stopped: Promise<void> | undefined;
	constructor(readonly options: LiveSessionControllerOptions) {}

	get callbacks(): LiveSessionCallbacks {
		return this.options.callbacks;
	}

	start(): Promise<void> {
		this.callbacks.onPhase("connecting");
		return this.started.promise;
	}

	toggleMute(): void {
		this.muted = !this.muted;
	}

	stop(): Promise<void> {
		this.stopCalls += 1;
		this.#stopped ??= Promise.resolve().then(() => this.callbacks.onTerminal());
		return this.#stopped;
	}
}

function harness(levelsIntervalMs = 40, startRefusal?: () => string | undefined) {
	const frames: RpcLiveFrame[] = [];
	const sessions: FakeLiveSession[] = [];
	const agentSession = { settings: Settings.isolated({ "live.voice": "sol" }) } as unknown as AgentSession;
	const bridge = new RpcLiveBridge(agentSession, frame => frames.push(frame), {
		createSession: options => {
			const fake = new FakeLiveSession(options);
			sessions.push(fake);
			return fake;
		},
		levelsIntervalMs,
		startRefusal,
	});
	return { bridge, frames, sessions };
}

async function startedBridge(levelsIntervalMs?: number) {
	const h = harness(levelsIntervalMs);
	const starting = h.bridge.start();
	h.sessions[0]!.started.resolve();
	await starting;
	return { ...h, live: h.sessions[0]! };
}

describe("RpcLiveBridge", () => {
	test("start forwards options and callbacks as live frames; end is emitted once", async () => {
		const { bridge, frames, sessions } = harness();
		const starting = bridge.start({ voice: " cove ", instructions: "Hi {{firstName}}" });
		const live = sessions[0]!;
		expect(live.options.voice).toBe("cove");
		expect(live.options.instructions).toBe("Hi {{firstName}}");
		live.started.resolve();
		expect(await starting).toEqual({ voice: "cove" });

		live.callbacks.onTranscript(undefined);
		live.callbacks.onTranscript({ role: "assistant", turn: 2, text: "Sure", final: false });
		live.callbacks.onPhase("speaking");
		live.callbacks.onTerminal(new Error("socket closed"));
		live.callbacks.onTerminal();
		await bridge.stop();
		expect(frames).toEqual([
			{ type: "live_phase", phase: "connecting" },
			{ type: "live_transcript", role: "assistant", turn: 2, text: "Sure", final: false },
			{ type: "live_phase", phase: "speaking" },
			{ type: "live_end", error: "socket closed" },
		]);
		expect(bridge.active).toBe(false);
	});

	test("voice defaults to the live.voice setting", async () => {
		const { bridge, sessions } = harness();
		const starting = bridge.start();
		sessions[0]!.started.resolve();
		expect(await starting).toEqual({ voice: "sol" });
		expect(sessions[0]!.options.instructions).toBeUndefined();
	});

	test("a second start fails while connecting, active, or closing", async () => {
		const { bridge, sessions } = harness();
		const first = bridge.start();
		await expect(bridge.start()).rejects.toThrow("already active");
		sessions[0]!.started.resolve();
		await first;
		await expect(bridge.start()).rejects.toThrow("already active");
		const stopping = bridge.stop();
		await expect(bridge.start()).rejects.toThrow("already active");
		await stopping;
		const again = bridge.start();
		sessions[1]!.started.resolve();
		await again;
		expect(sessions).toHaveLength(2);
	});

	test("a failed start rejects and releases the slot", async () => {
		const { bridge, frames, sessions } = harness();
		const starting = bridge.start();
		sessions[0]!.started.reject(new Error("no auth"));
		await expect(starting).rejects.toThrow("no auth");
		expect(bridge.active).toBe(false);
		expect(frames.at(-1)).toEqual({ type: "live_end" });
	});

	test("a start the host refuses (dictation running, session changing) opens no session", async () => {
		let refusal: string | undefined = "End dictation before starting live voice";
		const { bridge, sessions } = harness(40, () => refusal);
		await expect(bridge.start()).rejects.toThrow("End dictation before starting live voice");
		expect(sessions).toEqual([]);
		expect(bridge.status()).toEqual({ state: "off" });
		refusal = undefined;
		const starting = bridge.start();
		sessions[0]!.started.resolve();
		await starting;
		expect(sessions).toHaveLength(1);
	});

	test("status reports a call as starting, then open with its provider and voice, then off", async () => {
		const { bridge, sessions } = harness();
		expect(bridge.status()).toEqual({ state: "off" });
		const starting = bridge.start({ voice: "cove" });
		expect(bridge.status()).toMatchObject({ state: "starting", provider: "codex", voice: "cove", muted: false });
		sessions[0]!.started.resolve();
		await starting;
		const open = bridge.status();
		expect(open).toMatchObject({ state: "open", provider: "codex", voice: "cove" });
		expect(open.state !== "off" && open.since).toBeInstanceOf(Date);
		bridge.setMuted(true);
		expect(bridge.status()).toMatchObject({ muted: true });
		await bridge.stop();
		expect(bridge.status()).toEqual({ state: "off" });
	});

	test("an sdpOffer session reaches the controller and resolves with its SDP answer", async () => {
		const { bridge, sessions } = harness();
		const starting = bridge.start({ sdpOffer: "v=0 offer" });
		const live = sessions[0]!;
		expect(live.options.sdpOffer).toBe("v=0 offer");
		live.sdpAnswer = "v=0 answer";
		live.started.resolve();
		expect(await starting).toEqual({ voice: "sol", sdpAnswer: "v=0 answer" });
		expect(bridge.active).toBe(true);
	});

	test("an sdpOffer session that ends before its answer exists rejects and releases the slot", async () => {
		const { bridge, frames, sessions } = harness();
		const starting = bridge.start({ sdpOffer: "v=0 offer" });
		sessions[0]!.started.resolve();
		await expect(starting).rejects.toThrow("stopped before its SDP answer");
		expect(bridge.active).toBe(false);
		expect(frames.at(-1)).toEqual({ type: "live_end" });
	});

	test("mute sets or toggles and fails without a session", async () => {
		const { bridge, live } = await startedBridge();
		expect(bridge.setMuted()).toEqual({ muted: true });
		expect(bridge.setMuted(true)).toEqual({ muted: true });
		expect(bridge.setMuted()).toEqual({ muted: false });
		expect(bridge.setMuted(false)).toEqual({ muted: false });
		expect(live.muted).toBe(false);
		await bridge.stop();
		expect(() => bridge.setMuted(true)).toThrow("No live session is active");
		expect(() => harness().bridge.setMuted()).toThrow("No live session is active");
	});

	test("stop without a session is a no-op", async () => {
		const { bridge, frames } = harness();
		await bridge.stop();
		expect(frames).toEqual([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("levels are throttled: bursts coalesce and the latest value is delivered", async () => {
		vi.useFakeTimers();
		const { bridge, frames, live } = await startedBridge(40);
		const levels = () => frames.filter(frame => frame.type === "live_levels");
		live.callbacks.onLevels(0.1, 0);
		live.callbacks.onLevels(0.2, 0.1);
		live.callbacks.onLevels(0.3, 0.2);
		expect(levels()).toEqual([{ type: "live_levels", input: 0.1, output: 0 }]);
		vi.advanceTimersByTime(39);
		expect(levels()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(levels()).toEqual([
			{ type: "live_levels", input: 0.1, output: 0 },
			{ type: "live_levels", input: 0.3, output: 0.2 },
		]);
		live.callbacks.onLevels(0.5, 0.5);
		await bridge.stop();
		// A pending value is flushed before live_end and nothing follows it.
		expect(frames.slice(-2)).toEqual([{ type: "live_levels", input: 0.5, output: 0.5 }, { type: "live_end" }]);
		live.callbacks.onLevels(0.9, 0.9);
		vi.advanceTimersByTime(100);
		expect(frames.at(-1)).toEqual({ type: "live_end" });
	});
});

describe("live commands over RPC", () => {
	test("start/mute/stop wire shapes; frames bypass set_event_filter; stdin end stops the session", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-live-"));
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "live-rpc-agent.ts")], {
			cwd: dir,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
		const decoder = new TextDecoder();
		const seen: Record<string, unknown>[] = [];
		const receive = async (): Promise<Record<string, unknown> | undefined> => {
			const line = await lines.next();
			if (line.done) return undefined;
			const frame = JSON.parse(decoder.decode(line.value)) as Record<string, unknown>;
			seen.push(frame);
			return frame;
		};
		let id = 0;
		const command = async (fields: object): Promise<Record<string, unknown>> => {
			const requestId = String(++id);
			child.stdin.write(`${JSON.stringify({ ...fields, id: requestId })}\n`);
			await child.stdin.flush();
			for (;;) {
				const frame = await receive();
				if (!frame) throw new Error(await stderr);
				if (frame.type === "response" && frame.id === requestId) return frame;
			}
		};
		try {
			while ((await receive())?.type !== "ready") {}
			expect(await command({ type: "set_event_filter", events: ["agent_end"] })).toMatchObject({ success: true });
			expect(await command({ type: "live_mute" })).toMatchObject({
				type: "response",
				command: "live_mute",
				success: false,
				error: "No live session is active",
			});
			expect(await command({ type: "live_stop" })).toEqual({
				id: "3",
				type: "response",
				command: "live_stop",
				success: true,
			});
			expect(await command({ type: "live_connect", sdpOffer: "v=0 offer" })).toEqual({
				id: "4",
				type: "response",
				command: "live_connect",
				success: true,
				data: { voice: "sol", sdpAnswer: "answer to v=0 offer" },
			});
			expect(await command({ type: "live_stop" })).toMatchObject({ success: true });
			seen.length = 0;
			expect(await command({ type: "live_start", instructions: "Hey {{firstName}}" })).toEqual({
				id: "6",
				type: "response",
				command: "live_start",
				success: true,
				data: { voice: "sol" },
			});
			expect(seen.filter(frame => String(frame.type).startsWith("live_"))).toEqual([
				{ type: "live_phase", phase: "connecting" },
				{ type: "live_transcript", role: "user", turn: 1, text: "hello", final: true },
				{ type: "live_phase", phase: "listening" },
			]);
			expect(await command({ type: "live_start" })).toMatchObject({
				command: "live_start",
				success: false,
				error: "A live session is already active",
			});
			// Without an offer, live_connect must fail at the boundary, not fall back to host audio.
			expect(await command({ type: "live_connect" })).toMatchObject({
				command: "live_connect",
				success: false,
				error: "live_connect requires a non-empty sdpOffer",
			});
			expect(await command({ type: "live_mute" })).toMatchObject({ success: true, data: { muted: true } });
			expect(await command({ type: "live_mute", muted: false })).toMatchObject({ data: { muted: false } });

			await child.stdin.end();
			while (await receive()) {}
			expect(await child.exited).toBe(0);
			expect(seen.at(-1)).toEqual({ type: "live_end" });
			expect(await Bun.file(path.join(dir, "live-stopped.json")).json()).toEqual({
				voice: "sol",
				instructions: "Hey {{firstName}}",
			});
		} finally {
			child.kill();
			await child.exited;
			await stderr;
			await removeWithRetries(dir);
		}
	}, 60_000);

	test("/live on|off|status typed through sendUserInput run at once during a turn and answer in one line", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-live-typed-"));
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "live-rpc-agent.ts")], {
			cwd: dir,
			// Each model turn runs 20 s, so every command below arrives while the first turn runs.
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_NO_TITLE: "1", OMP_LIVE_TURN_MS: "20000" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = new Response(child.stderr).text();
		const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
		const decoder = new TextDecoder();
		const seen: Record<string, unknown>[] = [];
		const receive = async (): Promise<Record<string, unknown>> => {
			const line = await lines.next();
			if (line.done) throw new Error(`RPC agent ended: ${await stderr}`);
			const frame = JSON.parse(decoder.decode(line.value)) as Record<string, unknown>;
			seen.push(frame);
			return frame;
		};
		let id = 0;
		const send = async (fields: object): Promise<void> => {
			child.stdin.write(`${JSON.stringify({ ...fields, id: String(++id) })}\n`);
			await child.stdin.flush();
		};
		// What the bridge extension's `sendUserInput` answered for `text`, as pi-envoy would post it.
		const typed = async (text: string): Promise<unknown> => {
			await send({ type: "prompt", message: `/bridge ${text}`, streamingBehavior: "steer" });
			for (;;) {
				const frame = await receive();
				if (frame.type === "extension_ui_request" && frame.method === "notify") {
					return JSON.parse(String(frame.message));
				}
			}
		};
		try {
			while ((await receive()).type !== "ready") {}
			await send({ type: "prompt", message: "work for a while" });
			while ((await receive()).type !== "agent_start") {}
			seen.length = 0;

			expect(await typed("/live status")).toEqual({ handled: "command", output: "No live call is open." });
			const on = await typed("/live on");
			expect(on).toEqual({ handled: "command", output: "Live call open: codex, voice sol." });
			expect(seen).toContainEqual({ type: "command_output", text: "Live call open: codex, voice sol." });
			expect(await typed("/live on")).toEqual({
				handled: "command",
				output: expect.stringMatching(/^A live call is already open \(since \S+Z\)\.$/),
			});
			expect(await typed("/live status")).toEqual({
				handled: "command",
				output: expect.stringMatching(/^Live call open since \S+Z: codex, voice sol, microphone on\.$/),
			});
			expect(await typed("/live off")).toEqual({ handled: "command", output: "Live call ended." });
			expect(await typed("/live off")).toEqual({ handled: "command", output: "No live call is open." });
			expect(await typed("/live louder")).toEqual({ handled: "command", output: "Usage: /live [on|off|status]" });
			// The checks a live_start frame makes hold for typed input too.
			await send({ type: "dictation_start", captureId: "c1" });
			expect(await typed("/live on")).toEqual({
				handled: "command",
				output: "Live call did not start: End dictation before starting live voice",
			});
			// Every answer came while the first turn still ran.
			expect(seen.some(frame => frame.type === "agent_end")).toBe(false);
		} finally {
			child.kill();
			await child.exited;
			await stderr;
			await removeWithRetries(dir);
		}
	}, 60_000);
});
