import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, shareSystemPromptBlocks } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Counts the live string cells holding a repeated `session_init` prompt block,
 * for a session that resumed a journal carrying many prompt revisions and then
 * recorded more while it ran (dispatch://INFRA-1876).
 *
 * A session appends a fresh `session_init` whenever the rendered base prompt
 * changes, and each one carries the WHOLE prompt. Without block sharing the
 * manager holds one backing store per revision of the blocks no revision
 * touched; with it, one.
 */

interface V8HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: Array<string | string[]>;
		};
	};
	nodes: number[];
	strings: string[];
}

/** Revisions written into the journal, and again after it is resumed. */
const REVISIONS = 12;
/** Turns between compactions; the journal compacts more than once. */
const TURNS_PER_COMPACTION = 8;
const CATALOGUE_MARKER = "omp-probe-catalogue-";
const SKILL_MARKER = "omp-probe-skill-";
const CATALOGUE = `${CATALOGUE_MARKER}${"c".repeat(48 * 1024)}`;
const SKILL = `${SKILL_MARKER}${"s".repeat(16 * 1024)}`;
/** Smaller than any repeated block, larger than the markers' own literals. */
const BLOCK_SIZE_FLOOR = 4096;

/** A distinct backing store with the same text, as a fresh render of the prompt produces. */
function freshCopy(text: string): string {
	return JSON.parse(JSON.stringify(text)) as string;
}

async function writeJournal(sessionFile: string): Promise<void> {
	const header = {
		type: "session",
		version: 3,
		id: "probe",
		timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
		cwd: path.dirname(sessionFile),
	};
	const lines: string[] = [`${JSON.stringify(header)}\n`];
	let parentId: string | null = null;
	let sequence = 1;
	let firstKeptEntryId = "";
	const push = (entry: Record<string, unknown>): string => {
		const id = `e${sequence}`;
		const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
		lines.push(`${JSON.stringify({ ...entry, id, parentId, timestamp })}\n`);
		parentId = id;
		sequence++;
		return id;
	};

	for (let revision = 0; revision < REVISIONS; revision++) {
		push({
			type: "session_init",
			// Every revision re-renders the whole prompt; only the last block moves.
			systemPrompt: [freshCopy(CATALOGUE), freshCopy(SKILL), `roster revision ${revision}`],
			task: "probe",
			tools: ["read"],
		});
		const userId = push({
			type: "message",
			message: { role: "user", content: `turn ${revision}`, timestamp: revision },
		});
		if (!firstKeptEntryId) firstKeptEntryId = userId;
		push({
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `reply ${revision}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: revision,
			},
		});
		if ((revision + 1) % TURNS_PER_COMPACTION === 0) {
			push({ type: "compaction", summary: `compacted at ${revision}`, firstKeptEntryId, tokensBefore: 1000 });
			firstKeptEntryId = "";
		}
	}
	// Two compactions regardless of how the revision count divides.
	push({ type: "compaction", summary: "final compaction", firstKeptEntryId: parentId ?? "", tokensBefore: 2000 });
	await fsp.writeFile(sessionFile, lines.join(""));
}

/** Record further revisions the way `AgentSession.#recordModelCallSystemPrompt` does. */
function recordLiveRevisions(manager: SessionManager): void {
	let retained: string[] = [];
	for (let revision = 0; revision < REVISIONS; revision++) {
		const base = [freshCopy(CATALOGUE), freshCopy(SKILL), `live roster revision ${revision}`];
		const systemPrompt = shareSystemPromptBlocks(base, retained);
		manager.appendSessionInit({ systemPrompt, task: "probe", tools: ["read"] });
		retained = systemPrompt;
	}
}

function countLiveBlocks(): { catalogue: number; skill: number; blockBytes: number } {
	const heap = JSON.parse(Bun.generateHeapSnapshot("v8")) as V8HeapSnapshot;
	const { node_fields: nodeFields, node_types: nodeTypes } = heap.snapshot.meta;
	const typeOffset = nodeFields.indexOf("type");
	const nameOffset = nodeFields.indexOf("name");
	const sizeOffset = nodeFields.indexOf("self_size");
	const typeNames = nodeTypes[typeOffset];
	if (typeOffset < 0 || nameOffset < 0 || sizeOffset < 0 || !Array.isArray(typeNames)) {
		throw new Error("Unexpected V8 heap snapshot schema");
	}
	let catalogue = 0;
	let skill = 0;
	let blockBytes = 0;
	for (let nodeOffset = 0; nodeOffset < heap.nodes.length; nodeOffset += nodeFields.length) {
		if (typeNames[heap.nodes[nodeOffset + typeOffset]!] !== "string") continue;
		const size = heap.nodes[nodeOffset + sizeOffset]!;
		if (size < BLOCK_SIZE_FLOOR) continue;
		const name = heap.strings[heap.nodes[nodeOffset + nameOffset]!];
		if (typeof name !== "string") continue;
		if (name.startsWith(CATALOGUE_MARKER)) catalogue++;
		else if (name.startsWith(SKILL_MARKER)) skill++;
		else continue;
		blockBytes += size;
	}
	return { catalogue, skill, blockBytes };
}

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-session-init-retention-"));
let manager: SessionManager | undefined;
try {
	const sessionFile = path.join(dir, "probe.jsonl");
	await writeJournal(sessionFile);
	manager = await SessionManager.open(sessionFile, dir);
	recordLiveRevisions(manager);
	await manager.flush();

	// Collect from fresh event-loop turns, twice: each turn re-enters the native
	// stack at a different depth, so a stale cell one conservative scan happened
	// to pin is not reachable from the next.
	for (let pass = 0; pass < 2; pass++) {
		await Bun.sleep(0);
		Bun.gc(true);
	}
	const live = countLiveBlocks();
	// Read the manager after the snapshot so nothing above is the last use of it.
	const initCount = manager.getEntries().filter(entry => entry.type === "session_init").length;
	process.stdout.write(
		JSON.stringify({
			revisions: REVISIONS,
			initCount,
			catalogue: live.catalogue,
			skill: live.skill,
			blockBytes: live.blockBytes,
			heapUsed: process.memoryUsage().heapUsed,
			rss: process.memoryUsage().rss,
		}),
	);
} finally {
	manager?.seal();
	await fsp.rm(dir, { recursive: true, force: true });
}
