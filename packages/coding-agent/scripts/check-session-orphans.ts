#!/usr/bin/env bun
/**
 * Report whether a stored session still replays an orphaned synthetic tool
 * result — the shape that got every later turn of a session refused
 * (INFRA-1191): a not-executed placeholder whose `tool_use` is in no stored
 * assistant turn, which the provider request then carried as a bare user
 * message.
 *
 * Usage: bun packages/coding-agent/scripts/check-session-orphans.ts <session.jsonl> [...]
 *
 * `stored orphans` counts the stored messages; `replayed orphans` counts what the
 * rebuilt model context still sends. The fix leaves the file untouched and
 * makes the second number 0, so one run shows the before and the after. Exit
 * status is 1 when any session still replays one. Both counts read the
 * entries as a resume holds them: with the session's `tool_result_prune` and
 * `entry_patch` records applied, so a failed turn a later turn continued from
 * stays in the replayed context.
 *
 * Read-only: no lock is taken and nothing is written, so it is safe against a
 * session a live agent is writing.
 */
import { isSyntheticToolResultMessage, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { applyEntryPatches } from "../src/session/entry-patches";
import { buildSessionContext } from "../src/session/session-context";
import { loadEntriesFromFile } from "../src/session/session-loader";
import { migrateToCurrentVersion } from "../src/session/session-migrations";
import type { SessionEntry } from "../src/session/session-entries";
import { applyToolResultPrunes } from "../src/session/tool-result-prunes";

interface Report {
	file: string;
	entries: number;
	storedSynthetic: number;
	storedOrphans: number;
	replayedMessages: number;
	replayedOrphans: number;
}

function emittedToolCallIds(messages: Iterable<AgentMessage>): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.add(block.id);
		}
	}
	return ids;
}

function countOrphans(messages: AgentMessage[]): { synthetic: number; orphans: number } {
	const emitted = emittedToolCallIds(messages);
	let synthetic = 0;
	let orphans = 0;
	for (const message of messages) {
		if (!isSyntheticToolResultMessage(message)) continue;
		synthetic++;
		if (!emitted.has(message.toolCallId)) orphans++;
	}
	return { synthetic, orphans };
}

async function inspect(file: string): Promise<Report> {
	const entries = await loadEntriesFromFile(file, undefined, { throwIfMissing: true });
	migrateToCurrentVersion(entries);
	// The records a resume applies, in its order: blanked results, then patched fields (`continued` among them).
	applyToolResultPrunes(entries);
	applyEntryPatches(entries);
	const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");

	// Stored: every persisted message, with the records applied, and no pairing repair of any kind.
	const stored: AgentMessage[] = [];
	for (const entry of sessionEntries) {
		if (entry.type === "message") stored.push(entry.message);
	}
	const onDisk = countOrphans(stored);

	// What the next request would carry: the model-context rebuild.
	const { messages } = buildSessionContext(sessionEntries);
	const replayed = countOrphans(messages);

	return {
		file,
		entries: sessionEntries.length,
		storedSynthetic: onDisk.synthetic,
		storedOrphans: onDisk.orphans,
		replayedMessages: messages.length,
		replayedOrphans: replayed.orphans,
	};
}

const files = Bun.argv.slice(2);
if (files.length === 0) {
	console.error("usage: bun packages/coding-agent/scripts/check-session-orphans.ts <session.jsonl> [...]");
	process.exit(2);
}

let failed = false;
for (const file of files) {
	const report = await inspect(file);
	if (report.replayedOrphans > 0) failed = true;
	console.log(
		[
			report.file,
			`entries=${report.entries}`,
			`stored synthetic=${report.storedSynthetic}`,
			`stored orphans=${report.storedOrphans}`,
			`replayed messages=${report.replayedMessages}`,
			`replayed orphans=${report.replayedOrphans}`,
			report.replayedOrphans === 0 ? "HEALED" : "STILL ORPHANED",
		].join(" "),
	);
}
process.exit(failed ? 1 : 0);
