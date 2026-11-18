/**
 * `AgentLifecycleManager.releaseUnder`: a helper session's end (a `/security` scan, the Agent
 * Hub generator) releases every agent under it and leaves none live, also an agent whose revive
 * is in flight when the helper ends, a killed agent whose transcript is checked for a reopen when
 * the helper ends, and an agent whose intermediate parent was unregistered before the helper ended.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AgentLifecycleApi, AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TempDir } from "@oh-my-pi/pi-utils";

interface SessionStub {
	session: AgentSession;
	disposeCalls: () => number;
}

function makeSessionStub(): SessionStub {
	let calls = 0;
	const stub = {
		dispose: async () => {
			calls++;
		},
	};
	return { session: stub as unknown as AgentSession, disposeCalls: () => calls };
}

/** Settle the lifecycle's async chains. */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Whether `id` is a live agent: registered with a session attached that nobody disposed. */
function isLive(registry: AgentRegistryApi, id: string, stub: SessionStub): boolean {
	return registry.get(id)?.session === stub.session && stub.disposeCalls() === 0;
}

describe("releaseUnder leaves no agent under the helper live", () => {
	let registry: AgentRegistryApi;
	let lifecycle: AgentLifecycleApi;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
		registry.register({ id: "Helper", displayName: "helper", kind: "main", session: null, status: "running" });
	});
	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("an agent whose persisted revive is preparing when the helper ends does not come back live", async () => {
		// If this regresses, a message or an Agent Hub focus that revives a helper's parked subagent while the helper
		// ends brings that subagent back after the helper's release: a live agent nothing owns any more.
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		registry.register({
			id: "Helper-Sub",
			displayName: "task",
			kind: "sub",
			parentId: "Helper",
			session: null,
			sessionFile: "/tmp/Helper-Sub.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async () => {
				await gate.promise;
				return async () => revived.session;
			},
			() => 60_000,
		);

		const revival = lifecycle.ensureLive("Helper-Sub").catch(() => undefined);
		await flushAsync(); // the revive waits in the persisted factory
		await lifecycle.releaseUnder("Helper", { ownedJobsEnd: "stop" });
		gate.resolve();
		await revival;
		await flushAsync();

		expect(isLive(registry, "Helper-Sub", revived)).toBe(false);
		expect(lifecycle.has("Helper-Sub")).toBe(false);
	});

	it("an agent whose revived session is being built when the helper ends does not come back live", async () => {
		// If this regresses, the same race one step later (the reviver building the session) leaves the helper's
		// subagent live after the helper's release.
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		registry.register({
			id: "Helper-Sub",
			displayName: "task",
			kind: "sub",
			parentId: "Helper",
			session: null,
			sessionFile: "/tmp/Helper-Sub.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				await gate.promise;
				return revived.session;
			},
			() => 60_000,
		);

		const revival = lifecycle.ensureLive("Helper-Sub").catch(() => undefined);
		await flushAsync(); // the revive waits in the reviver
		await lifecycle.releaseUnder("Helper", { ownedJobsEnd: "stop" });
		gate.resolve();
		await revival;
		await flushAsync();

		expect(isLive(registry, "Helper-Sub", revived)).toBe(false);
		expect(lifecycle.has("Helper-Sub")).toBe(false);
	});

	it("a killed agent whose helper ends while its transcript is checked for a reopen stays ended", async () => {
		// If this regresses, a helper that ends just after a killed subagent's transcript check answers lets the
		// reopen go on: the subagent comes back live as a new generation after the helper's release, and its
		// tombstone is removed.
		using tempDir = TempDir.createSync("@omp-release-under-");
		const sessionFile = path.join(tempDir.path(), "Helper-Killed.jsonl");
		await Bun.write(sessionFile, "");
		const killed = registry.register({
			id: "Helper-Killed",
			displayName: "task",
			kind: "sub",
			parentId: "Helper",
			session: makeSessionStub().session,
			sessionFile,
			status: "running",
		});
		expect(await lifecycle.release("Helper-Killed", killed, { tombstone: true })).toBe(true);
		expect(await Bun.file(`${sessionFile}.tombstone`).exists()).toBe(true);
		const revived = makeSessionStub();
		const helperEnds: Promise<void>[] = [];
		lifecycle.setPersistedSubagentReviverFactory(
			async ref => {
				// The transcript check of the killed generation answers; the helper ends just after, before the
				// reopen goes on.
				if (ref === killed) {
					queueMicrotask(() => helperEnds.push(lifecycle.releaseUnder("Helper", { ownedJobsEnd: "stop" })));
				}
				return async () => revived.session;
			},
			() => 0,
		);

		const outcome = await lifecycle.ensureLive("Helper-Killed").then(
			() => "revived",
			() => "refused",
		);
		await Promise.all(helperEnds);

		expect(helperEnds.length).toBe(1);
		expect(outcome).toBe("refused");
		expect(registry.get("Helper-Killed")).toBeUndefined();
		expect(lifecycle.has("Helper-Killed")).toBe(false);
		expect(await Bun.file(`${sessionFile}.tombstone`).exists()).toBe(true);
	});

	it("reaches an agent whose intermediate parent was unregistered before the helper ended", async () => {
		// If this regresses, a keep-alive subagent of a one-shot subagent the helper started (unregistered at its end)
		// stays live after the helper's release: the walk up its parentId chain stops at the missing parent.
		const child = makeSessionStub();
		const grandchild = makeSessionStub();
		registry.register({
			id: "Helper-Child",
			displayName: "task",
			kind: "sub",
			parentId: "Helper",
			session: child.session,
			status: "idle",
		});
		lifecycle.adopt("Helper-Child", { idleTtlMs: 0 });
		registry.register({
			id: "Helper-Grandchild",
			displayName: "task",
			kind: "sub",
			parentId: "Helper-Child",
			session: grandchild.session,
			status: "idle",
		});
		lifecycle.adopt("Helper-Grandchild", { idleTtlMs: 0 });
		// The one-shot child ends: it is disposed and unregistered, its keep-alive subagent stays.
		await lifecycle.release("Helper-Child");
		expect(registry.get("Helper-Child")).toBeUndefined();

		await lifecycle.releaseUnder("Helper", { ownedJobsEnd: "stop" });

		expect(isLive(registry, "Helper-Grandchild", grandchild)).toBe(false);
		expect(lifecycle.has("Helper-Grandchild")).toBe(false);
	});
});
