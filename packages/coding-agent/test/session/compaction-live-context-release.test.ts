/**
 * After a compaction, the parent's live context keeps nothing for a message before the cut, so none of it
 * grows with the session's age. The probe runs a real session in its own process: turns whose prompt, tool
 * call, tool result, steer, answer and custom note carry large bodies, a real `session.compact()`, then one
 * more request. Before the compaction it takes weak references to the values each holder keeps for those
 * messages (each must still be held then).
 *
 * Right after `session.compact()` returns, before any further request (an idle session after `/compact` may
 * send none for a long time), every one of them must be collected: the Agent's messages, the append-only log
 * (whose entries include the session's own assistant messages, so the probe also reads what it holds), the
 * prompt-cache warmer's armed request, the conversion caches and the date/cwd reminder injector keep nothing
 * for a message before the cut, and no large heap string may still hold the body of a prompt, steer, tool
 * result or note. The mock declares a prompt cache lifetime, so the warmer keeps a run armed with the last
 * request while the session is idle, as it does for a real provider. After the next request the same holds,
 * the session entries before the cut hold their bodies only in the cold store, and the Agent's tokenizer
 * keeps no estimate for them.
 *
 * Two holders key every message by a short string, which the probe looks for among the heap's strings: the
 * session's persisted-message index (`sessionMessagePersistenceKey`) and the date/cwd reminder injector
 * (role and timestamp). Neither may keep a key for a message before the cut at the compaction, nor after the
 * next request, whose persistence builds the index again after a custom entry moved the leaf. The probe looks
 * for the keys of assistant turns and tool results, which tell the two apart: a user turn's key is the same
 * string in both, and the session's journal of the reminders placed (part of the transcript) holds the first
 * turn's. The injector's state for that turn shows in the copy of it the injector sent.
 *
 * The date/cwd reminder rides on a first turn of its own, before the observed turns, whose copy with the
 * reminder the probe observes on its own. The cold store keeps the 8 records it read last, and a context
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
	persistedKeyTargets: number;
	dateCwdKeyTargets: number;
	persistedKeysSeenBefore: number;
	dateCwdKeysSeenBefore: number;
	keysUnseenBefore: string[];
	reachableAtCompaction: string[];
	agentMessagesAtCompaction: string[];
	appendOnlyLogAtCompaction: string[];
	heapStringsAtCompaction: string[];
	persistedKeysAtCompaction: string[];
	dateCwdKeysAtCompaction: string[];
	dateCwdInjectionAtCompaction: boolean;
	reachableAfterNextRequest: string[];
	dateCwdInjectionAfterNextRequest: boolean;
	heapStringsAfterNextRequest: string[];
	persistedKeysAfterNextRequest: string[];
	dateCwdKeysAfterNextRequest: string[];
	tokenizerChecked: number;
	tokenizerKeptEstimates: number;
	preCutEntriesWhole: string[];
	transcriptMissing: string[];
}

const LIST_FIELDS = [
	"preCut",
	"unheldBefore",
	"keysUnseenBefore",
	"reachableAtCompaction",
	"agentMessagesAtCompaction",
	"appendOnlyLogAtCompaction",
	"heapStringsAtCompaction",
	"persistedKeysAtCompaction",
	"dateCwdKeysAtCompaction",
	"reachableAfterNextRequest",
	"heapStringsAfterNextRequest",
	"persistedKeysAfterNextRequest",
	"dateCwdKeysAfterNextRequest",
	"preCutEntriesWhole",
	"transcriptMissing",
];

function isProbeResult(value: unknown): value is ProbeResult {
	if (typeof value !== "object" || value === null) return false;
	const fields: Record<string, unknown> = { ...value };
	return (
		LIST_FIELDS.every(key => Array.isArray(fields[key])) &&
		typeof fields.observed === "object" &&
		typeof fields.persistedKeyTargets === "number" &&
		typeof fields.dateCwdKeyTargets === "number" &&
		typeof fields.persistedKeysSeenBefore === "number" &&
		typeof fields.dateCwdKeysSeenBefore === "number" &&
		typeof fields.dateCwdInjectionAfterNextRequest === "boolean" &&
		typeof fields.dateCwdInjectionAtCompaction === "boolean" &&
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

let probed: Promise<{ output: string; result: ProbeResult }> | undefined;

/**
 * The probe's one run, which every case reads: its reading after the next request follows the one at the
 * compaction in the same session. No reading says anything unless the cut moved past every observed turn,
 * each holder kept values for those turns before it did, and the heap snapshot showed all but a couple of
 * each holder's keys: a key it cannot show is one this precondition does not read as unheld. The readings
 * after the cut still look for every key, and what they find is held.
 */
