/**
 * A session's first-turn Mnemopi recall is recorded in its transcript with the banks it read. A session constructed over
 * such a transcript (`omp render` constructs one over the file it draws) must be constructed whether or not anything in
 * the process has loaded Mnemopi's core module yet, as it is at the release. Mnemopi's default per-project scoping names
 * a project bank whose database path the core module resolves; the global scoping names only the shared one.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MEMORY_RECALL_ENTRY_TYPE, persistRecall } from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { MnemopiTranscriptRun } from "./fixtures/mnemopi-transcript-session-process";

const PROCESS = path.join(import.meta.dir, "fixtures/mnemopi-transcript-session-process.ts");

/** Writes a transcript whose first turn recorded a Mnemopi recall, and returns its file. */
async function writeTranscript(dir: TempDir): Promise<string> {
	const writer = SessionManager.create(dir.path(), dir.join("sessions"));
	writer.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
	persistRecall(writer, JSON.stringify(["mnemopi", []]), { text: "", memories: [] });
	writer.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "the release is ready" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await writer.flush();
	const file = writer.getSessionFile();
	await writer.close();
	if (!file) throw new Error("Expected a persisted session");
	return file;
}

/** Constructs a session over `sessionFile` in a process of its own, under `memoryYml`. */
async function constructInFreshProcess(dir: TempDir, memoryYml: string, sessionFile: string) {
	const overlay = dir.join("memory.yml");
	await Bun.write(overlay, memoryYml);
	const out = dir.join("run.json");
	const child = Bun.spawn(
		[process.execPath, PROCESS, JSON.stringify({ dir: dir.path(), overlay, sessionFile, out })],
		{
			cwd: dir.path(),
			env: { ...process.env, PI_TEST_RUNTIME: "1" },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`The process exited with ${exitCode}: ${stderr}`);
	return (await Bun.file(out).json()) as MnemopiTranscriptRun;
}

function mnemopiYml(dir: TempDir, scoping: "per-project" | "global"): string {
	return `memory:
  backend: mnemopi
mnemopi:
  dbPath: ${dir.join("mnemopi", "mnemopi.db")}
  scoping: ${scoping}
  noEmbeddings: true
  llmMode: none
`;
}

describe("a session constructed over a transcript that recorded a Mnemopi recall", () => {
	it.each(["per-project", "global"] as const)(
		"is constructed under Mnemopi's %s scoping before the core module loads",
		async scoping => {
			using dir = TempDir.createSync("@pi-mnemopi-transcript-construct-");
			const sessionFile = await writeTranscript(dir);
			const transcript = await SessionManager.open(sessionFile);
			const recorded = transcript
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === MEMORY_RECALL_ENTRY_TYPE);
			await transcript.close();
			// Precondition: the transcript records the recall, and a turn followed it.
			expect(recorded).toBe(true);

			const run = await constructInFreshProcess(dir, mnemopiYml(dir, scoping), sessionFile);
			// Precondition: nothing in the process loaded Mnemopi's core module before the session was constructed.
			expect(run.coreLoadedBefore).toBe(false);
			expect(run.error).toBeUndefined();
		},
		60_000,
	);
});
