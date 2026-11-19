import { describe, expect, test } from "bun:test";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { fakeRpcAgent, withScaledDeadline } from "./helpers/fake-rpc-agent";

describe("RpcClient steer_subagent deadlines", () => {
	// Regression: a host steers a subagent between turns, whose answer comes only when the
	// subagent's next run takes the message, and the client gives up after 30 s with a timeout
	// while the message stays queued and is delivered later anyway.
	test("a steer answered after an ordinary request has timed out resolves", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		let steerSettled = false;
		const steer = withScaledDeadline(() => client.steerSubagent("OmpWorker", "Drop the glob."));
		void steer.then(
			() => {
				steerSettled = true;
			},
			() => {
				steerSettled = true;
			},
		);
		const ordinary = withScaledDeadline(() => client.getState());
		await expect(ordinary).rejects.toThrow("Timeout waiting for response to get_state");
		expect(steerSettled).toBe(false);
		expect(agent.requests[0]).toMatchObject({
			type: "steer_subagent",
			subagentId: "OmpWorker",
			message: "Drop the glob.",
		});

		agent.reply(agent.requests[0]);
		await expect(steer).resolves.toBeUndefined();
	});

	// Regression: with no client-side deadline, a steer waiting on a subagent's next run hangs
	// forever once the RPC process is gone.
	test("a steer still waiting rejects once the RPC process exits", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		const steer = client.steerSubagent("OmpWorker", "Drop the glob.");
		agent.exit(1);

		await expect(steer).rejects.toThrow("Agent process exited with code 1");
	});

	// Regression: a host that asks for a deadline on a steer waits past it.
	test("a steer with a caller deadline rejects once it lapses", async () => {
		const agent = fakeRpcAgent();
		using client = new RpcClient({ spawn: () => agent.proc });
		await client.start();

		const steer = withScaledDeadline(() => client.steerSubagent("OmpWorker", "Drop the glob.", { timeoutMs: 6_000 }));

		await expect(steer).rejects.toThrow("Timeout waiting for response to steer_subagent");
	});
});
