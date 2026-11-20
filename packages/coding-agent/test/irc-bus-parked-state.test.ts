import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type IrcBusApi } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { createSessionDefaults } from "./helpers/session-defaults";

/** A recipient session whose `deliverIrcMessage` runs `deliver`. */
function fakeSession(
	deliver: (msg: IrcMessage) => Promise<"injected" | "woken"> = async () => "injected",
): AgentSession {
	return {
		isStreaming: false,
		deliverIrcMessage: deliver,
		emitIrcRelayObservation: () => {},
		dispose: async () => {},
	} as unknown as AgentSession;
}

describe("IRC bus: no state kept for a parked or removed agent", () => {
	let registry: AgentRegistryApi;
	let bus: IrcBusApi;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
		registry.register({ id: "0-Main", displayName: "main", kind: "main", session: fakeSession() });
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	// Regression: a question revives a parked subagent, which parks again before
	// the delivery returns; the bus keeps the send's mark for the parked agent for
	// the rest of the session, and the owner's wait counts the parked agent as
	// owing a reply it will never send.
	it("records no mark for a recipient the send revived and that parked again during the delivery", async () => {
		registry.register({ id: "0-Sub", displayName: "sub", kind: "sub", parentId: "0-Main", session: fakeSession() });
		const lifecycle = AgentLifecycleManager.global();
		let parkDuringDelivery = true;
		const revived = fakeSession(async () => {
			if (parkDuringDelivery) {
				parkDuringDelivery = false;
				// The woken turn ends and the idle TTL parks the agent before the delivery returns.
				registry.setStatus("0-Sub", "idle");
				await lifecycle.park("0-Sub");
			}
			return "woken";
		});
		lifecycle.adopt("0-Sub", { idleTtlMs: 0, revive: async () => revived });
		await lifecycle.park("0-Sub");
		expect(registry.get("0-Sub")?.status).toBe("parked");

		const receipt = await bus.send({ from: "0-Main", to: "0-Sub", body: "which codeword?" });

		expect(receipt.outcome).toBe("revived");
		expect(registry.get("0-Sub")?.status).toBe("parked");
		expect(bus.sentSince("0-Main", "0-Sub", 0)).toBe(false);
		expect(bus.unansweredSends("0-Main", 0)).toEqual([]);
	});

	// Regressed: a question to a subagent that is parked and revived again while the question is delivered
	// (an idle-TTL park, then another sender's message) loses its mark, so the owner's wait does not block
	// for the reply the live subagent still owes.
	it("records the mark for a recipient parked and live again before the delivery returns", async () => {
		const lifecycle = AgentLifecycleManager.global();
		let parkAndReviveDuringDelivery = true;
		const live = fakeSession(async () => {
			if (parkAndReviveDuringDelivery) {
				parkAndReviveDuringDelivery = false;
				registry.setStatus("0-Sub", "idle");
				await lifecycle.park("0-Sub");
				expect(registry.get("0-Sub")?.status).toBe("parked");
				await lifecycle.ensureLive("0-Sub");
			}
			return "injected";
		});
		registry.register({ id: "0-Sub", displayName: "sub", kind: "sub", parentId: "0-Main", session: live });
		lifecycle.adopt("0-Sub", { idleTtlMs: 0, revive: async () => fakeSession() });

		const receipt = await bus.send({ from: "0-Main", to: "0-Sub", body: "which codeword?" });

		expect(receipt.outcome).toBe("injected");
		expect(registry.get("0-Sub")?.status).toBe("idle");
		expect(bus.sentSince("0-Main", "0-Sub", 0)).toBe(true);
		expect(bus.unansweredSends("0-Main", 0)).toEqual([{ to: "0-Sub", sentAt: expect.any(Number), promised: false }]);
	});

	// Regression: a message to a subagent whose session is shutting down is
	// buffered, the subagent is removed, and the bus keeps that message for an
	// agent that no longer exists for the rest of the session.
	it("keeps no buffered message for a recipient removed after a failed hand-off", async () => {
		registry.register({
			id: "0-Sub",
			displayName: "sub",
			kind: "sub",
			parentId: "0-Main",
			session: fakeSession(async () => {
				throw new Error("Recipient session is disposed.");
			}),
		});
		const receipt = await bus.send({ from: "0-Main", to: "0-Sub", body: "which codeword?" });
		expect(receipt.outcome).toBe("failed");
		// The fixture really buffered the message.
		expect(bus.unreadCount("0-Sub")).toBe(1);

		expect(registry.unregister("0-Sub")).toBe(true);

		expect(registry.get("0-Sub")).toBeUndefined();
		expect(bus.unreadCount("0-Sub")).toBe(0);
		expect(bus.take("0-Sub")).toBeUndefined();
	});

	// Regression: L asks X, X answers L in the wake turn L's message started, and L's idle TTL parks
	// it before that turn ends; the bus drops X's mark of the answer with L's state, so the wake-turn
	// relay sends L the same answer again, which revives the parked L for a model turn on an answer
	// it already has.
	it("keeps a live agent's answer to a waker that parked, so the wake-turn relay does not revive it", async () => {
		registry.register({ id: "0-L", displayName: "L", kind: "sub", parentId: "0-Main", session: fakeSession() });
		let observer: ((records: unknown[]) => ((turnError?: unknown) => Promise<void>) | undefined) | undefined;
		const x = {
			...createSessionDefaults(),
			isStreaming: false,
			deliverIrcMessage: async () => "woken",
			emitIrcRelayObservation: () => {},
			subscribe: () => () => {},
			trackIrcReply: () => {},
			setIrcWakeTurnObserver: (next: typeof observer) => {
				observer = next;
			},
		} as unknown as AgentSession;
		registry.register({ id: "0-X", displayName: "X", kind: "sub", parentId: "0-Main", session: x });
		attachIrcWakeTurnMonitor(x, {
			id: "0-X",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			storeMaskCwd: "/tmp",
		});
		const lifecycle = AgentLifecycleManager.global();
		let revivals = 0;
		lifecycle.adopt("0-L", {
			idleTtlMs: 0,
			revive: async () => {
				revivals++;
				return fakeSession();
			},
		});

		// L's question wakes X, and X's wake turn answers it.
		expect((await bus.send({ from: "0-L", to: "0-X", body: "is auth.ts yours?" })).outcome).toBe("woken");
		const turnStart = Date.now();
		const turnEnded = observer?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "is auth.ts yours?",
				display: true,
				details: { from: "0-L", message: "is auth.ts yours?" },
				timestamp: turnStart,
			},
		]);
		if (!turnEnded) throw new Error("the wake-turn observer was not registered");
		await bus.send({ from: "0-X", to: "0-L", body: "yes, leave it to me" });
		// L goes idle, and its idle TTL parks it before X's turn ends.
		registry.setStatus("0-L", "idle");
		await lifecycle.park("0-L");
		expect(registry.get("0-L")?.status).toBe("parked");
		// What the relay asks once the turn ends.
		expect(bus.sentSince("0-X", "0-L", turnStart)).toBe(true);

		await turnEnded();

		expect(revivals).toBe(0);
		expect(registry.get("0-L")?.status).toBe("parked");
	});
});
