/**
 * After a compaction, the parent's live context keeps nothing for a message before the cut, so none of it
 * grows with the session's age. The probe runs a real session in its own process: turns whose prompt, tool
 * call, tool result, steer, answer and custom note carry large bodies, a real `session.compact()`, then one
 * more request. Before the compaction it takes weak references to the values each holder keeps for those
 * messages (each must still be held then); after the next request every one of them must be collected, the
 * session entries before the cut must hold their bodies only in the cold store, the Agent's messages must hold
 * none of them, no large heap string may still hold the body of a prompt, steer, tool result or note, and the
 * Agent's tokenizer must keep no estimate for them.
 *
 * The append-only log and the cache warmer's confirmed entry mirror the last request sent, so they let go of
 * it at the next request, not at the compaction; the probe reads after that request. Two holders keep a
 * bounded amount by design and are kept out of the probe's view: the date/cwd reminder injector keeps the
 * first user turn of each of the last 8 conversations it served (`MAX_ROOTS` in `date-cwd-reminder.ts`), so
 * the observed turns follow a warm-up turn; the cold store keeps the 8 records it read last, and a context
 * rebuild reads every assistant entry's content, so the heap check leaves the assistant's bodies out.
 *
 * Compiled code is counted in the heap and can keep objects alive, so the probe runs with the JIT off and has
 * the engine drop the code of functions that stopped running at the next collection.
 */
import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const probePath = path.join(import.meta.dir, "../fixtures/compaction-live-context-release-probe.ts");

interface ProbeResult {
	preCut: string[];
	observed: Record<string, number>;
	unheldBefore: string[];
	afterNextRequest: string[];
	agentMessagesPreCut: string[];
	heapStringsPreCut: string[];
	tokenizerChecked: number;
	tokenizerKeptEstimates: number;
	preCutEntriesWhole: string[];
	transcriptMissing: string[];
}

const LIST_FIELDS = [
	"preCut",
	"unheldBefore",
	"afterNextRequest",
	"agentMessagesPreCut",
	"heapStringsPreCut",
	"preCutEntriesWhole",
	"transcriptMissing",
];

function isProbeResult(value: unknown): value is ProbeResult {
	if (typeof value !== "object" || value === null) return false;
	const fields: Record<string, unknown> = { ...value };
	return (
		LIST_FIELDS.every(key => Array.isArray(fields[key])) &&
		typeof fields.observed === "object" &&
		typeof fields.tokenizerChecked === "number" &&
		typeof fields.tokenizerKeptEstimates === "number"
	);
}

async function probe(root: string): Promise<{ output: string; result: ProbeResult }> {
	const child = Bun.spawn([process.execPath, probePath, root], {
		cwd: path.join(import.meta.dir, "../../../.."),
		env: {
			...process.env,
			HOME: path.join(root, "home"),
			USERPROFILE: path.join(root, "home"),
			PI_CODING_AGENT_DIR: path.join(root, "agent"),
			BUN_JSC_useJIT: "0",
			BUN_JSC_useEagerCodeBlockJettisonTiming: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const output = stdout.trim();
	const result: unknown = JSON.parse(output);
	if (!isProbeResult(result)) throw new Error(`Unexpected probe output: ${output}`);
	return { output, result };
}

// If this regresses, a long session's memory grows with every compaction and is never given back: the
// prompts, tool calls and results, steers and notes the compaction summarized stay in memory through a cache,
// the request mirror, a queue's side table or the tokenizer, although their entries moved them to the store.
it("keeps nothing of the messages before a compaction's cut once the next request ran", async () => {
	using tempDir = TempDir.createSync("@omp-compaction-live-context-release-");
	const { output, result } = await probe(tempDir.path());

	// The cut moved past every observed turn, and each holder kept values for those turns before it did.
	expect(result.preCut, output).toEqual(
		expect.arrayContaining(["PROMPT-0", "ARGS-0", "RESULT-0", "STEER-1", "ANSWER-0", "NOTE-0", "PROMPT-3"]),
	);
	for (const holder of [
		"body",
		"agent message",
		"convertToLlm fragment",
		"steering wrapper",
		"convertToLlm output array",
		"append-only log entry",
		"last request message",
	]) {
		expect(result.observed[holder] ?? 0, `${holder}: ${output}`).toBeGreaterThan(0);
	}
	expect(result.unheldBefore, output).toEqual([]);

	expect(result.afterNextRequest, output).toEqual([]);
	expect(result.agentMessagesPreCut, output).toEqual([]);
	expect(result.heapStringsPreCut, output).toEqual([]);
	expect(result.tokenizerChecked, output).toBeGreaterThan(0);
	expect(result.tokenizerKeptEstimates, output).toBe(0);
	// The entries stay as the transcript, their bodies in the store.
	expect(result.preCutEntriesWhole, output).toEqual([]);
	expect(result.transcriptMissing, output).toEqual([]);
}, 180_000);
