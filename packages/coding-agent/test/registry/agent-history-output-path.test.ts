/**
 * A subagent's registry record names the output artifact its executor wrote (`history.outputPath`); the Agent Hub
 * shows it and RPC clients and worker threads get it in their copies of the record. The record keeps the artifact
 * beside its session file as a getter derived from the directory and id it keeps that file as, so every reader, and
 * every copy of the record, must still read the path that was written, whatever the record goes through after.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { ARTIFACTS_DIR, registerSubagent } from "./registry-test-helpers";

const SESSION_FILE = path.join(ARTIFACTS_DIR, "Worker.jsonl");
/** Where the executor writes Worker's output: `<artifactsDir>/<id>.md`, beside its `<id>.jsonl`. */
const OUTPUT_PATH = path.join(ARTIFACTS_DIR, "Worker.md");

/** A live session as a park reads it: its usage, then its disposal. */
function sessionStub(): AgentSession {
	const stub = {
		sessionManager: { getUsageStatistics: () => ({ cost: 0.5, subagentCost: 0 }) },
		dispose: async () => {},
	};
	return stub as unknown as AgentSession;
}

describe("a subagent record's output artifact", () => {
	it("reads as written through park, kill and reopen, and in every copy of the record", async () => {
		// If this regresses, a parked or reopened subagent's record loses its output artifact or names another file:
		// the Agent Hub shows no Output for it, and an RPC client (JSON) or worker thread (structured clone) copying
		// the record gets none.
		const registry = new AgentRegistry();
		const ref = registerSubagent(registry, "Worker", SESSION_FILE, sessionStub());
		expect(registry.setHistory("Worker", { outputPath: OUTPUT_PATH })).toBe(true);
		const lifecycle = new AgentLifecycleManager(registry);
		lifecycle.adopt("Worker", { idleTtlMs: 0 }, ref);
		await lifecycle.park("Worker");

		expect(ref.status).toBe("parked");
		// The park's own history write (its cost) came after the artifact's.
		expect(ref.history?.directCost).toBeCloseTo(0.5);
		const history = ref.history!;
		for (const copy of [history, { ...history }, JSON.parse(JSON.stringify(history)), structuredClone(history)]) {
			expect(copy.outputPath).toBe(OUTPUT_PATH);
		}

		expect(registry.setStatus("Worker", "aborted", ref)).toBe(true);
		const reopened = registry.reopen("Worker", ref);
		expect(reopened?.history?.outputPath).toBe(OUTPUT_PATH);
	});

	it("keeps naming the artifact its executor wrote after the record's transcript is replaced", () => {
		// If this regresses, a subagent whose session moved to another transcript names an artifact beside the new
		// transcript, which its executor never wrote, as its output.
		const registry = new AgentRegistry();
		const ref = registerSubagent(registry, "Worker", SESSION_FILE);
		registry.setHistory("Worker", { outputPath: OUTPUT_PATH });

		// No cost to reset: the record keeps its history object.
		const replacement = path.join(ARTIFACTS_DIR, "Worker-replacement.jsonl");
		expect(registry.attachSession("Worker", sessionStub(), replacement, ref)).toBe(true);
		expect(ref.history?.outputPath).toBe(OUTPUT_PATH);
		// A history write against the new transcript rebuilds it.
		expect(registry.setHistory("Worker", { directCost: 0.1 }, replacement)).toBe(true);
		expect(ref.history?.outputPath).toBe(OUTPUT_PATH);
		// A cost to reset: the next replacement rebuilds it too.
		expect(registry.attachSession("Worker", sessionStub(), SESSION_FILE, ref)).toBe(true);
		expect(ref.history?.directCost).toBeUndefined();
		expect(ref.history?.outputPath).toBe(OUTPUT_PATH);
		// A transcript of the same name in another directory, which a history write against it rebuilds for.
		const moved = path.join(path.sep, "artifacts", "other", "Worker.jsonl");
		expect(registry.attachSession("Worker", sessionStub(), moved, ref)).toBe(true);
		expect(registry.setHistory("Worker", { directCost: 0.2 }, moved)).toBe(true);
		expect(ref.history?.outputPath).toBe(OUTPUT_PATH);
	});

	it("reads an artifact that is not beside the record's session file as written", () => {
		// If this regresses, a subagent whose output was written elsewhere (or that has no session file) is shown
		// with an artifact beside its transcript that does not exist, or with none.
		const elsewhere = path.join(path.sep, "elsewhere", "Worker.md");
		for (const sessionFile of [SESSION_FILE, null]) {
			const registry = new AgentRegistry();
			registerSubagent(registry, "Worker", sessionFile);
			registry.setHistory("Worker", { outputPath: elsewhere });
			registry.setHistory("Worker", { directCost: 0.2 });
			expect(registry.get("Worker")?.history?.outputPath).toBe(elsewhere);
		}
	});
});