function probeOnce(): Promise<{ output: string; result: ProbeResult }> {
	probed ??= (async () => {
		using tempDir = TempDir.createSync("@omp-compaction-live-context-release-");
		const run = await probe(tempDir.path());
		const { output, result } = run;
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
		expect(result.persistedKeyTargets, output).toBeGreaterThan(0);
		expect(result.dateCwdKeyTargets, output).toBeGreaterThan(0);
		// Each holder's keys must be ones the snapshot can show, which is what the readings read: it shows a
		// live string's text only while no other live string of its length hashes to the same 24 bits, and
		// then only the first of the two it writes (the probe's comment on `seenOf`), so a key it misses is
		// one the precondition cannot read as unheld. It misses about one key in 11,500, so a holder's dozen
		// loses exactly two in about 5e-7 of runs, and either holder loses three or more in about 3e-10:
		// more than two means the holder keys its turns under other strings, or keys none, which is a
		// change in the product.
		const unseenAllowed = 2;
		const persistedUnseen = result.persistedKeyTargets - result.persistedKeysSeenBefore;
		const dateCwdUnseen = result.dateCwdKeyTargets - result.dateCwdKeysSeenBefore;
		expect(result.persistedKeysSeenBefore, output).toBeGreaterThan(0);
		expect(result.dateCwdKeysSeenBefore, output).toBeGreaterThan(0);
		expect(persistedUnseen, output).toBeLessThanOrEqual(unseenAllowed);
		expect(dateCwdUnseen, output).toBeLessThanOrEqual(unseenAllowed);
		return run;
	})();
	return probed;
}

// If this regresses, a session left idle after `/compact` (or after a compaction that ended a run) keeps the
// prompts, tool calls and results, steers and notes the compaction summarized in memory until its next request,
// which may not come for a long time: through the append-only log, the cache warmer's armed request, the
// Agent's messages, a conversion cache or the date/cwd reminder injector; and the persisted-message index and
// the injector keep a key for each of them.
it("keeps nothing of the messages before a compaction's cut at the compaction, before any further request", async () => {
	const { output, result } = await probeOnce();

	expect(result.reachableAtCompaction, output).toEqual([]);
	expect(result.dateCwdInjectionAtCompaction, output).toBe(false);
	expect(result.agentMessagesAtCompaction, output).toEqual([]);
	expect(result.appendOnlyLogAtCompaction, output).toEqual([]);
	expect(result.heapStringsAtCompaction, output).toEqual([]);
	expect(result.persistedKeysAtCompaction, output).toEqual([]);
	expect(result.dateCwdKeysAtCompaction, output).toEqual([]);
}, 180_000);

// If this regresses, a long session's memory grows with every compaction and is never given back: the
// prompts, tool calls and results, steers and notes the compaction summarized stay in memory through a cache,
// the request mirror, a queue's side table or the tokenizer, although their entries moved them to the store.
it("keeps nothing of the messages before a compaction's cut once the next request ran", async () => {
	const { output, result } = await probeOnce();

	expect(result.reachableAfterNextRequest, output).toEqual([]);
	expect(result.heapStringsAfterNextRequest, output).toEqual([]);
	expect(result.dateCwdKeysAfterNextRequest, output).toEqual([]);
	expect(result.tokenizerChecked, output).toBeGreaterThan(0);
	expect(result.tokenizerKeptEstimates, output).toBe(0);
	// The entries stay as the transcript, their bodies in the store.
	expect(result.preCutEntriesWhole, output).toEqual([]);
	expect(result.transcriptMissing, output).toEqual([]);
}, 180_000);

// If this regresses, every lookup after a compaction (each persisted message, a new custom entry or label moving
// the leaf first) builds the persisted-message index from the whole branch again, so a long session keeps a key
// for every message its compactions summarized; or the date/cwd reminder injector keeps the turns a compaction cut
// for as long as the session runs, its copy of them sent with their reminders and a key for each.
it("builds the persisted-message index again from the cut on after a compaction", async () => {
	const { output, result } = await probeOnce();

	expect(result.persistedKeysAfterNextRequest, output).toEqual([]);
	// The injector's state after the rebuild: no key of a cut turn (also read once the next request ran), and not
	// the copy of the cut first turn it sent.
	expect(result.dateCwdKeysAfterNextRequest, output).toEqual([]);
	expect(result.dateCwdInjectionAfterNextRequest, output).toBe(false);
}, 180_000);
