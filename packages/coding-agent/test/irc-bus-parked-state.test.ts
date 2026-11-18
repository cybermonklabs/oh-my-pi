import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IrcBus, type IrcBusApi } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

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
});
