/**
 * A registry record names its agent's transcript (`sessionFile`): a revive reopens it, `history://` and the Agent Hub
 * read it, and RPC clients and worker threads get it in their copies of the record. A record keeps a transcript of the
 * form `<directory>/<id>.jsonl` as the directory it shares with the other records there, and derives the path from it
 * and its id, so every reader, and every copy of the record, must still read the path it was given, whatever the record
 * goes through after.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const ARTIFACTS_DIR = path.join(path.sep, "artifacts", "main");
const OTHER_DIR = path.join(path.sep, "artifacts", "other");

function register(registry: AgentRegistry, id: string, sessionFile: string | null) {
	return registry.register({ id, displayName: "task", kind: "sub", session: null, sessionFile, status: "parked" });
}

/** The session file of `ref` as each copy of it reads it: the record, a spread, and JSON of it (an RPC client's). */
function readings(ref: { sessionFile: string | null }): (string | null)[] {
	const copy = { ...ref };
	return [ref.sessionFile, copy.sessionFile, JSON.parse(JSON.stringify(copy)).sessionFile];
}

describe("a registry record's session file", () => {
	it("reads as each record was given it, in every copy of the record", () => {
		// If this regresses, a subagent is revived from, or shown with, another agent's transcript or none: records in
		// one directory, in another, or named otherwise than by their id must each read their own file.
		const registry = new AgentRegistry();
		const given: [string, string | null][] = [
			["Worker", path.join(ARTIFACTS_DIR, "Worker.jsonl")],
			["Peer", path.join(ARTIFACTS_DIR, "Peer.jsonl")],
			["Remote", path.join(OTHER_DIR, "Remote.jsonl")],
			// Ends with its id, but in a file named otherwise.
			["Suffix", path.join(ARTIFACTS_DIR, "PrefixSuffix.jsonl")],
			["Root", path.join(ARTIFACTS_DIR, "2026-11-22_root.jsonl")],
			["Unsaved", null],
		];
		for (const [id, sessionFile] of given) register(registry, id, sessionFile);
		for (const [id, sessionFile] of given) {
			expect(readings(registry.get(id)!)).toEqual([sessionFile, sessionFile, sessionFile]);
		}
	});

	it("names the transcript a session attach, or a reopen after a kill, gives it", () => {
		// If this regresses, a subagent whose session moved to another transcript, or one reopened after a kill, is
		// revived from the transcript it had before, or from none.
		const registry = new AgentRegistry();
		const ref = register(registry, "Worker", path.join(ARTIFACTS_DIR, "Worker.jsonl"));
		const session = {} as AgentSession;
		for (const sessionFile of [
			path.join(OTHER_DIR, "Worker.jsonl"),
			path.join(ARTIFACTS_DIR, "Worker-replacement.jsonl"),
			null,
			path.join(ARTIFACTS_DIR, "Worker.jsonl"),
		]) {
			expect(registry.attachSession("Worker", session, sessionFile, ref)).toBe(true);
			expect(readings(ref)).toEqual([sessionFile, sessionFile, sessionFile]);
		}

		expect(registry.detachSession("Worker", ref)).toBe(true);
		expect(registry.setStatus("Worker", "aborted", ref)).toBe(true);
		const reopened = registry.reopen("Worker", ref);
		expect(reopened?.sessionFile).toBe(path.join(ARTIFACTS_DIR, "Worker.jsonl"));
	});
});
