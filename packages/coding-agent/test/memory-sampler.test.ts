/**
 * The memory self-report: what it measures, what it costs, and the two properties it exists
 * for — that the record reaches the file, and that it never disturbs the conversation.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { MemorySampler } from "@oh-my-pi/pi-coding-agent/debug/memory-sampler";
import {
	processIdentity,
	readCgroupMemory,
	readProcessResident,
	readThreadMemory,
} from "@oh-my-pi/pi-coding-agent/debug/memory-sample";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { type ProcessSampleEntry, resolveSessionLeafId } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentRegistryApi } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/** A registry that reports nothing, so a sampler test needs no process-global state. */
const emptyRegistry = { list: () => [] } as unknown as AgentRegistryApi;

function samplerOn(session: SessionManager, publish?: (sample: unknown) => void): MemorySampler {
	// intervalMs 0 keeps the timer out of the test; triggers are driven explicitly.
	return new MemorySampler({
		sessionManager: session,
		intervalMs: 0,
		registry: emptyRegistry,
		publish: publish as never,
	});
}

/** Samples on the journal, in order. */
function samples(session: SessionManager): ProcessSampleEntry[] {
	return session.getEntries().filter((entry): entry is ProcessSampleEntry => entry.type === "process_sample");
}

/**
 * Resolve once the sampler's pending write has settled. The write awaits only the worker
 * fan-out, which returns immediately with no pool, so draining microtasks is the real signal
 * rather than a guessed delay.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("memory self-report measurement", () => {
	it("reads the process's own resident memory, which is the number heapUsed understates", () => {
		const resident = readProcessResident();
		// Only Linux has procfs; elsewhere the sample carries its VM numbers and a null here.
		if (!resident) return;
		expect(resident.rssKb).toBeGreaterThan(0);
		expect(resident.anonKb).toBeGreaterThan(0);
		expect(resident.anonKb).toBeLessThanOrEqual(resident.rssKb);
		expect(resident.threads).toBeGreaterThan(0);
	});

	it("reads the cgroup pair the kill bound on, when the box runs cgroup v2", () => {
		const cgroup = readCgroupMemory();
		if (!cgroup) return;
		expect(cgroup.current).toBeGreaterThan(0);
		// `current` includes reclaimable page cache; `anon` is the term an OOM kill binds on.
		expect(cgroup.anon).toBeGreaterThan(0);
		expect(cgroup.anon).toBeLessThanOrEqual(cgroup.current);
		if (cgroup.max !== null) expect(cgroup.max).toBeGreaterThan(0);
	});

	it("reads this VM without an object census or a forced GC", () => {
		const main = readThreadMemory("main");
		expect(main.thread).toBe("main");
		expect(main.heapUsedBytes).toBeGreaterThan(0);
		if (main.jscHeapBytes !== null) expect(main.jscHeapBytes).toBeGreaterThan(0);
	});

	it("names the writing process, so a restart is visible in the file", () => {
		const identity = processIdentity();
		expect(identity.pid).toBe(process.pid);
		expect(identity.startedAtMs).toBeGreaterThan(0);
		expect(identity.startedAtMs).toBeLessThanOrEqual(Date.now());
		// Constant for the process's life: a change between two samples IS a restart.
		expect(processIdentity()).toEqual(identity);
	});
});

describe("MemorySampler", () => {
	it("writes a sample to the journal and leaves the conversation untouched", async () => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const leafBefore = session.getLeafId();
		const messagesBefore = buildSessionContext(session.getEntries()).messages.length;

		samplerOn(session);
		await settle();

		const written = samples(session);
		expect(written).toHaveLength(1);
		expect(written[0]?.sample.reason).toBe("start");
		expect(written[0]?.sample.seq).toBe(1);

		// The entry must never move the branch or reach the model.
		expect(session.getLeafId()).toBe(leafBefore);
		expect(buildSessionContext(session.getEntries()).messages).toHaveLength(messagesBefore);
		expect(resolveSessionLeafId(session.getEntries())).toBe(leafBefore);
	});

	it("counts the session's work incrementally, without rescanning the journal", async () => {
		const session = SessionManager.inMemory();
		const sampler = samplerOn(session);
		await settle();

		session.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "c1", name: "read", arguments: {} },
				{ type: "toolCall", id: "c2", name: "task", arguments: {} },
				{ type: "toolCall", id: "c3", name: "read", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} satisfies AssistantMessage);

		sampler.sample("compaction");
		await settle();

		const work = samples(session).at(-1)?.sample.work;
		expect(work?.toolCalls).toBe(3);
		expect(work?.fileReads).toBe(2);
		expect(work?.subagentDispatches).toBe(1);
		expect(work?.topTools).toEqual([
			["read", 2],
			["task", 1],
		]);
		// The count is the journal as it stood when measured, so it excludes this sample itself.
		expect(work?.journalEntries).toBe(session.entryCount() - 1);
	});

	it("drops a turn sample inside the rate limit but never a compaction one", async () => {
		const session = SessionManager.inMemory();
		const sampler = samplerOn(session);
		await settle();
		expect(samples(session)).toHaveLength(1);

		// A turn landing right after the start sample says nothing new.
		sampler.sample("turn");
		await settle();
		expect(samples(session)).toHaveLength(1);

		// Compaction brackets its work with a sample on each side; neither may be dropped.
		sampler.sample("compaction");
		sampler.sample("compaction");
		await settle();
		expect(samples(session)).toHaveLength(3);
		expect(samples(session).map(entry => entry.sample.seq)).toEqual([1, 2, 3]);
	});

	it("publishes every sample it journals, for an extension to collect", async () => {
		const session = SessionManager.inMemory();
		const published: unknown[] = [];
		const sampler = samplerOn(session, sample => published.push(sample));
		await settle();
		sampler.sample("compaction");
		await settle();

		expect(published).toHaveLength(2);
		expect(published).toEqual(samples(session).map(entry => entry.sample));
	});

	it("stops cleanly and writes nothing afterwards", async () => {
		const session = SessionManager.inMemory();
		const sampler = samplerOn(session);
		await settle();
		sampler.stop();
		sampler.sample("compaction");
		await settle();
		expect(samples(session)).toHaveLength(1);
	});

	it("costs little enough to take every turn", async () => {
		const session = SessionManager.inMemory();
		const sampler = samplerOn(session);
		await settle();
		for (let i = 0; i < 40; i++) {
			sampler.sample("compaction");
			await settle();
		}

		const written = samples(session);
		expect(written.length).toBe(41);
		const costs = written.map(entry => entry.sample.costMs).sort((a, b) => a - b);
		const median = costs[Math.floor(costs.length / 2)] ?? 0;
		// Two small /proc reads and a few counters. The budget is generous against a measured
		// ~0.3 ms so a loaded CI box cannot make this flaky, and it would still catch a
		// heapStats()-style object census, which measured 110 ms at 2.2 M objects.
		expect(median).toBeLessThan(20);

		// A few hundred bytes an entry is what makes a 30-second interval affordable.
		const bytes = JSON.stringify(written[0]).length;
		expect(bytes).toBeLessThan(2000);
	});
});
