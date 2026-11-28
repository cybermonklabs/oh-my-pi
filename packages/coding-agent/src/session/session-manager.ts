import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	ServiceTierByFamily,
	TextContent,
	Usage,
} from "@oh-my-pi/pi-ai";
import {
	directoryIsEnterable,
	directoryIsMissing,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEexist,
	isEnoent,
	isEnotdir,
	isEnotempty,
	isFsError,
	isRecord,
	logger,
	pathIsWithin,
	stringifyDeepJson,
	stringifyJson,
	structuredCloneDeep,
	toError,
} from "@oh-my-pi/pi-utils";
import {
	ENTRY_PATCH_CUSTOM_TYPE,
	entryAcceptsPatch,
	isEntryPatchData,
	isEntryPatchRecord,
} from "@oh-my-pi/pi-utils/entry-patches";
import { isTaskToolDetails, type StructuredSubagentSchemaMode } from "@oh-my-pi/pi-tui/tools/task";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { TRANSCRIPT_READ_CAP } from "../collab/protocol";
import { moveFileAcrossDevices } from "../utils/atomic-file";
import { hasAnnotationDraftsSync } from "../extensibility/custom-commands/bundled/annotate/draft-store";
import { isSettingsInitialized, Settings } from "../config/settings";
import {
	recordMaskedHistory,
	type SessionStoreMask,
	type StoreMaskingBinding,
	sessionStoreMaskFor,
	settingsStoreMask,
} from "../secrets/session-store-mask";
import { ArtifactManager, type ArtifactManagerApi } from "./artifacts";
import { type BlobPutOptions, type BlobPutResult, BlobStore, isBlobRef, lazyImageDataSync } from "./blob-store";
import {
	coldEntryForPersistence,
	convertColdEntries,
	convertToColdEntry,
	copyColdEntry,
	hydrateColdEntry,
	hydrateKeptEntries,
	isColdEntry,
	jsonTextMayFit,
	wholeTargetsOf,
} from "./cold-entries";
import {
	type ColdBoundary,
	coldBoundary,
	coldCutPathIndex,
	coldKindOf,
	readCompactions,
	streamedKeptStart,
} from "./cold-entry-policy";
import { ColdEntryStore } from "./cold-entry-store";
import type { CompactionMethod } from "./compaction-methods";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import type { WorkPoolYieldItem } from "../task/workpool-yield";
import type { SubagentSpawnSpec } from "../task/spawn-spec";
import { createInterruptedToolResults, sessionExitFollowsLastMessage } from "./exit-diagnostics";
import type { RetryFallbackRole } from "./retry-fallback-chains";
import {
	type BuildSessionContextOptions,
	buildSessionContext,
	type SessionContext,
	snapcompactHistoryBlockOptions,
} from "./session-context";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CredentialPinEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	EPHEMERAL_MODEL_CHANGE_ROLE,
	PREWALK_MODEL_CHANGE_ROLE,
	type FileEntry,
	type HeldChangeBase,
	type LabelEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type ModelUsageEntry,
	lastSelfSelectedLeafId,
	type NewSessionOptions,
	type ResetBoundaryEntry,
	type ServiceTierChangeEntry,
	sessionEntryLeafId,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import { currentRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity";
import { isArchivedSessionPath, restoreArchivedSession } from "./session-archive";
import {
	findMostRecentNonEmptySession,
	findRecentSessionContinuation,
	findSessionContinuation,
	isEmptySession,
	listAllSessions,
	listAllSessionsForPicker,
	listSessions,
	listSessionsForPicker,
	movesConversation,
	type PickerListing,
	type SessionContinuation,
	type SessionInfo,
} from "./session-listing";
import {
	collectBlobRefNames,
	isValidSessionHeader,
	normalizeAssistantUsage,
	parseSessionContent,
	probeSessionFile,
	readSessionHeaderId,
	resolveBlobRefsInEntries,
	resolveBlobRefsInEntriesSync,
	type SessionFileVisit,
	type SessionLoadResult,
	sessionContentDigest,
	transcriptByteChunks,
	visitEntriesFromChunksSync,
	visitEntriesFromFile,
	type VisitEntriesFromFileStreamOptions,
	visitEntriesFromFileStream,
	visitLoadedSession,
	visitSessionFile,
} from "./session-loader";
import { generateId, lacksEntryId, SessionEntryMigration, UnindexedCount } from "./session-migrations";
import {
	computeDefaultSessionDir,
	hasPositiveMovedProjectEvidence,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	worktreeSessionDirs,
	writeTerminalBreadcrumb,
} from "./session-paths";
import { maskSessionEntry, maskTitleUpdate } from "./session-entry-mask";
import { forgetExternalizedImages, persistedEntryText } from "./session-persistence";
import { loadPinnedSessionIds, sortPinnedFirst } from "./session-pins";
import {
	defaultSessionStorage,
	FileSessionStorage,
	isSameJournalFile,
	isSessionStoreOutage,
	isSessionStoreWriteRefusal,
	MemorySessionStorage,
	retryRacedRead,
	SESSION_HEADER_PREFIX_BYTES,
	type SessionClaimHolder,
	SessionLeaseLostError,
	SessionReadConflictError,
	type SessionStorage,
	type SessionStorageWriter,
	SessionWriteConflictError,
	sessionHeaderIdInPrefix,
	sessionLeaseId,
	sessionLeaseRoot,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";
import {
	copyTranscriptTree,
	moveTranscriptTree,
	restoreTranscripts,
	type TranscriptPlacement,
} from "./session-transcript-tree";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	normalizeWorkspaceDirectory,
} from "./session-workspace";
import { recordSessionRecap, recordSessionTitle } from "./session-index";
import {
	applyEntryPatches,
	type EntryPatch,
	maskEntryPatchRecord,
	setPatchedFields,
	toEntryPatchData,
	withoutEntryPatches,
} from "./entry-patches";
import { applyToolResultPrunes } from "./tool-result-prunes";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;
const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";
const utf8Encoder = new TextEncoder();
/** UTF-8 bytes of the intended body encoded per step when verifying a failed acknowledgement. */
const ACK_COMPARE_WINDOW_BYTES = 1 << 16;
/**
 * UTF-8 bytes of whole entries one append carries when it writes a backlog
 * of entries the session file is missing; an entry larger than this goes
 * alone. Bounds what a heal holds in memory however long the backlog grew.
 */
export const SESSION_TAIL_APPEND_CHUNK_BYTES = 4 * 1024 * 1024;
/** `details.kind` of the empty `branch_summary` {@link SessionManager.discardEntryDurably} writes. */
export const DISCARDED_ENTRY_BRANCH_MARKER = "discarded-entry-branch";
/**
 * Read-back-and-retry passes one full rewrite makes after meeting another
 * writer's entries. Each pass re-reads the file, so only a writer that appends
 * inside every read-to-publish window exhausts them.
 */
const MAX_WRITE_CONFLICT_RECOVERIES = 3;
/**
 * How an `entry_patch` record's line writes its data: a bigint as its decimal
 * string, and a value nested past `JSON.stringify`'s reach (an elided turn's
 * tool call) by the deep writer.
 */
const RECORD_LINE_JSON = { bigintAsString: true, probeDepth: true } as const;

/** Drains a switch runs for writes made while it loads its target, before it sets the new file (#setSessionFile). */
const GAP_DRAIN_PASSES = 4;

/** What a store holds at a session's path: nothing, a body (by byte length and SHA-256), or unknown. */
type StoredTranscriptState =
	| { kind: "absent" }
	| { kind: "unread" }
	| { kind: "present"; size: number; sha256: string };

/** A fresh session id. */
export function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

/**
 * Whether this process runs under `OMP_SESSION_EXCLUSIVE=1`: its launcher
 * named the session it resumes (a pod's recorded id), so no path may move it
 * to another id. Every path that would (a session another process holds, a
 * lease taken over, a file another writer changed or replaced) ends the
 * process non-zero instead, and writes no sibling. Read each time: child
 * processes inherit the variable from the launcher's exec.
 */
export function isSessionExclusive(): boolean {
	return process.env.OMP_SESSION_EXCLUSIVE === "1";
}

/**
 * The move-offs this process made, by the resolved file each moved off: the
 * sibling it went on in, and the copy of its artifacts there. A subagent
 * transcript under a moved-off session's artifacts directory follows it (see
 * `SessionManager.#followParentMove`). In-process only: no marker records a
 * move for another process. A manager forgets its own once it leaves the
 * session (closes, or opens or starts another); a subagent transcript of the
 * old session that writes after that forks to a session of its own.
 */
const sessionMoveOffs = new Map<string, { to: string; copied: Promise<void> }>();

/** How long a subagent transcript whose parent's lease is lost waits for the parent to go on in a sibling. */
const PARENT_MOVE_WAIT_MS = 1000;

/** How long an `OMP_SESSION_EXCLUSIVE=1` stop waits to learn who holds the session before it ends the process without naming them. */
const EXCLUSIVE_STOP_HOLDER_LOOKUP_MS = 2000;

/** How often an open that waits on a session's file lease (see `#waitForOpenFileClaim`) tries to take it again. */
const OPEN_FILE_CLAIM_RETRY_MS = 100;

/**
 * `moveTo` refused and left the session where it was: another live omp
 * process writes the session, or the session file at the destination, or
 * another client of a shared store wrote a destination key during the move.
 */
export class SessionMoveRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionMoveRefusedError";
	}
}

/**
 * A refusing rename's `EEXIST` as the refusal it is: a destination key the
 * move would replace is taken, by a row another client of the shared store
 * wrote or one that was there before. Called once the move rolled back, so
 * nothing moved.
 */
function refusedByTakenKey(err: unknown): unknown {
	if (!isEexist(err)) return err;
	return new SessionMoveRefusedError(
		`Cannot move session: "${err.path}" is already taken, so moving there would replace it. Nothing was moved.`,
	);
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -JSONL_SUFFIX_LENGTH);
}

/**
 * Copy a session's artifact directory to another session, matching interactive
 * `/fork`. Never overwrites: a destination file written while the copy runs
 * (a session that already moved and kept working) wins over the source's copy.
 * The directory on disk holds tool artifacts; the subagent transcripts nested
 * in it are copied through `storage`, which holds them as rows under
 * `session.storage: sql` (under file storage the directory copy already
 * placed them, and the storage pass finds nothing left to do). Failures are
 * logged, never thrown.
 */
export async function copySessionArtifacts(
	sourceSessionFile: string,
	destinationSessionFile: string,
	storage: SessionStorage = defaultSessionStorage(),
): Promise<void> {
	// Artifacts sit beside the journal's real name: a session reached through a
	// symlink keeps them next to the link's target, not next to the link.
	let realSource = sourceSessionFile;
	try {
		realSource = await fs.promises.realpath(sourceSessionFile);
	} catch {}
	const sourceArtifactsDir = artifactsDirectoryFor(realSource);
	const destinationArtifactsDir = artifactsDirectoryFor(destinationSessionFile);
	if (!sourceArtifactsDir || !destinationArtifactsDir) return;
	if (path.resolve(sourceArtifactsDir) === path.resolve(destinationArtifactsDir)) return;
	try {
		if ((await fs.promises.stat(sourceArtifactsDir)).isDirectory()) {
			// Create the destination first and merge into it: Bun's `cp` fails with
			// EEXIST when another writer (the moved session's artifact manager,
			// `local://`) creates the directory while the copy is starting.
			await fs.promises.mkdir(destinationArtifactsDir, { recursive: true });
			await fs.promises.cp(sourceArtifactsDir, destinationArtifactsDir, {
				recursive: true,
				force: false,
				errorOnExist: false,
			});
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to copy session artifacts", {
				sourceArtifactsDir,
				destinationArtifactsDir,
				error: toError(error).message,
			});
		}
	}
	try {
		// A key-indexed storage keeps the session's draft as a row beside the
		// transcripts; under file storage the directory copy above carried it.
		await copyTranscriptTree(
			storage,
			sourceArtifactsDir,
			destinationArtifactsDir,
			storage instanceof FileSessionStorage ? "*.jsonl" : "*",
		);
	} catch (error) {
		logger.warn("Failed to copy subagent transcripts", {
			sourceArtifactsDir,
			destinationArtifactsDir,
			error: toError(error).message,
		});
	}
}

/** The numeric id an artifact file name (`<id>.<tool>.log`) carries, if any. */
function artifactIdOf(name: string): string | undefined {
	return /^(\d+)\./.exec(name)?.[1];
}

/**
 * Move one directory entry without replacing anything that has appeared at
 * `to` since the caller listed the destination. `link(2)` refuses an existing
 * target where `rename(2)` would silently overwrite it; where hard links are
 * unavailable an exclusive copy keeps the same guarantee. A directory rename
 * only ever replaces an empty directory, which is harmless.
 */
async function moveEntryWithoutReplacing(from: string, to: string, isDirectory: boolean): Promise<void> {
	if (isDirectory) {
		await fs.promises.rename(from, to);
		return;
	}
	try {
		await fs.promises.link(from, to);
	} catch (err) {
		if (isEexist(err)) throw err;
		await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
	}
	try {
		await fs.promises.unlink(from);
	} catch (err) {
		// The entry has landed; a second copy left behind is not a failed move.
		if (!isEnoent(err)) logger.debug("Artifact placed but its source copy could not be removed", { from, to });
	}
}

/** What `destination` currently holds: entries by name, and the artifact ids (`<id>.<tool>.log`) already in use. */
async function destinationOccupancy(
	destination: string,
): Promise<{ occupants: Map<string, fs.Dirent>; takenIds: Set<string> }> {
	const present = await fs.promises.readdir(destination, { withFileTypes: true });
	const occupants = new Map(present.map(entry => [entry.name, entry]));
	const takenIds = new Set<string>();
	for (const entry of present) {
		const id = artifactIdOf(entry.name);
		if (id !== undefined) takenIds.add(id);
	}
	return { occupants, takenIds };
}

/**
 * Move `source`'s entries into `destination`, recursing into directories that
 * exist on both sides, then remove `source` once it is empty. Nothing at the
 * destination is ever replaced: an entry whose name — or, for `<id>.<tool>.log`
 * artifact files, whose id — is already taken stays at the source, as does one
 * whose move fails. Once moving has begun this never throws, so the caller is
 * never left with a session file rolled back away from artifacts that already
 * moved. Returns the entries left at the source, each with its reason.
 */
async function mergeDirectoryInto(
	source: string,
	destination: string,
	stranded: string[] = [],
	prefix = "",
): Promise<string[]> {
	let { occupants, takenIds } = await destinationOccupancy(destination);
	const strandedBefore = stranded.length;
	for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		const label = prefix + entry.name;
		const id = artifactIdOf(entry.name);
		try {
			// A writer can publish another `<id>.*` file while earlier entries move,
			// and a different file name slips past link(2)'s EEXIST; list again right
			// before an id-bearing move so the check is one syscall old, not the
			// whole merge. Inside the boundary: a failed listing strands this entry
			// like a failed move would, instead of aborting a merge already under way.
			if (id !== undefined) ({ occupants, takenIds } = await destinationOccupancy(destination));
			const occupant = occupants.get(entry.name);
			if (occupant === undefined && (id === undefined || !takenIds.has(id))) {
				if (entry.isDirectory()) {
					try {
						await moveEntryWithoutReplacing(from, to, true);
					} catch (err) {
						if (!isFsError(err) || err.code !== "EXDEV") throw err;
						await fs.promises.mkdir(to);
						await mergeDirectoryInto(from, to, stranded, `${label}/`);
					}
				} else {
					await moveEntryWithoutReplacing(from, to, false);
				}
			} else if (occupant?.isDirectory() && entry.isDirectory()) {
				await mergeDirectoryInto(from, to, stranded, `${label}/`);
			} else {
				stranded.push(`${label} (${occupant === undefined ? "id" : "name"} taken)`);
			}
		} catch (err) {
			// ENOENT: the entry vanished under us (a writer's temp file); nothing to move.
			if (!isEnoent(err)) stranded.push(`${label} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	try {
		await fs.promises.rmdir(source);
	} catch (err) {
		// Still occupied by a collision recorded above, by an entry a writer landed
		// mid-merge, or held open (EBUSY): the directory stays behind.
		if (!isEnoent(err) && (stranded.length === strandedBefore || !isEnotempty(err))) {
			stranded.push(`${prefix || "."} (${isFsError(err) ? err.code : String(err)})`);
		}
	}
	return stranded;
}

/**
 * Relocate a session's artifacts directory for {@link SessionManager.moveTo}.
 *
 * The destination may already exist: a session moving back into a bucket it
 * lived in before finds its own `<id>/` there whenever a writer that captured
 * the old path — subagents adopt the parent's `ArtifactManager`, eval
 * subprocesses inherit `PI_ARTIFACTS_DIR` — kept writing after the move away.
 * Renaming onto an existing directory fails with a platform-specific code
 * (ENOTEMPTY, EEXIST, EPERM on Windows), so the fallback is decided by what is
 * there, not by the code: an existing directory is merged into.
 *
 * A name or artifact id taken on both sides is left at the source rather than
 * resolved: artifact ids resolve by `<id>.` prefix against one directory, so
 * overwriting the destination copy or parking a renamed duplicate beside it
 * would each destroy or misdirect a referenced artifact. The copy already at
 * the destination keeps the id; the session's own copy stays at the source,
 * retained on disk under the path the header's `previousSessionFiles` records
 * but not reachable through `artifact://` — two writers that shared one id
 * space cannot both be.
 */
async function relocateArtifactsDirectory(source: string, destination: string): Promise<"renamed" | "merged"> {
	try {
		await fs.promises.rename(source, destination);
		return "renamed";
	} catch (err) {
		// lstat on both sides: a symlink is never merged through, whichever end it
		// is on — the destination's target is not this session's directory, and a
		// symlinked source would have its target's contents moved out from under
		// it. Only a real directory on each side is a merge.
		const [occupant, origin] = await Promise.all([
			fs.promises.lstat(destination).catch((statErr: unknown) => {
				if (isEnoent(statErr)) return null;
				throw err;
			}),
			fs.promises.lstat(source),
		]);
		if (occupant === null && origin.isDirectory() && isFsError(err) && err.code === "EXDEV") {
			await fs.promises.mkdir(destination);
		} else if (occupant === null || !occupant.isDirectory() || !origin.isDirectory()) {
			throw err;
		}
	}
	const stranded = await mergeDirectoryInto(source, destination);
	if (stranded.length > 0) {
		logger.warn("Merged session artifacts into an existing directory; some entries left at source", {
			source,
			destination,
			stranded,
		});
	} else {
		logger.info("Merged session artifacts into an existing directory", { source, destination });
	}
	return "merged";
}

/**
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. A breadcrumb that points at such a child — a
 * pre-fix poisoned crumb left by a subagent that opened in the parent's TTY, or
 * any nested artifact — must resolve back up to the top-level session so
 * `--continue` resumes the real conversation instead of a subagent transcript.
 */
function resolveBreadcrumbToInteractiveRoot(sessionFile: string, storage: SessionStorage): string {
	let current = path.resolve(sessionFile);
	// Walk up while the containing dir is itself a session's artifacts dir
	// (`<dir>.jsonl` is held by the storage). Capped to defend against
	// pathological layouts.
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = `${path.dirname(current)}.jsonl`;
		if (!storage.existsSync(parentSessionFile)) return current;
		current = parentSessionFile;
	}
	return current;
}

function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
		subagentCost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "model_usage") return entry.usage;
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

/** Complete incomplete assistant usage in loaded history; returns how many messages were repaired. */
function normalizeLoadedUsage(entries: SessionEntry[]): number {
	let repaired = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant" && normalizeAssistantUsage(entry.message)) {
			repaired++;
		}
	}
	return repaired;
}

/** Report the assistant messages a load completed the usage of. */
function warnRepairedUsage(count: number): void {
	if (count > 0) logger.warn("Loaded assistant messages with incomplete usage", { count });
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

/**
 * Zero the monetary attribution on one usage record in place, leaving token
 * counts untouched. Cost, credit meters, and premium-request counts describe
 * billing; forks that must not inherit spend (see {@link SessionManager.forkFrom}
 * `resetInheritedCost`) drop them while keeping the tokens compaction relies on.
 */
function resetUsageCost(usage: Usage | undefined): void {
	if (!usage) return;
	usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	usage.credits = undefined;
	usage.premiumRequests = undefined;
}

/** Clear child billing kept in task results without discarding their token counts. */
function resetTaskResultBilling(details: unknown): void {
	if (!isTaskToolDetails(details)) return;
	resetUsageCost(taskUsageFrom(details));
	for (const result of details.results) {
		if (result === null || typeof result !== "object") continue;
		resetUsageCost(taskUsageFrom(result));
		resetNestedTaskBilling(result.extractedToolData);
	}
	const progress = details.progress;
	if (Array.isArray(progress)) {
		for (const item of progress) {
			if (item === null || typeof item !== "object") continue;
			if (typeof item.cost === "number") item.cost = 0;
			resetTaskResultBilling(item.inflightTaskDetails);
			resetNestedTaskBilling(item.extractedToolData);
		}
	}
}

/** Recurse only through task snapshots extracted from the task subprocess tool. */
function resetNestedTaskBilling(extractedToolData: Record<string, unknown[]> | undefined): void {
	const tasks = extractedToolData?.task;
	if (!Array.isArray(tasks)) return;
	for (const task of tasks) resetTaskResultBilling(task);
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

/** Whether a record read back from a session file is shaped like a session entry (not a header). */
function isAppendedEntry(record: unknown): record is SessionEntry {
	return (
		typeof record === "object" &&
		record !== null &&
		"type" in record &&
		typeof record.type === "string" &&
		record.type !== "session" &&
		"id" in record &&
		typeof record.id === "string"
	);
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	// Startup-recorded selector state that does not survive as user intent
	// once the draft is cleared. `mode_change` covers the `plan.defaultOnStartup`
	// path (interactive-mode.ts enters plan mode before draft restoration) and
	// `/plan` toggles that leave the session otherwise empty; entries carrying
	// real conversation state — messages, compactions, branch summaries,
	// custom/custom_message, session_init, labels, title/tool selection — never
	// reach this branch and always keep the file resumable.
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "credential_pin":
			return true;
		default:
			return false;
	}
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * The most recent model role on `branch`, or undefined when no model change
 * was recorded. `skipEphemeral` passes over temporary switches (retry fallback
 * hops, prewalk, context promotion), returning the role last assigned.
 */
export function lastModelChangeRole(
	branch: readonly SessionEntry[],
	options?: { skipEphemeral?: boolean },
): string | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "model_change") continue;
		const role = entry.role ?? "default";
		if (options?.skipEphemeral && (role === EPHEMERAL_MODEL_CHANGE_ROLE || role === PREWALK_MODEL_CHANGE_ROLE)) {
			continue;
		}
		return role;
	}
	return undefined;
}

/**
 * The newest of `entries` that {@link movesConversation}, when `branch` ends at it: where the
 * conversation stands. `undefined` when there is none, or the branch sits on an older entry or another branch.
 */
export function conversationTip(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
): SessionEntry | undefined {
	const branchTip = branch.findLast(movesConversation);
	return branchTip && branchTip === entries.findLast(movesConversation) ? branchTip : undefined;
}

/**
 * The id of the newest entry of `path` that is not a label, `undefined` when there is none. A copy of the path
 * ({@link SessionManager.createBranchedSession}) re-creates every label under a new id, so a record or event that
 * names where a branch stands for a copy to find names this entry.
 */
export function newestCopiedEntryId(path: readonly SessionEntry[]): string | undefined {
	return path.findLast(entry => entry.type !== "label")?.id;
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * parent→children adjacency, the resolved label map, the active leaf, and the
 * running usage totals. Kept in lockstep with the manager's `#entries` so reads
 * stay O(1)/O(children) instead of rescanning the whole journal. Also backs
 * the main thread's read-only view of a worker-homed session's entries.
 */
export class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	/** Children by parent: a lone child (most entries have one) is stored without an array. */
	#children = new Map<string | null, SessionEntry | SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();
	// Branch memo: getBranch() walks leaf-to-root per call (array + Set +
	// reverse) on per-frame/per-turn paths. The branch only changes on
	// insert/rebuild/setLeaf, so cache the array keyed on (leaf, generation).
	// An insert that extends the current leaf appends to the memo in place
	// (O(1)) instead of discarding it. `branchView()` hands the memo out
	// read-only and live: it grows when such an insert lands, while a leaf
	// change or rebuild starts a fresh array (the old one is never mutated).
	#generation = 0;
	#branchCache: { leaf: string | null | undefined; generation: number; branch: SessionEntry[] } | undefined;

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
		this.#generation++;
		this.#branchCache = undefined;
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
		this.settleLeaf(entries);
	}

	/**
	 * Finish inserting `entries`, all of them, one by one: a captured late-usage
	 * leaf can dangle after its target was rolled back or rewritten away.
	 */
	settleLeaf(entries: readonly SessionEntry[]): void {
		if (this.#leaf !== null && !this.#entriesById.has(this.#leaf)) this.setLeaf(lastSelfSelectedLeafId(entries));
	}

	insert(entry: SessionEntry): void {
		const previousLeaf = this.#leaf;
		const isNew = !this.#entriesById.has(entry.id);
		this.#entriesById.set(entry.id, entry);
		// Late usage is physically last but replays to the active leaf captured at append time.
		const nextLeaf = sessionEntryLeafId(entry);
		this.#leaf = nextLeaf;
		this.#generation++;
		const cache = this.#branchCache;
		if (
			isNew &&
			nextLeaf === entry.id &&
			cache !== undefined &&
			cache.generation === this.#generation - 1 &&
			cache.leaf === previousLeaf &&
			entry.parentId === previousLeaf &&
			entry.parentId !== null
		) {
			cache.branch.push(entry);
			cache.leaf = entry.id;
			cache.generation = this.#generation;
		} else {
			this.#branchCache = undefined;
		}

		const bucket = this.#children.get(entry.parentId);
		if (bucket === undefined) this.#children.set(entry.parentId, entry);
		else if (Array.isArray(bucket)) bucket.push(entry);
		else this.#children.set(entry.parentId, [bucket, entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		const usage = entryUsage(entry);
		addUsage(this.#usage, usage);
		// Completed `task` results carry the child's spend; tracked apart so the
		// status line can split the session's own cost from its subagents'.
		if (usage && entry.type === "message" && entry.message.role === "toolResult") {
			this.#usage.subagentCost += usage.cost.total;
		}
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		if (this.#leaf === id) return;
		this.#leaf = id;
		this.#generation++;
		this.#branchCache = undefined;
	}

	/**
	 * Stop extending the issued branch view in place: the next insert starts a
	 * fresh memo. For inserts whose leaf move is undone right after, which must
	 * not grow a view held by callers.
	 */
	detachBranchView(): void {
		this.#branchCache = undefined;
	}

	childrenOf(parentId: string): SessionEntry[] {
		const bucket = this.#children.get(parentId);
		if (bucket === undefined) return [];
		return Array.isArray(bucket) ? [...bucket] : [bucket];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		// The memoized default-leaf branch stays private — callers may
		// sort/reverse/splice the result (the return type is SessionEntry[]),
		// so hand out a copy. Explicit fromId walks (rare) bypass the cache.
		if (id === undefined || id === this.#leaf) return this.branchView().slice();
		return this.#walk(id);
	}

	/** The memoized active-leaf branch, without copying. Callers MUST NOT mutate it. */
	branchView(): readonly SessionEntry[] {
		const cache = this.#branchCache;
		if (cache !== undefined && cache.generation === this.#generation) return cache.branch;
		const branch = this.#walk(this.#leaf);
		this.#branchCache = { leaf: this.#leaf, generation: this.#generation, branch };
		return branch;
	}

	#walk(leaf: string | null): SessionEntry[] {
		const branch: SessionEntry[] = [];
		// Per-path visited set: a corrupt cyclic parentId chain must stop at
		// the FIRST repeated id (a bare depth cap of `size` still duplicates
		// entries when unrelated entries inflate the index — e.g. a self-cycle
		// plus one unrelated entry yields [entry, entry]).
		const seen = new Set<string>();
		let cursor = leaf ? this.#entriesById.get(leaf) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		return branch;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

/**
 * The outcome of {@link SessionManager.appendCustomEntriesToFile}: "appended", "no-records" (the
 * session holds none of the entries the caller named), or "refused" (another live process owns the
 * session, or the path now holds another session).
 */
export type CustomEntriesAppend = "appended" | "no-records" | "refused";

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getRecordedCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "ensureOnDisk"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getUsageStatistics"
	| "putBlob"
	| "putBlobSync"
>;

interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	sessionFile: string | undefined;
	expectedDiskSize: number | null;
	titleUpdatedAt: string;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	/** Entries and bytes the session file durably held, when that was known exactly. */
	durable: { count: number; size: number } | undefined;
	draftOnlySessionCleanupArmed: boolean;
	fallbackRuntimeOnly: boolean;
	/** Stashed sibling family candidate; moveTo drops it, so a rollback must restore it. */
	taskSiblingCandidate: string | undefined;
	header: SessionHeader;
	entries: SessionEntry[];
	oversizedLines: ReadonlySet<string>;
	/** The store the cold ones among `entries` were written to; shared with the manager that captured them. */
	coldStore: ColdEntryStore | undefined;
	/** The model the cut was last computed for, which the agent's context was built for. */
	coldCutModel: Model | undefined;
}

/** {@link SessionManager.coldStoreStats}: how much of the session lives in its cold entry store. */
export interface ColdStoreStats {
	/** Entries whose large values are read from the store on access. */
	coldEntries: number;
	/** Bytes of records in the store. */
	storeBytes: number;
	/** Records read back to serve a field read. */
	materializations: number;
	/** Cold entries made whole again. */
	hydrations: number;
	/**
	 * Whether the store keeps new records compressed in memory: no store file
	 * could be made under `os.tmpdir()`, or a write to it failed.
	 */
	storeInMemory: boolean;
	/** Bytes of the compressed blocks of records the store keeps in memory. */
	compressedBytes: number;
}

/** Options of {@link SessionManager.buildSessionContext}. */
export interface SessionContextBuildOptions extends BuildSessionContextOptions {
	/**
	 * The build only measures the context (`model`'s, for a fit check) and does
	 * not become the agent's context: it adopts no model and moves no cut, so
	 * every entry stays cold or whole as it is, and a cold one is read through
	 * its accessors.
	 */
	measureOnly?: boolean;
}

/** Short strings shared across a load's entries; longer ones are mostly unique. */
const INTERNED_STRING_MAX_UNITS = 64;
/** Runtimes are shared up to this JSON length: a source checkout's, with commit and branch, runs past 64. */
const INTERNED_RUNTIME_MAX_UNITS = 256;
/** Distinct values one load shares at most, so unique values cannot grow the tables without bound. */
const INTERNED_VALUES_MAX = 16_384;

/**
 * Shares equal values among the entries one load parses, which the parser
 * gives each its own copy of: short strings of the entry and of its message
 * (a string's identity is not observable), each `parentId` with its parent's
 * `id`, and the `runtime` identity, the same for every entry one build wrote,
 * which is frozen once shared. Memory per entry is what a long session's
 * older entries keep in memory, so the copies add up.
 */
class LoadedValueInterner {
	readonly #strings = new Map<string, string>();
	readonly #runtimes = new Map<string, object>();

	/** Share `entry`'s values with the entries already interned; `parent` is its parent entry, if loaded. */
	intern(entry: SessionEntry, parent: SessionEntry | undefined): void {
		const holder = entry as unknown as Record<string, unknown>;
		this.#internStrings(holder);
		if (parent && entry.parentId === parent.id) holder.parentId = parent.id;
		const runtime = holder.runtime;
		if (typeof runtime === "object" && runtime !== null) holder.runtime = this.#internRuntime(runtime);
		const message = entry.type === "message" ? holder.message : undefined;
		if (typeof message === "object" && message !== null && !Array.isArray(message)) {
			this.#internStrings(message as Record<string, unknown>);
		}
	}

	#internStrings(holder: Record<string, unknown>): void {
		for (const key of Object.keys(holder)) {
			if (key === "id" || key === "parentId" || key === "timestamp") continue;
			const value = holder[key];
			if (typeof value !== "string" || value.length > INTERNED_STRING_MAX_UNITS) continue;
			const shared = this.#strings.get(value);
			if (shared !== undefined) holder[key] = shared;
			else if (this.#strings.size < INTERNED_VALUES_MAX) this.#strings.set(value, value);
		}
	}

	#internRuntime(runtime: object): object {
		const key = internedRuntimeKey(runtime);
		if (key === undefined) return runtime;
		const shared = this.#runtimes.get(key);
		if (shared) return shared;
		if (this.#runtimes.size >= INTERNED_VALUES_MAX) return runtime;
		this.#runtimes.set(key, Object.freeze(runtime));
		return runtime;
	}
}

/**
 * The JSON text of `runtime` as the key the loaded entries share it under, or
 * `undefined` when it is longer than {@link INTERNED_RUNTIME_MAX_UNITS} or
 * holds a blob reference, and so is shared with nothing: the load resolves a
 * reference in place after the stream, which a frozen runtime would refuse.
 * {@link jsonTextMayFit} rejects a large runtime without serializing it, so
 * an entry carrying one nested deeper than `JSON.stringify` recurses (a
 * transcript line can nest 400,000 levels) is read without the `RangeError`
 * serializing it raises, and one it accepts serializes.
 */
function internedRuntimeKey(runtime: object): string | undefined {
	if (!jsonTextMayFit(runtime, INTERNED_RUNTIME_MAX_UNITS, isBlobRef)) return undefined;
	const key = stringifyJson(runtime);
	return key !== undefined && key.length <= INTERNED_RUNTIME_MAX_UNITS ? key : undefined;
}

/** A session file streamed into memory, its older entries cold; see `SessionManager.#loadTranscript`. */
interface LoadedTranscript extends SessionFileVisit {
	/** `undefined` when the file holds no entries (or is missing). */
	header: SessionHeader | undefined;
	entries: SessionEntry[];
	index: SessionEntryIndex;
	coldStore: ColdEntryStore | undefined;
	/** Whether a migration changed the entries, so the file needs a rewrite. */
	migrated: boolean;
	/** Whether stale replay metadata was stripped from an assistant entry. */
	sanitized: boolean;
	/** Assistant messages whose incomplete usage was completed. */
	repairedUsage: number;
	/** Ids of the entries whose line, as read, holds {@link TRANSCRIPT_READ_CAP} bytes or more. */
	oversizedLines: Set<string>;
}

/** How {@link SessionManager.forkFrom} turns each source entry into one of the fork's. */
interface ForkEntryOptions {
	resetInheritedCost?: boolean;
	seance?: boolean;
}

/** Where `SessionManager.#loadTranscript` reads a transcript from and what it does to each entry. */
interface TranscriptLoadOptions {
	throwIfMissing?: boolean;
	fork?: ForkEntryOptions;
	/** The transcript already read whole (a small file `probeSessionFile` loaded): visited instead of reading it again. */
	preloaded?: SessionLoadResult;
}

interface DiskQueueOptions {
	ignoreEpoch?: boolean;
	epoch?: number;
}

/**
 * What a fenced atomic rewrite did. `published`: it published the transcript.
 * `skipped`: it stopped before publishing (a released manager, a pending drop,
 * a move) or the disk epoch moved under it, so the file is not marked current
 * and a later write publishes the transcript; a body that landed before the
 * epoch moved is still recorded as durable. `handedOver`: it handed the
 * store's refusal of it to the queued-conflict recovery, which publishes it.
 */
type FencedRewriteOutcome = "published" | "skipped" | "handedOver";

/** A {@link SessionManager.dropSession} of the current session file whose delete has not settled. */
interface PendingDrop {
	sessionFile: string;
	/** A full rewrite was skipped while the delete ran; a failed delete runs it. */
	deferredRewrite: boolean;
	/** A title-slot write was skipped while the delete ran; a failed delete writes the current title. */
	titleHeld: boolean;
	settled: PromiseWithResolvers<void>;
}

interface AtomicEntryBatch {
	collecting: boolean;
	entryIds: Set<string>;
	deferredNotifications: SessionEntry[];
	preBatchLeafId: string | null;
	externalLeafChanged: boolean;
	externalLeafId: string | null;
}

/**
 * The state a full-file body was serialized from, cheap to compare against
 * the live state. Entries change only by append, array replacement (which
 * bumps the entries generation), or an in-place update announced through
 * `rewriteEntries()` or `patchEntries()` (which bump the revision); the title
 * slot and header are small and compared by value.
 */
interface SessionBodyStamp {
	generation: number;
	entryCount: number;
	revision: number;
	/** Serialized title slot and header lines. */
	prefix: string;
}

/**
 * What the session file is proven to hold, recorded only after a load or a
 * write succeeded: records whose ids and parent links are the first
 * `confirmed` entries in order, `confirmedSize` bytes long. Their content
 * may be older than memory's. `issued` and `issuedSize` also count appends a
 * deferring backend accepted but has not confirmed yet; `confirmedAhead`
 * holds those that confirmed before an earlier one, keyed by their start. It
 * describes the live journal only while `generation` is the manager's
 * entries generation, which every replacement of the entry array bumps; it
 * never holds the array, so a replaced transcript is collectable.
 */
interface DurableFrontier {
	generation: number;
	confirmed: number;
	confirmedSize: number;
	issued: number;
	issuedSize: number;
	readonly confirmedAhead: Map<number, { end: number; bytes: number }>;
}

/** A frontier proving the first `count` entries of `generation` occupy exactly `size` bytes, with nothing pending. */
function durableFrontier(generation: number, count: number, size: number): DurableFrontier {
	return {
		generation,
		confirmed: count,
		confirmedSize: size,
		issued: count,
		issuedSize: size,
		confirmedAhead: new Map(),
	};
}

/** Entries another writer added to the session file, and where they sit in it (see `#foreignEntryScan`). */
interface ForeignEntries {
	foreign: SessionEntry[];
	at: number;
	/** How many of this manager's entries, in order from the first, the file holds before them. */
	shared: number;
	extendsFrontier: boolean;
}

/**
 * One full-file serialization: title slot, header, and entry lines in file
 * order. `lines` regenerates on every iteration so file storage can write
 * bodies without allocating a transcript-sized array; `bytes` and
 * `oversizedLines` (the ids of the entries whose line holds
 * {@link TRANSCRIPT_READ_CAP} bytes or more, newline aside) describe the
 * last iteration.
 */
interface SessionFileBody {
	lines: Iterable<string>;
	readonly bytes: number;
	readonly oversizedLines: ReadonlySet<string>;
	stamp: SessionBodyStamp;
}

/**
 * Whether the JSON of `value` may hold `bytes` bytes or more. Over-estimates:
 * a string's UTF-16 unit counts 6 bytes (`\uXXXX`), any other scalar 24; stops
 * once the estimate reaches `bytes`.
 */
function jsonMayReach(value: unknown, bytes: number): boolean {
	let estimate = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const next = pending.pop();
		if (typeof next === "string") {
			estimate += 2 + 6 * next.length;
		} else if (Array.isArray(next)) {
			estimate += 2 + next.length;
			for (const item of next) pending.push(item);
		} else if (isRecord(next)) {
			estimate += 2;
			for (const key in next) {
				estimate += 4 + 6 * key.length;
				pending.push(next[key]);
			}
		} else {
			estimate += 24;
		}
		if (estimate >= bytes) return true;
	}
	return false;
}

/**
 * Whether `entry`, as read from its file before a migration, record or blob
 * changes it (so its JSON is its line), holds {@link TRANSCRIPT_READ_CAP}
 * bytes or more; only an entry whose JSON may reach that size is serialized
 * to measure it.
 */
function isOversizedEntry(entry: FileEntry): boolean {
	if (!jsonMayReach(entry, TRANSCRIPT_READ_CAP)) return false;
	const json = stringifyJson(entry);
	return json !== undefined && Buffer.byteLength(json, "utf8") >= TRANSCRIPT_READ_CAP;
}

/**
 * Compare the UTF-8 encoding of a generated JSONL body to the durable file's raw
 * bytes without materializing either transcript. Nothing is decoded, so no decoder
 * normalization (such as dropping a leading byte-order mark) can make different
 * bytes match.
 */
async function fileMatchesLines(filePath: string, lines: Iterable<string>): Promise<boolean> {
	const iterator = lines[Symbol.iterator]();
	const expected = Buffer.allocUnsafe(ACK_COMPARE_WINDOW_BYTES);
	let expectedLength = 0;
	let expectedOffset = 0;
	let line = "";
	let lineRead = 0;

	/** Encode the next window of the body into `expected`; false once the body is exhausted. */
	const encodeNextWindow = (): boolean => {
		while (lineRead === line.length) {
			const next = iterator.next();
			if (next.done) return false;
			line = next.value;
			lineRead = 0;
		}
		// `encodeInto` never splits a code point, and the window always fits one.
		const { read, written } = utf8Encoder.encodeInto(line.slice(lineRead), expected);
		lineRead += read;
		expectedLength = written;
		expectedOffset = 0;
		return true;
	};

	try {
		for await (const chunk of Bun.file(filePath).stream()) {
			let chunkOffset = 0;
			while (chunkOffset < chunk.byteLength) {
				if (expectedOffset === expectedLength && !encodeNextWindow()) return false;
				const sharedLength = Math.min(expectedLength - expectedOffset, chunk.byteLength - chunkOffset);
				const differs = expected.compare(
					chunk,
					chunkOffset,
					chunkOffset + sharedLength,
					expectedOffset,
					expectedOffset + sharedLength,
				);
				if (differs !== 0) return false;
				expectedOffset += sharedLength;
				chunkOffset += sharedLength;
			}
		}
	} catch {
		return false;
	}
	return expectedOffset === expectedLength && !encodeNextWindow();
}

/** A body's UTF-8 byte length and SHA-256, which {@link chunksMatchBody} compares stored chunks with. */
interface SessionBodyDigest {
	readonly bytes: number;
	readonly sha256: string;
}

/** {@link SessionBodyDigest} of `body`, hashed while holding one line of it at a time. */
function sessionBodyDigest(body: SessionFileBody): SessionBodyDigest {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const line of body.lines) hasher.update(line);
	// Iterating `lines` counted the body's bytes again.
	return { bytes: body.bytes, sha256: hasher.digest("hex") };
}

/**
 * Whether stored chunks are exactly the bytes `expected` describes, compared
 * by byte length and SHA-256 while holding one stored chunk at a time.
 */
async function chunksMatchBody(chunks: AsyncIterable<Uint8Array>, expected: SessionBodyDigest): Promise<boolean> {
	const stored = new Bun.CryptoHasher("sha256");
	let storedBytes = 0;
	for await (const chunk of chunks) {
		storedBytes += chunk.byteLength;
		if (storedBytes > expected.bytes) return false;
		stored.update(chunk);
	}
	return storedBytes === expected.bytes && stored.digest("hex") === expected.sha256;
}

/**
 * One read of the transcript stored at `filePath`, in the parts {@link transcriptByteChunks} yields, holding
 * one part at a time: its byte length and SHA-256, as {@link sessionBodyDigest} describes a body, and, with
 * `parseHeader`, the first entry the streamed parse finds in it, the header {@link parseSessionContent}
 * would find. A missing transcript throws ENOENT.
 */
async function readStoredTranscriptPass(
	filePath: string,
	storage: SessionStorage,
	parseHeader: boolean,
): Promise<{ size: number; sha256: string; first: FileEntry | undefined }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let size = 0;
	const add = (chunk: Uint8Array): void => {
		size += chunk.byteLength;
		hasher.update(chunk);
	};
	const chunks = transcriptByteChunks(filePath, storage);
	let first: FileEntry | undefined;
	if (parseHeader) {
		// The parse goes on to the end, so every part is hashed; it keeps no entry but the first.
		await visitEntriesFromFileStream(
			filePath,
			entry => {
				first ??= entry;
			},
			{ chunks, onChunk: add, throwIfMissing: true },
		);
	} else {
		for await (const chunk of chunks) add(chunk);
	}
	return { size, sha256: hasher.digest("hex"), first };
}

/** Bytes of one synchronous read of a stored transcript; see {@link transcriptByteChunksSync}. */
const SYNC_READ_WINDOW_BYTES = 1024 * 1024;

/**
 * The stored transcript at `filePath` as synchronous chunks of at most
 * {@link SYNC_READ_WINDOW_BYTES}: windows of the file itself for file storage,
 * whatever its other range readers do; windows through `readTextRangeSync` for
 * another storage that has it, read twice (see {@link checkedTextRangeWindows});
 * otherwise its whole `readTextSync` text as one chunk; `undefined` when the
 * storage reads nothing synchronously. A missing transcript throws ENOENT once
 * iterated.
 */
function transcriptByteChunksSync(filePath: string, storage: SessionStorage): Iterable<Uint8Array> | undefined {
	if (storage instanceof FileSessionStorage) return fileWindows(filePath);
	const readRange = storage.readTextRangeSync;
	if (readRange)
		return checkedTextRangeWindows(filePath, (start, end) => readRange.call(storage, filePath, start, end));
	const readText = storage.readTextSync;
	if (readText) return wholeText(() => readText.call(storage, filePath));
	return undefined;
}

/**
 * {@link textRangeWindows}, then the same windows read again and compared by
 * SHA-256 with what was yielded: a storage that reads by range holds nothing
 * open across windows, so another writer's full write between two of them
 * would hand back a mix of two bodies. A second read that differs throws
 * {@link SessionReadConflictError} for `filePath` once the windows ran out.
 */
function* checkedTextRangeWindows(
	filePath: string,
	readRange: (start: number, end: number) => string,
): Generator<Uint8Array> {
	const yielded = new Bun.CryptoHasher("sha256");
	for (const window of textRangeWindows(readRange)) {
		yielded.update(window);
		yield window;
	}
	const again = new Bun.CryptoHasher("sha256");
	for (const window of textRangeWindows(readRange)) again.update(window);
	if (again.digest("hex") !== yielded.digest("hex")) throw new SessionReadConflictError(filePath);
}

/**
 * Successive windows of a transcript `readRange` decodes. A window that ends
 * inside a multibyte character decodes its first bytes as U+FFFD, so trailing
 * U+FFFD characters are read again at the head of the next window.
 */
function* textRangeWindows(readRange: (start: number, end: number) => string): Generator<Uint8Array> {
	let position = 0;
	for (;;) {
		const text = readRange(position, position + SYNC_READ_WINDOW_BYTES);
		if (text.length === 0) return;
		let end = text.length;
		while (end > 0 && text.charCodeAt(end - 1) === 0xfffd) end--;
		const window = Buffer.from(end > 0 ? text.slice(0, end) : text, "utf8");
		position += window.byteLength;
		yield window;
	}
}

/** Successive windows of the file at `filePath`, each valid until the next is read. */
function* fileWindows(filePath: string): Generator<Uint8Array> {
	const fd = fs.openSync(filePath, "r");
	try {
		const window = Buffer.allocUnsafe(SYNC_READ_WINDOW_BYTES);
		let position = 0;
		for (;;) {
			const read = fs.readSync(fd, window, 0, window.length, position);
			if (read === 0) return;
			position += read;
			yield window.subarray(0, read);
		}
	} finally {
		fs.closeSync(fd);
	}
}

function* wholeText(readText: () => string): Generator<Uint8Array> {
	yield Buffer.from(readText(), "utf8");
}

/**
 * Whether `loaded` still describes the current session object without parsing
 * it again. Size, mtime, and inode are not authoritative (an in-place rewrite
 * can keep all three, and an indexed backend's stat reads only its local
 * index), so this compares a digest of the current content with the one taken
 * while parsing. A session that is gone throws ENOENT.
 */
async function sessionSnapshotIsCurrent(
	storage: SessionStorage,
	filePath: string,
	loaded: SessionLoadResult,
): Promise<boolean> {
	if (loaded.sourceDigest === undefined) return false;
	return (await sessionContentDigest(filePath, storage)) === loaded.sourceDigest;
}

/**
 * The storage may have published a write that rejected, and an authoritative
 * repair could not be proven durable. Callers must fail closed until recovery.
 */
export class SessionPersistenceIndeterminateError extends AggregateError {
	readonly operationError: Error;
	readonly recoveryErrors: readonly Error[];

	constructor(operationError: Error, recoveryErrors: readonly Error[]) {
		super(
			[operationError, ...recoveryErrors],
			`Session persistence is indeterminate after "${operationError.message}" and authoritative repair failed.`,
		);
		this.name = "SessionPersistenceIndeterminateError";
		this.operationError = operationError;
		this.recoveryErrors = [...recoveryErrors];
	}
}

/**
 * This session moved to a new file and keeps saving there. Not a failure:
 * nothing is latched. Delivered through {@link SessionManager.onPersistenceNotice}.
 */
export interface SessionPersistenceNotice {
	/**
	 * `"open-elsewhere"`: another live omp process wrote `from` first and still
	 * has it open, so this process saves its entries elsewhere instead of mixing
	 * them into that file. `"replaced"`: `from` changed on disk and no longer
	 * reads as this session's journal, so it is left untouched. `"contested"`:
	 * a writer without the ownership lease kept changing `from` through every
	 * read-back-and-retry pass, so this session stops racing it.
	 */
	reason: "open-elsewhere" | "replaced" | "contested";
	/** The session file this session was saving to. */
	from: string;
	/** The fresh sibling it saves to from now on: same directory, a new session id whose `parentSession` is the old one. */
	to: string;
}

/**
 * What {@link SessionManager.flush}, {@link SessionManager.flushSync} and {@link SessionManager.close} reject with
 * once an `OMP_SESSION_EXCLUSIVE=1` stop sealed a session whose storage does not hold every entry: the stop writes
 * nothing more, so those entries are never saved, and the process ends. {@link SessionManager.setSessionFile}
 * rejects with one after any stop: a stopped session opens no other.
 */
export class SessionExclusiveStopError extends Error {
	constructor(
		readonly sessionId: string,
		readonly reason: SessionPersistenceNotice["reason"],
		readonly why: string,
		consequence = "the entries its storage does not hold are not saved",
	) {
		super(
			`Session ${sessionId} stops (${reason}): ${why}. OMP_SESSION_EXCLUSIVE=1 keeps it from moving to another id, so ${consequence}.`,
		);
		this.name = "SessionExclusiveStopError";
	}
}

/**
 * Thrown by {@link SessionManager.forkFrom} when the fork source is missing.
 * The CLI maps this to a clean session-resolution failure at its own boundary
 * (this module must not import `main.ts`, where `SessionResolutionError` lives).
 */
export class ForkSourceNotFoundError extends Error {
	constructor(sourcePath: string) {
		super(`Session "${sourcePath}" not found.`);
		this.name = "ForkSourceNotFoundError";
	}
}

/**
 * What {@link SessionManager.createWithSessionId} did with a launcher-chosen id. Only `created`
 * wrote anything.
 * - `held`: a stored session already holds the id.
 * - `owned-elsewhere`: another live omp process owns the id.
 */
export type SessionIdCreation =
	| { status: "created"; manager: SessionManager }
	| { status: "held" }
	| { status: "owned-elsewhere" };

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: completed entries
 * (user/assistant/toolResult messages, tool_execution_start markers, custom
 * entries) are handed to the OS synchronously in-body on append and never
 * `fsync`'d. In-flight streaming text is intentionally not durable until
 * `message_end` persists the finished message.
 *
 * While an in-place atomic rewrite is publishing, a concurrent completed append
 * supersedes that publish with a synchronous full-body rewrite so the entry is
 * software-crash durable before the append returns; the abandoned atomic's
 * `commitGuard` then refuses to clobber the fresher body.
 *
 * During {@link moveTo}, appends write a full body to the live relocation path
 * (source until rename, destination once the rename has landed) so a crash mid-
 * move still preserves completed entries without recreating a vacated source.
 * A trailing atomic rewrite still rewrites the header cwd after the path is
 * repointed.
 */
export class SessionManager {
	#cwd: string;
	/** Additional workspace directories beyond cwd (multi-root). Normalized absolute, deduped, excludes cwd. */
	#additionalDirectories: string[] = [];
	#fallbackRuntimeOnly = false;
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;

	#sessionId = "";
	/**
	 * Every session this manager went on from, by session id: the file it last left that session at,
	 * and the order mark of that leave. See {@link getLeftSessions}.
	 */
	readonly #leftSessions = new Map<string, { file: string; mark: number }>();
	/** The order mark of the latest leave recorded in {@link #leftSessions}; 0 before any. */
	#leftSessionsMark = 0;
	/**
	 * Parent-derived sibling family candidate stashed by the Task executor once
	 * the child session exists. Session-scoped and non-persisted: the header
	 * never sees it, and forks, moves, and new-session resets start without it.
	 */
	#taskSiblingCandidate: string | undefined;
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#titleRevision = 0;
	/** Bumped by in-place entry updates, which a {@link SessionBodyStamp} cannot otherwise see. */
	#bodyRevision = 0;
	/** Bumped each time the entries are read in whole ({@link loadRevision}). */
	#loadRevision = 0;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entriesArray: SessionEntry[] = [];
	/**
	 * Bumped by every replacement of the entry array. The durable frontier and
	 * a refused switch record the generation they describe instead of holding
	 * the array, so a replacement voids them and the old transcript stays
	 * collectable.
	 */
	#entriesGeneration = 0;
	get #entries(): SessionEntry[] {
		return this.#entriesArray;
	}
	set #entries(entries: SessionEntry[]) {
		this.#entriesArray = entries;
		this.#entriesGeneration++;
	}
	#index = new SessionEntryIndex();
	/**
	 * Whether entries before the context cut move to a {@link ColdEntryStore}.
	 * Every persisted manager does; an in-memory one, or one opened with
	 * `coldStore: false`, holds every entry.
	 */
	readonly #coldStoreEnabled: boolean;
	/** The store new cold entries go to; created when the first entry turns cold. */
	#coldStore: ColdEntryStore | undefined;
	/** The model the cut was last computed for (see `coldCutPathIndex`); unset until a context build names one. */
	#coldCutModel: Model | undefined;
	/**
	 * The leaf, the entries, the newest compaction or the model changed since
	 * the cut was last applied: set by {@link #setLeaf} when the leaf moves,
	 * {@link #reindexEntries}, {@link #recordEntry} for a compaction,
	 * {@link #staleColdBoundary} when it adopts a model, and
	 * {@link #resetColdCut} when asked; cleared by {@link buildSessionContext}
	 * once the build that applies the cut made its entries whole and returned.
	 */
	#coldCutStale = false;

	/** A full body reached the session file and nothing has replaced it since; crosses the lazy file-creation gate. */
	#fileIsCurrent = false;
	/**
	 * Content or header changes no full rewrite has published yet (load
	 * migration or sanitize, `rewriteEntries()`, header edits, a new file).
	 * Appends never wait for it: the next full rewrite carries it.
	 */
	#rewriteRequired = false;
	/** What the session file durably holds; appends extend it and anything else republishes. */
	#durable: DurableFrontier | undefined;
	/** Outstanding confirmations of appends a deferring backend accepted. */
	readonly #pendingAppendConfirmations = new Set<Promise<void>>();
	/**
	 * The unsaved entries a {@link newSession} refused to abandon, as the
	 * entries generation and length then; a second call for the same entries
	 * switches anyway.
	 */
	#refusedSessionSwitch: { generation: number; count: number } | undefined;
	/**
	 * Set while {@link dropSession} deletes the current session file. Until it
	 * settles nothing writes that path: appends stay in memory past the
	 * durable frontier, a rewrite only records that it is owed, and a title
	 * change only records that its title slot is owed.
	 */
	#pendingDrop: PendingDrop | undefined;
	/**
	 * Settles when the authoritative repair in flight ends. The repair runs
	 * off the disk queue, so {@link dropSession} waits for it here.
	 */
	#authoritativeRepair: Promise<void> | undefined;
	/** Malformed records the loader skipped for the current session file; reported by `/dump anon`. */
	#loadedMalformedRecords = 0;
	/** Byte length this manager last loaded or durably wrote; `null` means the path was absent. */
	#expectedDiskSize: number | null = null;
	/**
	 * Ids of the entries whose line, as this manager last loaded or wrote it,
	 * holds {@link TRANSCRIPT_READ_CAP} bytes or more, newline aside: a collab
	 * guest cannot fetch such a line, so {@link patchEntries} rewrites the file
	 * rather than leave it whole under a record.
	 */
	#oversizedLines = new Set<string>();
	/**
	 * Generation of the latest deferred publish queued on a `defersSyncPublish`
	 * backend. A deferred-rewrite confirmation older than the latest queued
	 * publish is stale (the backend no longer holds its body) and must record
	 * nothing (rvEW).
	 */
	#deferredPublishGen = 0;
	/**
	 * Path of the latest deferred publish while the backend has neither
	 * confirmed nor rejected it. A synchronous rewrite of that path queues
	 * nothing meanwhile: it could only carry the last confirmed size, which
	 * the store's queue-time check rejects against this manager's own
	 * queued body. The publish's confirmation re-issues the transcript
	 * instead, carrying the size the backend confirmed; an atomic rewrite
	 * waits for that confirmation before taking its size.
	 */
	#unconfirmedPublishPath: string | undefined;
	/**
	 * A deferred publish's confirmation arrived after {@link seal} and found
	 * the transcript had outgrown the body it confirmed. The seal refuses the
	 * re-issue that confirmation owes, so {@link close} publishes the
	 * transcript once its drain settles.
	 */
	#closeOwesPublish = false;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;
	/**
	 * Armed only when this manager observed a draft sidecar lifecycle that
	 * materialized an otherwise metadata-only session file. Explicit
	 * ensureOnDisk() callers (ACP session/new, handoff) must survive close().
	 */
	#draftOnlySessionCleanupArmed = false;

	/**
	 * Collab replication tap: invoked for every appended entry with the
	 * in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	/** The single open append writer; the manager only ever writes one file at a time. */
	#writer: SessionStorageWriter | undefined;
	/**
	 * What the store held when this session's close was refused; set only while the transcript is held
	 * (see {@link #hold}).
	 */
	#heldBasis: StoredTranscriptState | undefined;
	/** The send the store queue started for this session, while it runs (see {@link #sendOnce}). */
	#storeSend: Promise<void> | undefined;
	/** Sealed by {@link releaseRetainedEntries}: every later append/title/rewrite is a dropped no-op. */
	#released = false;
	/** Set by {@link releaseRetainedEntries}: `#entries` was cleared, so `#serializeBody()` is no longer authoritative. */
	#entriesReleased = false;
	/** Set by {@link seal} with `keepEntries`: the end of a hold does not release the entries. */
	#keepsEntries = false;
	/**
	 * Set by a {@link close} that failed and left the store of older entry bodies open, for the transcript
	 * it holds (see {@link #hold}) or for an owner that keeps the entries (see {@link seal}): releasing the
	 * entries closes that store, as the close would have (see {@link releaseRetainedEntries}).
	 */
	#closeLeftColdStore = false;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** FIFO reservation for atomic batches and authoritative recovery. */
	#atomicPersistenceTail: Promise<void> = Promise.resolve();
	/** Observer notifications withheld until their entries are proven durable. */
	#pendingDurabilityNotifications: SessionEntry[] = [];
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/**
	 * Epoch of the in-flight atomic rewrite, or `null` when no rewrite is running.
	 * The fence in {@link #appendToSessionFile} only applies while this matches
	 * `#diskEpoch`: once a synchronous rewrite (`flushSync` → `#rewriteSynchronously`)
	 * bumps the epoch, the pending atomic publish is guaranteed to abandon via
	 * its `commitGuard`, and appends can safely take the hot path against the
	 * freshly-published file.
	 */
	#atomicRewriteFenceEpoch: number | null = null;
	/** Set by synchronous appends that land while an atomic replacement is active. */
	#atomicRewriteDirty = false;
	/**
	 * Active {@link moveTo} relocation. Concurrent completed appends write a
	 * full body to the live path: source while it still exists, destination
	 * once rename has landed (source gone). Never recreates a vacated source.
	 * `null` outside an active relocation.
	 */
	#sessionFileRelocating: { source: string; dest: string; copying?: boolean } | null = null;
	/** Atomic entry batch currently staged for a full-file commit. */
	#atomicEntryBatch: AtomicEntryBatch | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManagerApi | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	/** `secrets.maskSessionStore` and agent dir of the session this manager writes for ({@link setStoreMasking}). */
	#storeMasking: StoreMaskingBinding | undefined;
	/**
	 * The last breadcrumb this manager wrote marked a lazy fresh session whose
	 * JSONL is not yet on disk. Cleared (and the crumb re-stamped non-fresh) once
	 * the session materializes, so a materialized-then-deleted session still falls
	 * back to the most-recent session instead of being treated as a fresh crumb.
	 */
	#breadcrumbFresh = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	#persistenceErrorCallbacks = new Set<(error: Error) => void>();
	#persistenceNoticeCallbacks = new Set<(notice: SessionPersistenceNotice) => void>();
	/**
	 * Observers of the journal this manager writes moving to another path or
	 * another session. Whoever published this manager's file keeps its copy
	 * current from here: the agent registry carries it as the running agent's
	 * `sessionFile`, and a roster scan reads that to tell which session runs a
	 * transcript, so a stale copy hides the agent under one name and answers
	 * for it under another.
	 */
	#sessionFileChangedCallbacks = new Set<() => void>();
	/** Every notice raised so far, replayed to each later subscriber. */
	#persistenceNotices: SessionPersistenceNotice[] = [];
	/**
	 * This process's ownership claim on the session it last wrote or opened
	 * for writing, keyed by session id so every path to the journal meets it.
	 * `release` is unset while another live process holds the session, after
	 * {@link close} gave the claim up, and once the claim was lost.
	 */
	#sessionClaim: { sessionId: string; release: (() => void) | undefined } | undefined;
	/**
	 * Set once an `OMP_SESSION_EXCLUSIVE=1` session began to stop (see {@link #stopExclusive}): what a flush or close
	 * that finds an entry unsaved rejects with, once `announced` (the stop line is on stderr), and whether the seal
	 * dropped an entry appended after the stop.
	 */
	#exclusiveStop: { error: SessionExclusiveStopError; announced: Promise<void>; dropped: boolean } | undefined;
	/**
	 * The entries the last load read from storage, by file, entries generation and count: storage holds each of them,
	 * also when the load leaves no durable frontier (a migrated file, a torn last record, an unknown size), until the
	 * array is replaced, the session moves to another file, or an entry is appended.
	 */
	#loadedEntries: { file: string; generation: number; count: number } | undefined;
	/** How many times {@link close} has begun: a file-lease wait that began before a close ends without the claim. */
	#closes = 0;
	/** A subagent transcript's follow of its parent session to the sibling it moved to (see {@link #followParentMove}). */
	#parentMoveFollow: Promise<void> | undefined;
	/** The transcript {@link #parentMoveFollow} was started for (see {@link #parentMoveFollowOfThisFile}). */
	#parentMoveFollowFile: string | undefined;
	/** The {@link #switchGeneration} {@link #parentMoveFollow} was started in. */
	#parentMoveFollowGeneration: number | undefined;
	/**
	 * Bumped where a switch ({@link setSessionFile}) sets the new file. A parent follow started before carries the old
	 * value and moves nothing (see {@link #switchedSince}): after a switch away and back to the same path, its check of
	 * the path alone would still pass.
	 */
	#switchGeneration = 0;
	/**
	 * The session the switch in progress leaves, from its read of that session until the load sets the new file.
	 * Meanwhile `#sessionFile` and `#sessionId` still name the session left, and a write lands there. A move off it in
	 * that time (a write's, a lease loss's, a follow's or a queued-conflict recovery's) sets `left` to the sibling it
	 * makes, so the switch records that sibling as the session it leaves.
	 */
	#activeSwitch: { left?: { id: string; file: string } } | undefined;
	/**
	 * The subagent transcript a switch adopted under a refused claim, while its parent follow has not yet forked or
	 * moved it: it was never this manager's, so a switch away from it before then records it as left no more than the
	 * fork does.
	 */
	#heldAdoptionFile: string | undefined;
	/** A recovery of a write conflict a deferred-publish store reported for a queued write (see {@link #recoverQueuedConflict}). */
	#queuedConflictRecovery: Promise<void> | undefined;
	/** Queued-write conflicts recovered since the last confirmed publish; past the bound the session moves off as contested. */
	#queuedConflictRecoveries = 0;
	/** The files this manager moved off, so a conflict a write to one reports retries at the sibling it went on in. */
	readonly #movedOffFrom = new Set<string>();
	/** The id the session had in each notice's `from`, for a move to a sibling under a new id ({@link movedOffSessionId}). */
	readonly #movedOffSessionIds = new WeakMap<SessionPersistenceNotice, string>();
	/** Write conflicts a recovery took over: the store's drain reports them again, and they are no failure. */
	readonly #takenOverConflicts = new WeakSet<Error>();
	/**
	 * Set once a running agent loop took this manager over
	 * ({@link claimForWriting}). Every session it switches to afterwards is
	 * claimed as that loop writes it, rather than waiting for the first append.
	 */
	#writerOwned = false;
	/**
	 * Journals this manager handed to a clone of itself
	 * ({@link cloneCurrentSession}), by session id, while that clone still
	 * writes them. Read by {@link #reclaimsJournalHandedToClone} so coming back
	 * to such a session is not refused as a second writer. Weak, so a clone
	 * nobody holds any more cannot keep its entry alive.
	 */
	#journalsHandedToClones = new Map<string, { sessionFile: string; clone: WeakRef<SessionManager> }>();
	/**
	 * The background artifact copy a move or branch to `sessionFile` started (see
	 * {@link #moveOffSessionFile}, {@link createBranchedSession}). Never rejects.
	 */
	#pendingArtifactCopy: { sessionFile: string; done: Promise<void> } | undefined;

	private constructor(
		cwd: string,
		sessionDir: string,
		persist: boolean,
		storage: SessionStorage,
		coldStore: boolean = persist,
	) {
		this.#cwd = cwd;
		// Absolute, so session files (and `PI_SESSION_FILE` in bash and eval) stay
		// valid after a command changes directory: `--session-dir` may be relative.
		this.#sessionDir = sessionDir ? path.resolve(sessionDir) : sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		// A storage that keeps blobs beside the local store (SQL) gets each one a session
		// persists and cannot draw again, landed before the transcript write that names it.
		this.#blobs = new BlobStore(getBlobsDir(), storage.blobTier);
		this.#coldStoreEnabled = coldStore;

		if (persist && sessionDir) {
			try {
				this.#storage.ensureDirSync(this.#sessionDir);
			} catch (error) {
				// A store that refuses the directory (full, read-only, denied)
				// refuses the session's writes too. Every store write makes its
				// directory, so the first one does, and its refusal is latched,
				// reported and retried as any refused write is: the session
				// starts. Any other error stops the start, as before.
				if (!isSessionStoreWriteRefusal(error)) throw error;
			}
		}
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
		this.#breadcrumbFresh = fresh;
		if (this.#suppressBreadcrumb) return;
		writeTerminalBreadcrumb(cwd, sessionFile, fresh, {
			remoteStorage: !(this.#storage instanceof FileSessionStorage),
		});
	}

	/**
	 * Re-stamp a fresh-session breadcrumb as non-fresh once the session has
	 * materialized on disk. A no-op unless the current breadcrumb is still fresh.
	 */
	#materializeBreadcrumb(): void {
		if (!this.#breadcrumbFresh || !this.#sessionFile) return;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, false);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
		if (!this.#heldBasis) this.#leaveStoreQueue();
	}

	/**
	 * Deliver one failure or notice to a single observer. Observer failures are
	 * swallowed: a host surface that throws must not corrupt session teardown.
	 */
	#invokePersistenceObserver<T>(observer: (value: T) => void, value: T): void {
		try {
			observer(value);
		} catch (callbackError) {
			logger.warn("Session persistence observer failed", {
				error: toError(callbackError).message,
			});
		}
	}

	#notifyPersistenceErrorObservers(error: Error): void {
		for (const observer of this.#persistenceErrorCallbacks) this.#invokePersistenceObserver(observer, error);
	}

	/**
	 * Latch `errorLike` as the failure flush()/close() report: the latest one,
	 * so a failure that has since cleared never stands in for the one storage
	 * is giving now. An indeterminate failure stays latched until
	 * {@link recoverPersistenceFromCurrentState} settles it. Observers hear
	 * once per failure episode, so the agent is warned once.
	 */
	#noteDiskFailure(errorLike: unknown): Error {
		// A write the lease fence refused is no storage failure: the claim is lost, and the loss moves or stops the
		// session (see #onSessionClaimLost); a subagent transcript follows its parent. Once a main session is sealed
		// (a dispose's close), nothing moves or stops it any more, so the entries a write of its file carried are lost:
		// that refusal is the failure close() reports. A stopped session reports through its stop. A subagent
		// transcript (its path under its parent's stem) never takes that path, sealed or not: its claim is its parent's
		// lease, which it neither moves off nor stops.
		if (errorLike instanceof SessionLeaseLostError) {
			const file = this.#sessionFile;
			const root = file ? sessionLeaseRoot(file) : undefined;
			const subagent = !!file && !!root && path.resolve(file).startsWith(`${root.stem}${path.sep}`);
			if (
				this.#followParentMove() ||
				subagent ||
				!this.#released ||
				this.#exclusiveStop ||
				path.resolve(errorLike.path) !== file
			) {
				return errorLike;
			}
		}
		// A queued write's conflict a recovery took over is no failure either (see #recoverQueuedConflict).
		if (errorLike instanceof Error && this.#takenOverConflicts.has(errorLike)) return errorLike;
		const error = toError(errorLike);
		if (!(this.#diskFailure instanceof SessionPersistenceIndeterminateError)) this.#diskFailure = error;
		// Only an outage waits for the store to accept writes again. A
		// permission refusal, a conflict or any other failure of a live session
		// does not end when another session's write lands: it leaves the queue,
		// and its own next append retries, as before. A held transcript leaves
		// it in #sendHeld.
		if (isSessionStoreOutage(error)) this.#joinStoreQueue();
		else if (!this.#heldBasis) this.#leaveStoreQueue();
		// A line that failed to land leaves its blob refs unreferenced on disk,
		// so the next persist must re-check those blobs instead of trusting the memo.
		forgetExternalizedImages(this.#blobs);

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
			this.#notifyPersistenceErrorObservers(error);
		}

		return this.#diskFailure;
	}

	#notifyPersistenceNotice(notice: SessionPersistenceNotice): void {
		logger.warn("Session moved to a new file", { ...notice });
		this.#persistenceNotices.push(notice);
		for (const observer of this.#persistenceNoticeCallbacks) this.#invokePersistenceObserver(observer, notice);
	}

	/**
	 * Observe the journal this manager writes moving: a resume or a branch
	 * (`setSessionFile`), a new session, a `/move`, a restored state, and a
	 * write that found the file owned elsewhere and went to a sibling. The
	 * callback runs after the manager points at the new file, and only when
	 * the file really changed. Returns the unsubscribe.
	 */
	onSessionFileChanged(callback: () => void): () => void {
		this.#sessionFileChangedCallbacks.add(callback);
		return () => this.#sessionFileChangedCallbacks.delete(callback);
	}

	#notifySessionFileChanged(previousSessionFile: string | undefined): void {
		if (this.#sessionFile === previousSessionFile) return;
		for (const observer of this.#sessionFileChangedCallbacks) this.#invokePersistenceObserver(observer, undefined);
	}

	/**
	 * Hold this process's ownership claim on `#sessionId`, moving it off a
	 * previous session. Write paths claim, so the first process to write a
	 * session owns it and inspection (`omp share`, `--export`, `render`) never
	 * does; on a storage that can answer at once, opening a session for
	 * writing claims it first ({@link claimOpenedSession}). A failed claim is
	 * retried on the next write, so a writer takes over once the owner closed
	 * the session or exited.
	 *
	 * The claim is a writer's: a second manager on one journal — this process
	 * reopening a session it already runs — is refused here and moved to a
	 * sibling, the same way a second process is. The one exception is the
	 * journal this manager itself handed to a clone; see
	 * {@link #reclaimsJournalHandedToClone}.
	 */
	#claimSession(options?: { handover?: boolean }): void {
		const sessionId = this.#sessionId;
		const sessionFile = this.#sessionFile;
		if (!this.#persist || !sessionFile || !this.#storage.claimSession) return;
		const current = this.#sessionClaim;
		if (current?.sessionId === sessionId && current.release) return;
		if (current && current.sessionId !== sessionId) current.release?.();
		const handover = options?.handover === true || this.#reclaimsJournalHandedToClone(sessionId, sessionFile);
		// The storage also checks that the path still holds this session: if
		// another session was moved onto it, the claim fails and the next write
		// moves this session to a sibling instead of appending into that journal.
		// A storage that learns only later that the claim is not held says so through `onLost`.
		this.#sessionClaim = {
			sessionId,
			release:
				this.#storage.claimSession(sessionId, sessionFile, {
					writer: true,
					handover,
					onLost: () => this.#onSessionClaimLost(sessionId),
				}) ?? undefined,
		};
	}

	/**
	 * Whether `sessionFile` is the journal this manager handed to a clone of
	 * itself and that clone is still writing it. Coming back to that session is
	 * the ordinary end of a session transition — a bash command still running
	 * when the user starts a new session and then resumes the one they were in
	 * — and refusing it would move the conversation the person is looking at to
	 * a sibling file with a new id while its own detached work keeps the
	 * original.
	 *
	 * Narrow on purpose, because the refusal it steps around is what keeps one
	 * journal to one agent loop:
	 * - only the journal this manager handed over, and only while the clone it
	 *   handed it to still holds a writer slot on that same file, which also
	 *   clears the record once the clone lets go;
	 * - the record is dropped as soon as it stops holding, so a transcript a
	 *   different manager took over afterwards is refused like any other;
	 * - a weak reference, so a dropped clone cannot keep the record alive;
	 * - a second omp process is untouched: `handover` only waives this
	 *   process's own one-writer refusal, never the cross-process lease.
	 */
	#reclaimsJournalHandedToClone(sessionId: string, sessionFile: string): boolean {
		const handed = this.#journalsHandedToClones.get(sessionId);
		if (!handed) return false;
		const clone = handed.clone.deref();
		const stillWriting =
			clone !== undefined &&
			clone.#sessionId === sessionId &&
			clone.#sessionClaim?.release !== undefined &&
			clone.#sessionFile !== undefined &&
			isSameJournalFile(clone.#sessionFile, sessionFile);
		if (!stillWriting) {
			this.#journalsHandedToClones.delete(sessionId);
			return false;
		}
		return isSameJournalFile(handed.sessionFile, sessionFile);
	}

	/**
	 * Whether a switch to `sessionFile` (session `sessionId`) is this manager reading again the session it holds now:
	 * same id, same journal file, and a live writer claim on it (a reload, `AgentSession.reload()`). The switch's
	 * claim then meets this manager's own writer slot, which the manager keeps through the load (a write in between
	 * takes it); the adoption lets the switch's duplicate slot go. Narrow as
	 * {@link #reclaimsJournalHandedToClone}: another manager of this process on the same journal is refused, and a
	 * second omp process is untouched (`handover` only waives this process's own one-writer refusal).
	 */
	#rereadsItsOwnSession(sessionId: string, sessionFile: string): boolean {
		const claim = this.#sessionClaim;
		return (
			this.#sessionId === sessionId &&
			claim?.sessionId === sessionId &&
			claim.release !== undefined &&
			this.#sessionFile !== undefined &&
			isSameJournalFile(this.#sessionFile, sessionFile)
		);
	}

	/**
	 * Take this process's writer claim on the session now, instead of at the
	 * first append, and keep taking it for every session this manager switches
	 * to afterwards. A session handed to a running agent loop writes its
	 * journal, and the claim is what tells the rest of the process that this
	 * journal is open here — a roster scan must not offer it as a revivable
	 * transcript, and a revive must not reopen it, before the agent's first
	 * entry lands. Inspection paths (`omp share`, `--export`, `render`) never
	 * call it, so reading a session still claims nothing.
	 *
	 * Returns the undo for a loop that never started: a session construction
	 * that fails before its agent exists gives the claim back, so the next
	 * attempt on that journal rebuilds it in place instead of being moved to a
	 * sibling by a claim nothing holds any more. The undo drops nothing it did
	 * not take: it is a no-op when a caller already owned this manager as a
	 * writer, and once the manager moved on to another session. One manager
	 * belongs to one agent loop, so a second caller taking it over while the
	 * first is still starting is not a state this reverses.
	 */
	claimForWriting(): () => void {
		const alreadyOwned = this.#writerOwned;
		const claimBefore = this.#sessionClaim;
		this.#writerOwned = true;
		this.#claimSession();
		const claimed = this.#sessionClaim;
		if (alreadyOwned) return () => {};
		let undone = false;
		return () => {
			if (undone) return;
			undone = true;
			if (!this.#writerOwned || this.#sessionClaim !== claimed) return;
			this.#writerOwned = false;
			if (claimed === claimBefore) return;
			claimed?.release?.();
			// Cleared rather than restored: the next write re-claims, and a
			// claim this manager no longer holds must not read as held.
			this.#sessionClaim = undefined;
		};
	}

	/**
	 * Whether another writer owns this session, claiming it first when it is
	 * free. Another writer is a live omp process, or a second manager in this
	 * process that opened the same journal. A non-owner never writes the
	 * session's file: its next write moves this session to a sibling with a new
	 * id instead, so two writers never mix their entries in one journal and the
	 * owner's full rewrites never race the other writer's appends.
	 * A claim this process held and lost to another holder counts as owned
	 * elsewhere; a subagent transcript's lost claim (its parent session's
	 * lease, see {@link #followParentMove}) instead starts following the
	 * parent, and its write, refused, writes nothing.
	 */
	#sessionOwnedElsewhere(): boolean {
		if (this.#released || this.#sessionFileRelocating) return false;
		const held = this.#sessionClaim;
		if (held?.sessionId === this.#sessionId && held.release && this.#storage.sessionClaimLost?.(this.#leaseId())) {
			held.release();
			held.release = undefined;
			return !this.#followParentMove();
		}
		this.#claimSession();
		const claim = this.#sessionClaim;
		return claim !== undefined && claim.sessionId === this.#sessionId && claim.release === undefined;
	}

	/** The lease this session is written under: its parent session's for a subagent transcript (see `sessionLeaseId`). */
	#leaseId(): string {
		return (this.#sessionFile && sessionLeaseId(this.#sessionFile)) || this.#sessionId;
	}

	/**
	 * Hold the claim on `#sessionId` at `#sessionFile` once the storage has
	 * confirmed it (`acquireSessionClaim`, SQL storage): `held`, `refused` while
	 * another live omp process holds it (the claim is then left unset, as for a
	 * refused write-path claim), or `superseded` when another open or switch
	 * replaced the session while the storage answered. It moves nothing. A
	 * storage without `acquireSessionClaim` answers `held`.
	 */
	async #holdClaim(
		options: { waitMs?: number; onWait?: (holder: SessionClaimHolder) => void } = {},
	): Promise<"held" | "refused" | "superseded"> {
		const sessionFile = this.#sessionFile;
		if (!this.#storage.acquireSessionClaim || !this.#persist || !sessionFile) return "held";
		const sessionId = this.#sessionId;
		const current = this.#sessionClaim;
		if (current?.sessionId === sessionId && current.release) return "held";
		if (current && current.sessionId !== sessionId) current.release?.();
		this.#sessionClaim = undefined;
		// Opening for writing claims as the journal's one writer, as #claimSession does.
		const release = await this.#storage.acquireSessionClaim(sessionId, sessionFile, {
			...options,
			writer: true,
			handover: this.#reclaimsJournalHandedToClone(sessionId, sessionFile),
			onLost: () => this.#onSessionClaimLost(sessionId),
		});
		if (this.#sessionId !== sessionId || this.#sessionFile !== sessionFile) {
			release?.();
			return "superseded";
		}
		this.#sessionClaim = { sessionId, release: release ?? undefined };
		return release ? "held" : "refused";
	}

	/**
	 * Claim the session this manager opened before anything else runs, on a
	 * storage that can tell at once whether another process holds it (SQL
	 * storage): a resume of a session another live process holds then moves
	 * to a sibling with a new id (or, under `OMP_SESSION_EXCLUSIVE=1`, stops)
	 * before any hook sees the held id. With `waitMs` it first waits that long
	 * for the holder's lease to go or expire, `onWait` hearing the holder. Once
	 * it holds the claim it reads the session again when the stored size is
	 * not what it loaded, since another holder may have written until it let
	 * go. Other storages claim at the first write, as before, except a
	 * launcher-named session's wait on its file lease
	 * ({@link #waitForOpenFileClaim}).
	 */
	async claimOpenedSession(
		options: { waitMs?: number; onWait?: (holder: SessionClaimHolder | undefined) => void } = {},
	): Promise<void> {
		if (this.#released) return;
		if (!this.#storage.acquireSessionClaim) return this.#waitForOpenFileClaim(options);
		let holder: SessionClaimHolder | undefined;
		const outcome = await this.#holdClaim({
			waitMs: options.waitMs,
			onWait: found => {
				holder = found;
				options.onWait?.(found);
			},
		});
		if (outcome === "refused") {
			// A subagent transcript whose parent another process holds follows the parent instead.
			if (!this.#followParentMove()) {
				this.#moveOffSessionFile("open-elsewhere", { holder, why: "another omp process holds its lease" });
			}
		} else if (outcome === "held") {
			await this.#reloadIfWrittenElsewhere();
		}
	}

	/**
	 * {@link claimOpenedSession} on a storage that claims only at a write (file
	 * storage), under `OMP_SESSION_EXCLUSIVE=1` and with `waitMs`: take the
	 * claim now, and while another live process holds the session's lease,
	 * take it again every {@link OPEN_FILE_CLAIM_RETRY_MS} until that process
	 * lets go or `waitMs` runs out, `onWait` hearing once that it waits (a file
	 * lease does not name its holder). A launcher starts the next process on a
	 * session while the one before it is still ending, and without the wait
	 * the next process's first write stops it. A session still held after the
	 * wait stops there, before anything writes it. A refusal for a file that no
	 * longer holds this session is left to the first write, which stops it as
	 * `replaced`. A {@link close}, {@link seal} or session switch during the
	 * wait ends it without the claim: a closed manager must not take the
	 * session back from the next process. Without `OMP_SESSION_EXCLUSIVE=1`
	 * nothing changes: the kernel drops a dead holder's lease at once, so the
	 * wait would serve only a holder that is still ending, and a resume of a
	 * session another process holds moves to a sibling at its first write, as
	 * before.
	 */
	async #waitForOpenFileClaim(options: {
		waitMs?: number;
		onWait?: (holder: SessionClaimHolder | undefined) => void;
	}): Promise<void> {
		const sessionId = this.#sessionId;
		const sessionFile = this.#sessionFile;
		const waitMs = options.waitMs ?? 0;
		if (!isSessionExclusive() || waitMs <= 0 || !this.#persist || !sessionFile || !this.#storage.claimSession) return;
		const deadline = Date.now() + waitMs;
		const closes = this.#closes;
		let waiting = false;
		for (;;) {
			// Every pass starts here, after each await and after `onWait`: a close, seal or switch since the wait began
			// (during the header read or the sleep, or one `onWait` itself started) ends it before it claims or stops.
			if (
				this.#released ||
				this.#closes !== closes ||
				this.#sessionId !== sessionId ||
				this.#sessionFile !== sessionFile
			) {
				return;
			}
			this.#claimSession();
			const claim = this.#sessionClaim;
			if (claim?.sessionId === sessionId && claim.release) break;
			if (!waiting) {
				if ((await readSessionHeaderId(sessionFile, this.#storage)) !== sessionId) return;
				waiting = true;
				options.onWait?.(undefined);
				continue;
			}
			const left = deadline - Date.now();
			if (left <= 0) {
				this.#moveOffSessionFile("open-elsewhere");
				return;
			}
			await Bun.sleep(Math.min(OPEN_FILE_CLAIM_RETRY_MS, left));
		}
		await this.#reloadIfWrittenElsewhere();
	}

	/**
	 * After an acquire: read the session again when its stored size is not
	 * the size this manager last loaded or wrote, so its next write lands on
	 * what another holder wrote before it let go, never at a stale offset.
	 */
	async #reloadIfWrittenElsewhere(): Promise<void> {
		const sessionFile = this.#sessionFile;
		const storage = this.#storage;
		if (!sessionFile || !storage.readTextFrom) return;
		let stored: number | null;
		try {
			stored = (await storage.readTextFrom(sessionFile, Number.MAX_SAFE_INTEGER, 0)).size;
		} catch (err) {
			if (!isEnoent(err)) throw err;
			stored = null;
		}
		if (stored === this.#expectedDiskSize || this.#sessionFile !== sessionFile) return;
		await this.#setSessionFile(sessionFile, { keepClaim: true });
	}

	/**
	 * The storage found this process's claim on `sessionId` lost: another
	 * holder took the session over, or its row is gone. The session moves to
	 * a sibling with a new id at once and publishes its whole transcript
	 * there, the entries a write fence refused included, as for a session
	 * another process owns; under `OMP_SESSION_EXCLUSIVE=1` it stops instead.
	 * A loss of a session this manager already left changes nothing.
	 */
	#onSessionClaimLost(sessionId: string): void {
		const claim = this.#sessionClaim;
		const sessionFile = this.#sessionFile;
		if (sessionId !== this.#sessionId || claim?.sessionId !== sessionId || !claim.release || !sessionFile) return;
		if (this.#released || !this.#persist) return;
		// A move in flight checks its claim itself before it writes either path.
		if (this.#sessionFileRelocating) return;
		claim.release();
		claim.release = undefined;
		// A subagent transcript follows its parent to the sibling the parent moves to.
		if (this.#followParentMove()) return;
		if (this.#moveOffSessionFile("open-elsewhere", { why: "another omp process took its lease over" })) {
			this.#rewriteSynchronously();
		}
	}

	/**
	 * Whether a write must wait for the parent session instead of landing: a
	 * parent follow is in flight, or this subagent transcript's claim (its
	 * parent's lease) is refused or lost, which starts one (see
	 * {@link #followParentMove}). A main session never holds here: it moves
	 * off itself.
	 */
	#holdForParentMove(): boolean {
		if (this.#parentMoveFollowOfThisFile()) return true;
		if (!this.#storage.acquireSessionClaim) return false;
		const file = this.#sessionFile;
		const root = file ? sessionLeaseRoot(file) : undefined;
		if (!file || !root || !path.resolve(file).startsWith(`${root.stem}${path.sep}`)) return false;
		if (this.#released || this.#sessionFileRelocating || !this.#persist) return false;
		if (!this.#storage.sessionClaimLost?.(this.#leaseId())) {
			this.#claimSession();
			const claim = this.#sessionClaim;
			if (!claim || claim.sessionId !== this.#sessionId || claim.release) return false;
		}
		return this.#followParentMove();
	}

	/**
	 * Whether {@link #parentMoveFollow} follows the parent of the transcript this manager has now: a follow started
	 * for a transcript it has since left (a switch to another file while it waited), or before a switch back to the
	 * same path, is not this transcript's, and ends at its own checks without writing.
	 */
	#parentMoveFollowOfThisFile(): boolean {
		return (
			this.#parentMoveFollow !== undefined &&
			this.#parentMoveFollowFile === this.#sessionFile &&
			this.#parentMoveFollowGeneration === this.#switchGeneration
		);
	}

	/** Whether a switch has set a new file since `generation` was read (see {@link #switchGeneration}). */
	#switchedSince(generation: number): boolean {
		return this.#switchGeneration !== generation;
	}

	/**
	 * For a subagent transcript (`<parent stem>/…/<agent>.jsonl`) whose
	 * parent session's lease is lost: start following the parent, once, and
	 * return `true`. The caller writes nothing; the entries stay in memory
	 * until {@link #runParentMoveFollow} moves this transcript under the
	 * sibling the parent goes on in and publishes it there, keeping its id.
	 * `false` for a main session, which moves off itself. With `recordLeft` false (a switch whose claim another
	 * process refused, which never had the transcript), a fork beside the parent does not record it as left. A
	 * follow still running for a transcript this manager has left does not count as this one's: this transcript
	 * starts its own, with its own `recordLeft`.
	 */
	#followParentMove({ recordLeft = true }: { recordLeft?: boolean } = {}): boolean {
		if (this.#parentMoveFollowOfThisFile()) return true;
		// Only a store that claims a subagent transcript under its parent's lease (SQL storage) follows the parent.
		if (!this.#storage.acquireSessionClaim) return false;
		const childFile = this.#sessionFile;
		const root = childFile ? sessionLeaseRoot(childFile) : undefined;
		if (!childFile || !root || this.#released || !path.resolve(childFile).startsWith(`${root.stem}${path.sep}`)) {
			return false;
		}
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		const generation = this.#switchGeneration;
		const follow: Promise<void> = this.#runParentMoveFollow(childFile, root.stem, recordLeft, generation).finally(
			() => {
				if (this.#parentMoveFollow === follow) this.#parentMoveFollow = undefined;
			},
		);
		this.#parentMoveFollow = follow;
		this.#parentMoveFollowFile = childFile;
		this.#parentMoveFollowGeneration = generation;
		return true;
	}

	/**
	 * Wait, briefly, for the parent session `<parentStem>.jsonl` to go on in a
	 * sibling in this process (it learns of the loss from the same lease, so
	 * its move-off is recorded by then), follow any further move-offs of that
	 * sibling, and move this transcript, `childFile`, to the same relative path
	 * under the last sibling's artifacts directory once the parent's artifact
	 * copy there has landed; then publish the whole transcript over that copy.
	 * When the parent does not go on here (another process holds or moved it,
	 * and nothing records where), this transcript forks to a session of its own
	 * beside the parent file, under a lease it takes there, its header naming
	 * the parent as `parentSession` (a lease row names no successor, and a
	 * move keeps the parent's id), and publishes its whole transcript there:
	 * no entry is lost, and no id is stranded. A follow from before a switch set its new file (`generation`, see
	 * {@link #switchedSince}) moves and publishes nothing; one that moves while a switch loads is recorded by it
	 * ({@link #activeSwitch}).
	 */
	async #runParentMoveFollow(
		childFile: string,
		parentStem: string,
		recordLeft: boolean,
		generation: number,
	): Promise<void> {
		const parent = `${parentStem}.jsonl`;
		const deadline = Date.now() + PARENT_MOVE_WAIT_MS;
		let moveOff = sessionMoveOffs.get(parent);
		while (!moveOff && Date.now() < deadline) {
			await Bun.sleep(20);
			moveOff = sessionMoveOffs.get(parent);
		}
		const copies: Array<Promise<void>> = [];
		let sibling: string | undefined;
		for (
			const seen = new Set<string>();
			moveOff && !seen.has(moveOff.to);
			moveOff = sessionMoveOffs.get(moveOff.to)
		) {
			seen.add(moveOff.to);
			copies.push(moveOff.copied);
			sibling = moveOff.to;
		}
		if (this.#sessionFile !== childFile || this.#switchedSince(generation) || this.#entriesReleased) return;
		if (sibling === undefined) {
			this.#parentMoveFollow = undefined;
			this.#heldAdoptionFile = undefined;
			const parentSession = sessionLeaseRoot(childFile)?.id ?? this.#sessionId;
			this.#closeWriterEventually();
			this.#moveOffSessionFile(
				"open-elsewhere",
				{ why: "its parent session is another omp process's" },
				{ dir: path.dirname(parentStem), parentSession },
				{ recordLeft },
			);
			if (this.#released) this.#closeOwesPublish = true;
			else this.#rewriteSynchronously();
			return;
		}
		for (const copied of copies) await copied;
		if (this.#sessionFile !== childFile || this.#switchedSince(generation) || this.#entriesReleased) return;
		const next = path.join(
			sibling.slice(0, -JSONL_SUFFIX_LENGTH),
			path.relative(parentStem, path.resolve(childFile)),
		);
		this.#closeWriterEventually();
		this.#sessionClaim?.release?.();
		this.#sessionClaim = undefined;
		this.#sessionFile = next;
		this.#heldAdoptionFile = undefined;
		if (this.#activeSwitch) this.#activeSwitch.left = { id: this.#sessionId, file: next };
		// The parent's copy holds this transcript's durable bytes; the publish replaces them.
		this.#expectedDiskSize = this.#storage.existsSync(next) ? this.#storage.statSync(next).size : null;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, next);
		this.#claimSession();
		this.#notifyPersistenceNotice({ reason: "open-elsewhere", from: childFile, to: next });
		// The follow is over: the transcript is at its new path, and its publish is an ordinary one.
		this.#parentMoveFollow = undefined;
		if (this.#released) this.#closeOwesPublish = true;
		else this.#rewriteSynchronously();
	}

	/**
	 * Stop this `OMP_SESSION_EXCLUSIVE=1` session instead of moving it to
	 * another id: seal it, so nothing more is written anywhere, and end the
	 * process non-zero, naming the reason and, for a lease, its holder's host
	 * and pid. The launcher that named the session restarts it under the
	 * same id. The holder is looked up for at most
	 * {@link EXCLUSIVE_STOP_HOLDER_LOOKUP_MS}: a database that stopped
	 * answering must not keep a sealed session's process alive. Until the
	 * process ends, a flush or close that finds an entry storage does not hold
	 * rejects with the stop instead of reporting it saved.
	 */
	#stopExclusive(
		reason: SessionPersistenceNotice["reason"],
		detail: { holder?: SessionClaimHolder; why?: string },
	): void {
		if (this.#exclusiveStop) return;
		const sessionId = this.#sessionId;
		const sessionFile = this.#sessionFile;
		const why =
			detail.why ??
			{
				contested: "another writer changed its file",
				replaced: "its file now holds another session",
				"open-elsewhere": "another omp process holds it",
			}[reason];
		const announced = Promise.withResolvers<void>();
		this.#exclusiveStop = {
			error: new SessionExclusiveStopError(sessionId, reason, why),
			announced: announced.promise,
			dropped: false,
		};
		this.seal();
		void (async () => {
			try {
				const lookup =
					detail.holder === undefined && reason === "open-elsewhere"
						? this.#storage.sessionClaimHolder?.(this.#leaseId())
						: undefined;
				const holder =
					detail.holder ??
					(lookup &&
						(await Promise.race([
							lookup.catch(() => undefined),
							Bun.sleep(EXCLUSIVE_STOP_HOLDER_LOOKUP_MS).then(() => undefined),
						])));
				const by = holder ? ` (host ${holder.host}, pid ${holder.pid})` : "";
				logger.error("Session stops: OMP_SESSION_EXCLUSIVE=1 keeps it from moving to another id", {
					sessionId,
					sessionFile,
					reason,
					holder,
				});
				process.stderr.write(
					`Session ${sessionId} stops (${reason}): ${why}${by}. OMP_SESSION_EXCLUSIVE=1 keeps it from moving to another id.\n`,
				);
			} finally {
				announced.resolve();
			}
			// The stop ends the process at once, without postmortem's cleanup, so nothing more of the session runs; a
			// claim the store still holds (a subagent's, the session's own when a write found the file changed) goes
			// back first, within the release's bound. The session's lost or refused claim deletes nothing.
			await this.#storage.releaseHeldClaims?.().catch(() => undefined);
			process.exit(1);
		})();
	}

	/**
	 * Whether the `OMP_SESSION_EXCLUSIVE=1` stop `stop` left an entry storage does not hold: one the durable frontier
	 * does not cover as confirmed (its write was refused, or never confirmed) and the last load did not read from
	 * storage either, or one appended after the stop, which the seal dropped. Nothing writes either once the session
	 * stopped.
	 */
	#stopLeftEntriesUnsaved(stop: { dropped: boolean }): boolean {
		const durable = this.#durable;
		const loaded = this.#loadedEntries;
		const stored =
			(durable?.generation === this.#entriesGeneration && durable.confirmed === this.#entries.length) ||
			(loaded !== undefined &&
				loaded.file === this.#sessionFile &&
				loaded.generation === this.#entriesGeneration &&
				loaded.count === this.#entries.length);
		return stop.dropped || (!stored && this.#shouldHaveSessionFile());
	}

	/**
	 * A switch (or reread) of a session that stopped under `OMP_SESSION_EXCLUSIVE=1` rejects once the stop line is on
	 * stderr, before it sets a new file: the stop is judged against the session that stopped, which stays this
	 * manager's until the process ends.
	 */
	async #refuseSwitchAfterStop(stop: { error: SessionExclusiveStopError; announced: Promise<void> }): Promise<never> {
		await stop.announced;
		const { sessionId, reason, why } = stop.error;
		throw new SessionExclusiveStopError(sessionId, reason, why, "it opens no other session");
	}

	/**
	 * After an `OMP_SESSION_EXCLUSIVE=1` stop, reject with it when storage does not hold every entry, once the
	 * writes still queued and the append confirmations settled and the stop line is on stderr: no caller may take an
	 * entry for saved while the process ends without it, and none acts on the rejection before the stop is named.
	 */
	async #rejectIfStopLeftEntriesUnsaved(): Promise<void> {
		const stop = this.#exclusiveStop;
		if (!stop) return;
		await this.#storage.drain(this.#sessionFile).catch(() => undefined);
		await Promise.all(this.#pendingAppendConfirmations);
		if (!this.#stopLeftEntriesUnsaved(stop)) return;
		await stop.announced;
		throw stop.error;
	}

	/**
	 * Whether another writer owns this session (a live omp process, or a second
	 * manager in this process on the same journal), so this process's next write
	 * would move it to a sibling (`"open-elsewhere"`) instead of appending.
	 * Claims the session when it is free, as a write would.
	 */
	isOwnedElsewhere(): boolean {
		return this.#sessionOwnedElsewhere();
	}

	/**
	 * `#sessionFile` when `error` reports that it changed since this manager
	 * last wrote it, which the caller can recover from; `undefined` reports the
	 * conflict as before. A fresh file that already exists is never recovered,
	 * so a colliding sibling cannot move again. Backends that defer sync
	 * publishes also report as before: there a conflict can be this manager
	 * racing its own unconfirmed publish, not another writer. The one
	 * exception is a write this manager queued (`queued`) on a store that
	 * recovers queued conflicts (see {@link #recoversQueuedConflicts}), which
	 * lets this manager's own writes settle before it reads the file again; a
	 * refused full rewrite on such a store goes to that recovery too (see
	 * {@link #recoverQueuedConflict}).
	 */
	#conflictedSessionFile(error: unknown, queued = false): string | undefined {
		const sessionFile = this.#sessionFile;
		if (
			!(error instanceof SessionWriteConflictError) ||
			error.expectedSize === null ||
			!sessionFile ||
			path.resolve(error.path) !== path.resolve(sessionFile) ||
			!this.#persist ||
			this.#released ||
			this.#sessionFileRelocating ||
			this.#exclusiveStop ||
			(this.#storage.defersSyncPublish && !(queued && this.#recoversQueuedConflicts()))
		) {
			return undefined;
		}
		return sessionFile;
	}

	/**
	 * Whether a write conflict the store reports for a write this manager
	 * queued is recovered (see {@link #recoverQueuedConflict}) rather than
	 * reported: only on SQL storage that claims sessions, the one deferring
	 * store whose appends are checked against the size this manager expects.
	 */
	#recoversQueuedConflicts(): boolean {
		return this.#storage.defersSyncPublish === true && this.#storage.acquireSessionClaim !== undefined;
	}

	/**
	 * A visitor of the stored transcript, entry by entry, that finds the entries
	 * it holds that this manager does not, with the visit's `options`, which
	 * count its malformed records and the bytes it read (`bytes()`: the stored
	 * size once it read the whole transcript). `found()` is `undefined` when the
	 * transcript is not this session's journal (its first entry is not this
	 * session's header), and the visit stops there. `at` is where they go in
	 * `#entries` to keep the file's order: after the last entry both hold, so
	 * this manager's entries the file lacks still follow them.
	 * `extendsFrontier` reports that the file is this manager's first
	 * `shared` entries, at least the durable frontier's, followed only by
	 * them: another writer (a clone's original healing a missed entry) may
	 * have appended this manager's own next entries before them. One scan
	 * serves one read: a read again starts a new scan.
	 */
	#foreignEntryScan(): {
		visit: (entry: FileEntry) => boolean;
		options: Pick<VisitEntriesFromFileStreamOptions, "onMalformedRecord" | "onChunk">;
		bytes: () => number;
		found: () => ForeignEntries | undefined;
	} {
		let ownJournal: boolean | undefined;
		let malformedRecords = 0;
		let bytes = 0;
		let sharedInOrder = true;
		const foreign: SessionEntry[] = [];
		const shared = new Set<string>();
		return {
			visit: raw => {
				if (ownJournal === undefined) {
					ownJournal = raw.type === "session" && raw.id === this.#sessionId;
					return ownJournal;
				}
				const entry = raw as SessionEntry;
				if (!this.#index.has(entry.id)) {
					foreign.push(entry);
					return true;
				}
				shared.add(entry.id);
				const sharedEntry = this.#index.get(entry.id);
				if (
					foreign.length > 0 ||
					this.#entries[shared.size - 1]?.id !== entry.id ||
					sharedEntry?.parentId !== entry.parentId
				) {
					sharedInOrder = false;
				}
				return true;
			},
			options: {
				onMalformedRecord: () => {
					malformedRecords++;
				},
				onChunk: chunk => {
					bytes += chunk.byteLength;
				},
			},
			bytes: () => bytes,
			found: () => {
				if (!ownJournal) return undefined;
				const durable = this.#durable;
				const extendsFrontier =
					sharedInOrder &&
					malformedRecords === 0 &&
					durable?.generation === this.#entriesGeneration &&
					durable.issued === durable.confirmed &&
					shared.size >= durable.confirmed;
				let at = this.#entries.length;
				while (at > 0 && !shared.has(this.#entries[at - 1]!.id)) at--;
				return { foreign, at, shared: shared.size, extendsFrontier };
			},
		};
	}

	/**
	 * Keep the entries another writer added to `#sessionFile`, whose bytes now
	 * measure `diskSize`. They join this session's tree as a side branch (their
	 * parents are entries both writers loaded) at their place in the file, and
	 * the active leaf stays this session's. When the file is exactly this
	 * manager's first entries, at least the durable frontier's, followed by
	 * them, the frontier extends over all of them, so this manager's next
	 * entries follow as an append; otherwise the retried rewrite republishes
	 * them with the rest. A `tool_result_prune` record among them blanks the
	 * tool results it names, and an `entry_patch` record sets its fields on
	 * the entries it names, as a load does: the rewrite writes those effects
	 * inline and the patch record empty.
	 */
	#adoptForeignEntries(found: ForeignEntries, diskSize: number): void {
		const leaf = this.#index.leafId();
		const durable = this.#durable;
		const kept: SessionEntry[] = [];
		for (const entry of found.foreign) {
			// A recovery that raced this one may already have kept it.
			if (this.#index.has(entry.id)) continue;
			this.#index.insert(entry);
			kept.push(entry);
		}
		this.#index.setLeaf(leaf);
		this.#entries = [...this.#entries.slice(0, found.at), ...kept, ...this.#entries.slice(found.at)];
		this.#expectedDiskSize = diskSize;
		// A cold target is made whole without reading its images, and goes back to the store with the values
		// the records set, as `updateEntryBody` does; one that stays whole gets its images, as whole entries hold them.
		const hydrated: SessionEntry[] = [];
		const targets = wholeTargetsOf(this.#index, hydrated);
		const pruned = applyToolResultPrunes(kept, targets);
		const patched = applyEntryPatches(kept, targets);
		for (const target of hydrated) {
			if (!convertToColdEntry(target, () => this.#openColdStore()))
				resolveBlobRefsInEntriesSync([target], this.#blobs);
		}
		if (pruned || patched) this.#bodyRevision++;
		this.#durable =
			found.extendsFrontier && durable && kept.length === found.foreign.length
				? durableFrontier(this.#entriesGeneration, found.shared + kept.length, diskSize)
				: undefined;
		if (kept.length > 0)
			logger.warn("Kept session entries another writer added", {
				sessionFile: this.#sessionFile,
				adopted: kept.length,
			});
	}

	/**
	 * Another writer appended to the session file past `durable`, the file now
	 * measuring `storedSize`: a session's previous process does with its exit
	 * marker after this one resumed it, and a clone's original does when it
	 * heals an entry both hold. A bounded header read first proves the file
	 * still names this session. It then reads only the bytes past the frontier.
	 * When they are whole records, this manager's next entries in order
	 * followed only by entries that parent into known ones or are roots
	 * (`parentId: null`, as after {@link resetLeaf}), keep those and extend
	 * the frontier over all of them. Otherwise the caller republishes, and its
	 * conflict recovery keeps them or moves the session off a file that holds
	 * another one.
	 */
	#adoptEntriesAppendedPastFrontier(sessionFile: string, durable: DurableFrontier, storedSize: number): boolean {
		if (this.#storage.defersSyncPublish || !this.#storage.readTextRangeSync || durable.issued !== durable.confirmed)
			return false;
		let headerId: string | undefined;
		try {
			headerId = sessionHeaderIdInPrefix(
				this.#storage.readTextRangeSync(sessionFile, 0, Math.min(SESSION_HEADER_PREFIX_BYTES, durable.issuedSize)),
			);
		} catch {
			return false;
		}
		if (headerId !== this.#sessionId) return false;

		const foreign: SessionEntry[] = [];
		const foreignIds = new Set<string>();
		let shared = durable.confirmed;
		let position = durable.issuedSize;
		let partial = "";
		while (position < storedSize) {
			let end = Math.min(position + SESSION_TAIL_APPEND_CHUNK_BYTES, storedSize);
			let chunk: string | undefined;
			while (end > position) {
				try {
					chunk = this.#storage.readTextRangeSync(sessionFile, position, end);
				} catch {
					return false;
				}
				if (Buffer.byteLength(chunk, "utf8") === end - position) break;
				end--;
			}
			if (chunk === undefined || Buffer.byteLength(chunk, "utf8") !== end - position) return false;

			const records = partial + chunk;
			let start = 0;
			for (;;) {
				const newline = records.indexOf("\n", start);
				if (newline === -1) break;
				const line = records.slice(start, newline);
				start = newline + 1;
				if (line.trim().length === 0) continue;
				let record: unknown;
				try {
					record = JSON.parse(line);
				} catch {
					return false;
				}
				if (!isAppendedEntry(record)) return false;
				if (this.#index.has(record.id)) {
					if (foreign.length > 0 || this.#entries[shared]?.id !== record.id) return false;
					shared++;
					continue;
				}
				const parentId: unknown = record.parentId;
				const parentKnown =
					parentId === null ||
					(typeof parentId === "string" && (this.#index.has(parentId) || foreignIds.has(parentId)));
				if (!parentKnown || foreignIds.has(record.id)) return false;
				foreign.push(record);
				foreignIds.add(record.id);
			}
			partial = records.slice(start);
			position = end;
		}
		// A record the other writer has not finished would otherwise join the next append's first line.
		if (partial.length > 0) return false;
		resolveBlobRefsInEntriesSync(foreign, this.#blobs);
		this.#adoptForeignEntries({ foreign, at: shared, shared, extendsFrontier: true }, storedSize);
		return this.#durable !== undefined;
	}

	/**
	 * A synchronous full rewrite of `#sessionFile` met bytes this manager did
	 * not write: usually a writer without the ownership lease (an older omp,
	 * an external tool) appending to the file this process owns. Overwriting
	 * would erase those entries and retrying blindly can never succeed, so read
	 * the file back, keep its new entries, and retry against the size just read.
	 * File storage, and a storage with `readTextRangeSync`, read the file in
	 * bounded windows parsed as they arrive, so the transcript is not held
	 * whole; a storage with only `readTextSync` gives its whole text at once
	 * (see `transcriptByteChunksSync`). A deleted file is recreated; a file that
	 * no longer reads as this session is left untouched and the session moves
	 * to a sibling. A read that another writer's full write changed between
	 * two windows (`SessionReadConflictError`, see {@link checkedTextRangeWindows})
	 * is read again from the start, at most {@link MAX_WRITE_CONFLICT_RECOVERIES}
	 * reads in all as {@link #recoverFromWriteConflict} does, then the session
	 * moves to a sibling as `contested`: the rewrite is never retried without a
	 * whole read of one body, since its size check could pass against the other
	 * writer's body and overwrite it.
	 *
	 * After {@link MAX_WRITE_CONFLICT_RECOVERIES} passes (`recoveries`) the
	 * other writer is still racing every read-to-publish window: leave the file
	 * to it and move to a sibling rather than re-serializing on every write.
	 *
	 * Returns the path to retry, or `undefined` to report the conflict as before.
	 */
	#recoverFromWriteConflictSync(error: unknown, recoveries: number): string | undefined {
		const contested = this.#conflictedSessionFile(error);
		if (!contested) return undefined;
		if (recoveries >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
		for (let reads = 1; ; reads++) {
			const chunks = transcriptByteChunksSync(contested, this.#storage);
			if (!chunks) return undefined;
			const scan = this.#foreignEntryScan();
			try {
				visitEntriesFromChunksSync(chunks, scan.visit, scan.options);
			} catch (readError) {
				if (readError instanceof SessionReadConflictError) {
					if (reads >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
					continue;
				}
				if (!isEnoent(readError)) return this.#moveOffSessionFile("replaced");
				this.#expectedDiskSize = null;
				this.#oversizedLines = new Set();
				this.#durable = undefined;
				return contested;
			}
			const found = scan.found();
			if (!found) return this.#moveOffSessionFile("replaced");
			resolveBlobRefsInEntriesSync(found.foreign, this.#blobs);
			this.#adoptForeignEntries(found, scan.bytes());
			return contested;
		}
	}

	/**
	 * Asynchronous {@link #recoverFromWriteConflictSync}, reading the storage's
	 * chunk stream. For a write this manager queued (`queued`, see
	 * {@link #recoverQueuedConflict}) on a backend that defers publishes it
	 * first lets this manager's own queued writes to the file settle and
	 * reloads the store's index, so the content it reads back, and the size
	 * the retry is checked against, are the store's, never a write of this
	 * manager still in flight; a conflict on a file this manager already moved
	 * off retries at the sibling it went on in. A switch waits for a recovery
	 * the drain started before it reads the session it leaves
	 * ({@link #setSessionFile}), and records a move off one makes while it
	 * loads ({@link #activeSwitch}).
	 *
	 * A read that another writer's full write or delete cut off
	 * (`SessionReadConflictError`: SQL storage's chunked read) is read again
	 * from the start, at most {@link MAX_WRITE_CONFLICT_RECOVERIES} reads in
	 * all; past that the other writer is still rewriting the file, and the
	 * session moves to a sibling as `contested`. The file still holds this
	 * session, so it is never taken for a `replaced` one, and the publish is
	 * never retried without a whole read: its size check could pass against
	 * the other writer's body of the same size and overwrite it.
	 */
	async #recoverFromWriteConflict(error: unknown, recoveries: number, queued = false): Promise<string | undefined> {
		if (
			queued &&
			error instanceof SessionWriteConflictError &&
			this.#sessionFile &&
			this.#movedOffFrom.has(path.resolve(error.path))
		) {
			return this.#sessionFile;
		}
		const contested = this.#conflictedSessionFile(error, queued);
		if (!contested) return undefined;
		// Every path from here retries or moves off: the conflict is this recovery's, not a failure.
		if (error instanceof Error) this.#takenOverConflicts.add(error);
		if (recoveries >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
		if (this.#storage.defersSyncPublish) {
			await this.#storage.confirmWrites?.(contested).catch(() => undefined);
			await this.#storage.refresh?.();
			if (this.#sessionFile !== contested) return this.#sessionFile;
		}
		const epoch = this.#diskEpoch;
		let scan = this.#foreignEntryScan();
		for (let reads = 1; ; reads++) {
			try {
				await visitEntriesFromFileStream(contested, scan.visit, {
					...scan.options,
					storage: this.#storage,
					throwIfMissing: true,
				});
				break;
			} catch (readError) {
				// A synchronous rewrite during the read already recovered; retry against its result.
				if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
				if (readError instanceof SessionReadConflictError) {
					if (reads >= MAX_WRITE_CONFLICT_RECOVERIES) return this.#moveOffSessionFile("contested");
					// One scan serves one read: what the cut-off read found says nothing about the next.
					scan = this.#foreignEntryScan();
					continue;
				}
				if (!isEnoent(readError)) return this.#moveOffSessionFile("replaced");
				this.#expectedDiskSize = null;
				this.#oversizedLines = new Set();
				this.#durable = undefined;
				return contested;
			}
		}
		if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
		const found = scan.found();
		if (!found) return this.#moveOffSessionFile("replaced");
		await resolveBlobRefsInEntries(found.foreign, this.#blobs);
		if (this.#diskEpoch !== epoch || this.#sessionFile !== contested) return this.#sessionFile;
		// An append during the await may have moved the frontier past what was read; the retry republishes.
		this.#adoptForeignEntries({ ...found, extendsFrontier: false }, scan.bytes());
		return contested;
	}

	/**
	 * A write a deferred-publish store (SQL storage) queued for `sessionFile`
	 * was refused with a write conflict: at confirmation, or at once by the
	 * size this store's index holds (a full rewrite, synchronous or atomic,
	 * that stated a size the store no longer has). Another writer that claims
	 * nothing (an older omp) changed the file, it now holds another session,
	 * or the size this manager expects lags what the store took. Take the
	 * error over (`true`) and recover as a write-time conflict does, once this
	 * manager's own queued writes have settled: read the file again, keep the
	 * other writer's new entries, and publish the whole transcript checked
	 * against the size just read, or move to a sibling (`replaced`;
	 * `contested` once {@link MAX_WRITE_CONFLICT_RECOVERIES} recoveries in a
	 * row did not hold), which under `OMP_SESSION_EXCLUSIVE=1` ends the
	 * process instead. Without this the store's journal and this session
	 * diverge: the next publish, checked against a realigned size, would erase
	 * the other writer's entries or write this session over another one, and
	 * a publish checked against the refused size is refused again, every time.
	 * While the recovery runs no other write states a size (see
	 * {@link #rewriteAtomically} and {@link #appendToCurrentSessionFile}).
	 */
	#recoverQueuedConflict(error: unknown, sessionFile: string): boolean {
		if (!this.#recoversQueuedConflicts() || !(error instanceof SessionWriteConflictError)) return false;
		if (sessionFile !== this.#sessionFile || !this.#conflictedSessionFile(error, true)) return false;
		this.#takenOverConflicts.add(error);
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		if (this.#queuedConflictRecovery) return true;
		const recoveries = this.#queuedConflictRecoveries++;
		const generation = this.#switchGeneration;
		const recovery: Promise<void> = this.#recoverFromWriteConflict(error, recoveries, true)
			.then(async retryPath => {
				if (this.#exclusiveStop || this.#entriesReleased) return;
				// A switch set a new file before this recovery finished (it waits for one, within its bound): the
				// entries of the session it left are no longer this manager's to publish. Say so; never lose them silently.
				if (this.#switchedSince(generation)) {
					logger.warn("A write conflict of a session a switch left was recovered after the switch", {
						sessionFile,
						movedTo: retryPath !== this.#sessionFile ? retryPath : undefined,
					});
					return;
				}
				if (!retryPath) {
					this.#takenOverConflicts.delete(error);
					this.#noteDiskFailure(error);
					return;
				}
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (this.#released) {
					this.#closeOwesPublish = true;
					return;
				}
				// Awaited, so a flush that waits for this recovery sees the transcript durable.
				await this.#rewriteAtomically(true);
			})
			.catch((err: unknown) => {
				this.#noteDiskFailure(err);
			})
			.finally(() => {
				if (this.#queuedConflictRecovery === recovery) this.#queuedConflictRecovery = undefined;
			});
		this.#queuedConflictRecovery = recovery;
		return true;
	}

	/**
	 * Leave `#sessionFile` untouched and continue as a fresh session in a
	 * sibling file: a fork. It gets a new session id whose header names the
	 * old one as `parentSession` and keeps the provider prompt-cache key, as
	 * {@link fork} does, so resume-by-id, the title index, and the picker never
	 * see two files for one id. It writes no `continuationOf`: nothing points a
	 * later resume of the old id here. Nothing durable exists there yet: the
	 * caller publishes the whole transcript once and appends incrementally
	 * after that.
	 *
	 * Under `OMP_SESSION_EXCLUSIVE=1` it moves nothing: the session stops
	 * ({@link #stopExclusive}) and this returns `undefined`: the session writes
	 * nothing more, its old path least of all. A subagent transcript's fork (`place`: the
	 * directory to fork into and the session its header names as parent)
	 * moves under the variable too: its id is never the launcher's recorded one.
	 *
	 * The artifact copy runs in the background so a move never blocks the turn
	 * loop on a large artifacts directory; the sibling's artifact manager waits
	 * for it before scanning ids or resolving `artifact://`, and flush/close
	 * await it. Returns the sibling.
	 *
	 * The session moved off is recorded as left (see {@link getLeftSessions}), unless `recordLeft` is false: a
	 * switch that loaded a session another process holds never had it, so nothing of its own is there.
	 */
	#moveOffSessionFile(
		reason: SessionPersistenceNotice["reason"],
		detail: { holder?: SessionClaimHolder; why?: string } = {},
		place?: { dir: string; parentSession: string },
		{ recordLeft = true }: { recordLeft?: boolean } = {},
	): string | undefined {
		const from = this.#sessionFile as string;
		if (isSessionExclusive() && !place) {
			this.#stopExclusive(reason, detail);
			return undefined;
		}
		const previousSessionId = this.#sessionId;
		if (recordLeft) this.#recordLeftSession(previousSessionId, from);
		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		const to = path.join(
			place?.dir ?? path.dirname(from),
			`${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`,
		);
		// An older build's `continuationOf` is not carried over either.
		const {
			type: _type,
			id: _id,
			timestamp: _timestamp,
			parentSession: _parent,
			continuationOf: _of,
			...carried
		} = this.#header;
		this.#header = {
			type: "session",
			id: this.#sessionId,
			timestamp,
			parentSession: place?.parentSession ?? previousSessionId,
			...carried,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
		};
		this.#closeWriterEventually();
		this.#sessionFile = to;
		// A switch loading its new file leaves this sibling, not the session moved off (see #activeSwitch).
		if (this.#activeSwitch) this.#activeSwitch.left = { id: this.#sessionId, file: to };
		this.#expectedDiskSize = null;
		this.#oversizedLines = new Set();
		this.#durable = undefined;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#pendingArtifactCopy = { sessionFile: to, done: copySessionArtifacts(from, to, this.#storage) };
		sessionMoveOffs.set(path.resolve(from), { to: path.resolve(to), copied: this.#pendingArtifactCopy.done });
		this.#movedOffFrom.add(path.resolve(from));
		this.#rememberBreadcrumb(this.#cwd, to);
		this.#claimSession();
		const notice: SessionPersistenceNotice = { reason, from, to };
		this.#movedOffSessionIds.set(notice, previousSessionId);
		this.#notifyPersistenceNotice(notice);
		this.#notifySessionFileChanged(from);
		return to;
	}

	/**
	 * Run `work` on the disk queue once the work queued before it settled.
	 * Resolves with what `work` returned, or with `undefined` where it did not
	 * run (the disk epoch moved since it was queued, unless `ignoreEpoch`) or
	 * ended with an error the queue swallows; rejects with any other error.
	 */
	#scheduleDiskWork<T>(work: () => Promise<T>, options: DiskQueueOptions = {}): Promise<T | undefined> {
		const epoch = options.epoch ?? this.#diskEpoch;
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return undefined;
				return await work();
			});

		const reported = scheduled.catch(err => {
			// A write the lease fence refused is republished in the sibling the
			// loss moved this session to, or the session stops (see
			// #onSessionClaimLost): nothing failed, unless the session was sealed
			// (see #noteDiskFailure).
			if (err instanceof SessionLeaseLostError) {
				this.#noteDiskFailure(err);
				return undefined;
			}
			// The same error the store's drain reports again, for a conflict a recovery took over.
			if (err instanceof Error && this.#takenOverConflicts.has(err)) return undefined;
			throw this.#noteDiskFailure(err);
		});
		// The tail only orders the queue: it neither fails nor holds the work's result.
		this.#diskTail = reported.then(
			() => undefined,
			() => undefined,
		);
		return reported;
	}

	async #withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#atomicPersistenceTail;
		const turn = Promise.withResolvers<void>();
		this.#atomicPersistenceTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignoreEpoch: true },
			);
		} finally {
			// A write while the drain closed the writer opened another: close that one too, never leave it open.
			this.#closeWriterEventually();
			this.#diskTail = Promise.resolve();
		}
	}

	/**
	 * Drains the writer and waits for the confirmations of the appends it took, so a claim released next covers every
	 * write made under it, as {@link close} waits before its claim goes. A write made during the wait adds its own
	 * confirmation, which the next pass waits for: at most GAP_DRAIN_PASSES passes.
	 */
	async #drainWrites(): Promise<void> {
		for (let pass = 0; pass < GAP_DRAIN_PASSES; pass++) {
			await this.#drainAndCloseWriter();
			if (this.#pendingAppendConfirmations.size === 0) return;
			await Promise.all(this.#pendingAppendConfirmations);
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		if (writer) void writer.close().catch(() => undefined);
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		try {
			await writer.close();
		} catch (err) {
			// A queued append's conflict a recovery took over: the writer reports it again on close.
			if (err instanceof Error && this.#takenOverConflicts.has(err)) return;
			throw err;
		}
	}

	#latchIndeterminate(operationError: Error, recoveryErrors: readonly Error[]): SessionPersistenceIndeterminateError {
		const error = new SessionPersistenceIndeterminateError(operationError, recoveryErrors);
		this.#diskFailure = error;
		// The frontier stays: a repair body that landed unverified starts with
		// the same entries, and any other change to the file's size makes the
		// next append republish instead.
		forgetExternalizedImages(this.#blobs);
		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence became indeterminate.", {
				sessionFile: this.#sessionFile,
				error: error.message,
			});
			this.#notifyPersistenceErrorObservers(error);
		}
		return error;
	}

	#notifyDurableEntries(entries: readonly SessionEntry[] = []): void {
		const notifications = [...this.#pendingDurabilityNotifications, ...entries];
		this.#pendingDurabilityNotifications = [];
		const seen = new Set<string>();
		for (const entry of notifications) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			this.#notifyEntryAppended(entry);
		}
	}

	async #authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		if (this.#released) {
			// Terminal seal: repair would reset the disk tail (escaping the
			// close() serialization) and atomically publish #serializeBody() — after
			// release that truncates, and a revival may already own the file.
			// The original operation error still propagates to the caller.
			logger.warn("Skipped authoritative session repair after terminal release", {
				error: String(operationError),
			});
			return;
		}
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#deferRewriteForPendingDrop()) return;
		const previousDiskTail = this.#diskTail;
		const writer = this.#writer;
		this.#diskEpoch++;
		const epoch = this.#diskEpoch;
		this.#writer = undefined;
		this.#diskTail = Promise.resolve();
		this.#forceFileCreation = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#atomicRewriteFenceEpoch = epoch;
		if (!this.#diskFailure) this.#diskFailure = operationError;
		const repair = Promise.withResolvers<void>();
		this.#authoritativeRepair = repair.promise;
		try {
			await previousDiskTail.catch(() => undefined);
			let closeError: Error | undefined;
			if (writer) {
				try {
					await writer.close();
				} catch (error) {
					closeError = toError(error);
				}
			}
			let drainError: Error | undefined;
			try {
				await this.#storage.drain(this.#sessionFile);
			} catch (error) {
				drainError = toError(error);
			}
			if (writer?.isOpen()) {
				throw this.#latchIndeterminate(operationError, [
					closeError ?? new Error("Failed to close session writer before authoritative repair."),
					...(drainError ? [drainError] : []),
				]);
			}

			do {
				this.#atomicRewriteDirty = false;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Session file disappeared during authoritative repair."),
					]);
				}
				await this.#publishAuthoritativeBody(
					sessionFile,
					operationError,
					() => !this.#released && this.#diskEpoch === epoch,
				);
				if (this.#diskEpoch !== epoch) {
					// A dropSession() of this file fenced the repair off; a failed delete publishes it.
					if (this.#deferRewriteForPendingDrop()) return;
					throw this.#latchIndeterminate(operationError, [
						new Error("Authoritative session repair was superseded before verification."),
					]);
				}
			} while (this.#atomicRewriteDirty);

			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
			this.#clearDiskError();
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) throw error;
			throw this.#latchIndeterminate(operationError, [toError(error)]);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
			if (this.#authoritativeRepair === repair.promise) this.#authoritativeRepair = undefined;
			repair.resolve();
		}
	}

	/**
	 * Publish the current in-memory journal as `sessionFile`'s authoritative
	 * body, tolerating a write whose own acknowledgment failed but that
	 * landed anyway: a readback matching the intended body still counts as
	 * durable. Callers own serialization (the disk queue) and any
	 * `#released`/epoch guard; this only writes and records the published
	 * body through {@link #recordPublish}.
	 */
	async #publishAuthoritativeBody(
		sessionFile: string,
		operationError: Error,
		commitGuard?: () => boolean,
		recoveries = 0,
	): Promise<void> {
		// A subagent transcript whose parent's lease it cannot hold publishes under the parent's sibling.
		if (sessionFile === this.#sessionFile && this.#holdForParentMove()) {
			throw new SessionLeaseLostError(sessionFile, this.#leaseId());
		}
		let target = sessionFile;
		if (sessionFile === this.#sessionFile && this.#sessionOwnedElsewhere()) {
			const sibling = this.#moveOffSessionFile("open-elsewhere");
			// A session that stops instead publishes nothing more, at its old path least of all.
			if (!sibling) throw new SessionLeaseLostError(sessionFile, this.#leaseId());
			target = sibling;
		}
		const body = this.#serializeBody();
		// Storage asks the guard last right before it publishes, so its last answer says whether the body landed.
		let refused = false;
		const guard =
			commitGuard &&
			(() => {
				refused = !commitGuard();
				return !refused;
			});
		const options = { expectedSize: this.#expectedDiskSize, commitGuard: guard };
		try {
			await (this.#storage.writeLinesAtomic
				? this.#storage.writeLinesAtomic(target, body.lines, options)
				: this.#storage.writeTextAtomic(target, Array.from(body.lines).join(""), options));
		} catch (error) {
			// Another holder took the session over: publish in the sibling the loss
			// moved this session to, or move it there now (see #onSessionClaimLost).
			// A session that stops instead publishes nothing more.
			if (error instanceof SessionLeaseLostError && this.#followParentMove()) throw error;
			if (error instanceof SessionLeaseLostError && isSessionExclusive()) {
				this.#moveOffSessionFile("open-elsewhere", { why: "another omp process took its lease over" });
				throw error;
			}
			if (error instanceof SessionLeaseLostError && recoveries < MAX_WRITE_CONFLICT_RECOVERIES) {
				const sibling =
					this.#sessionFile && this.#sessionFile !== target
						? this.#sessionFile
						: this.#moveOffSessionFile("open-elsewhere");
				if (!sibling) throw error;
				return this.#publishAuthoritativeBody(sibling, operationError, commitGuard, recoveries + 1);
			}
			const retryPath = await this.#recoverFromWriteConflict(error, recoveries);
			if (retryPath) return this.#publishAuthoritativeBody(retryPath, operationError, commitGuard, recoveries + 1);
			const recoveryErrors = [toError(error)];
			try {
				await this.#storage.drain(target);
			} catch (drainFailure) {
				recoveryErrors.push(toError(drainFailure));
			}
			try {
				if (!(await this.#bodyMatchesStorage(target, body))) {
					recoveryErrors.push(new Error("Authoritative session repair did not match durable storage."));
					throw this.#latchIndeterminate(operationError, recoveryErrors);
				}
			} catch (readFailure) {
				if (readFailure instanceof SessionPersistenceIndeterminateError) throw readFailure;
				recoveryErrors.push(toError(readFailure));
				throw this.#latchIndeterminate(operationError, recoveryErrors);
			}
		}
		if (refused) return;
		this.#recordPublish(body.stamp, body.bytes, body.oversizedLines, target === this.#sessionFile);
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		const current = this.#writer;
		if (current?.isOpen() && !current.getError()) return current;
		// A writer latches its first failure and rejects every later append, so
		// the append that retries the missing entries needs a fresh one.
		this.#closeWriterEventually();

		const writerFile = this.#sessionFile;
		this.#writer = this.#storage.openWriter(writerFile, {
			flags: "a",
			// Another writer changed the file under a queued append: recover as a write-time conflict does.
			onError: err => {
				if (!this.#recoverQueuedConflict(err, writerFile)) this.#noteDiskFailure(err);
			},
		});
		return this.#writer;
	}

	/**
	 * Bind this manager's writes to its session's `secrets.maskSessionStore` and agent dir: the
	 * binding's `enabled` is read at each write, so a change reaches the next one, and the mask holds
	 * the secrets.yml of its `agentDir`, the one the session's provider obfuscator reads
	 * (`storeMaskingOf`). The code that gives the manager to a session binds it.
	 */
	setStoreMasking(binding: StoreMaskingBinding): void {
		this.#storeMasking = binding;
	}

	/** This manager's store masking binding, or `undefined` while no session bound it ({@link setStoreMasking}). */
	get storeMasking(): StoreMaskingBinding | undefined {
		return this.#storeMasking;
	}

	/**
	 * The mask this manager's writes apply now, or `null` while the setting is off. Off, no source
	 * is read and no masker is built. A manager no session bound reads the setting and the agent dir
	 * of this thread's global settings (the instance `Settings.init` made, or a worker's mirror) and
	 * masks nothing without them. `null`, not `undefined`, so a writer that took one mask for a whole
	 * body can pass "no mask" on without a default parameter asking again.
	 */
	storeMask(): SessionStoreMask | null {
		const bound = this.#storeMasking;
		if (bound) return sessionStoreMaskFor(bound.enabled(), { cwd: this.#cwd, agentDir: bound.agentDir });
		if (!isSettingsInitialized()) return null;
		return settingsStoreMask(Settings.instance, this.#cwd);
	}

	/**
	 * The stored line of `entry`, without its patches when `withoutPatches`: a
	 * cold entry's whole form read back from its record, masked with `mask` in
	 * that form, so the store gets the same bytes whether the entry is cold or
	 * whole ({@link maskSessionEntry}). An `entry_patch` record stays one line,
	 * each of its patches masked by the rules of the entry this manager holds
	 * under its id ({@link maskEntryPatchRecord}).
	 */
	#lineFor(entry: FileEntry, mask = this.storeMask(), withoutPatches = false): string {
		const record = coldEntryForPersistence(entry);
		const read = record ?? entry;
		const source = withoutPatches ? withoutEntryPatches(read) : read;
		const form = record === undefined ? "live" : "record";
		const masked = isEntryPatchRecord(source)
			? maskEntryPatchRecord(source, this.#index, mask, form)
			: maskSessionEntry(source, mask, form);
		return `${persistedEntryText(masked, this.#blobs)}\n`;
	}

	/**
	 * Record that the session file (when `atSessionFile`) now holds the body
	 * serialized as `stamp`, `bytes` long. Only a body serialized from the live
	 * entry array moves the durable frontier; one that also carries every later
	 * change settles pending content and a latched failure.
	 */
	#recordPublish(
		stamp: SessionBodyStamp,
		bytes: number,
		oversizedLines: ReadonlySet<string>,
		atSessionFile = true,
	): void {
		this.#expectedDiskSize = bytes;
		SessionManager.#storeAccepted(this.#storage, this);
		this.#oversizedLines = new Set(oversizedLines);
		if (!atSessionFile || stamp.generation !== this.#entriesGeneration) {
			this.#durable = undefined;
			return;
		}
		this.#durable = durableFrontier(stamp.generation, stamp.entryCount, bytes);
		if (
			stamp.entryCount === this.#entries.length &&
			stamp.revision === this.#bodyRevision &&
			stamp.prefix === this.#titleSlotLine() + this.#lineFor(this.#header)
		) {
			this.#rewriteRequired = false;
			this.#clearDiskError();
		}
	}

	/** Whether storage has accepted every entry: the durable frontier covers the live entry array. */
	#allEntriesHandedToStorage(): boolean {
		const durable = this.#durable;
		return durable?.generation === this.#entriesGeneration && durable.issued === this.#entries.length;
	}

	/** Whether entries that belong in the session file have not all been handed to storage. */
	#hasUnsavedEntries(): boolean {
		return !this.#allEntriesHandedToStorage() && this.#shouldHaveSessionFile();
	}

	/**
	 * Verify a failed acknowledgement chunk by chunk: file bytes exactly, other
	 * storage by size and SHA-256. A full rewrite or delete that races the read
	 * (`SessionReadConflictError`) is read again from its start through
	 * {@link retryRacedRead}, never as one whole-text read; the body is hashed
	 * once, before the first read.
	 */
	async #bodyMatchesStorage(sessionFile: string, body: SessionFileBody): Promise<boolean> {
		if (this.#storage instanceof FileSessionStorage) return fileMatchesLines(sessionFile, body.lines);
		const expected = sessionBodyDigest(body);
		return retryRacedRead(() => chunksMatchBody(transcriptByteChunks(sessionFile, this.#storage), expected));
	}

	/**
	 * Confirm a publish the backend only queued. The manager's durability state
	 * (durable size, current-marking) advances only here, never at queue time:
	 * until the store confirms, the record still describes the last confirmed
	 * publish. A rejected publish is realigned with the size the store actually
	 * holds and latched; the durable frontier still describes the last
	 * confirmed body, so the next append extends that body.
	 *
	 * `onConfirm` runs only once the backend confirms the queued publish, and
	 * only while it is the latest (`generation`): a newer deferred publish owns
	 * the durability record then, and this body is no longer on the backend
	 * (rvEW). A deferred rewrite must neither record the replacement nor mark
	 * the manager current before then (hV-oB): an append racing the
	 * unconfirmed publish would otherwise take the hot path and land a bare
	 * append on a body the backend may still reject, inflating the CAS token
	 * past anything durable. A rewrite racing it queues nothing (see
	 * {@link #unconfirmedPublishPath}); `onConfirm` re-issues the transcript.
	 */
	#confirmDeferredPublish(sessionFile: string, generation: number, onConfirm: () => void): void {
		const confirmed = this.#storage.confirmWrites?.(sessionFile);
		this.#unconfirmedPublishPath = confirmed ? sessionFile : undefined;
		if (!confirmed) return;
		void confirmed
			.then(() => {
				if (generation !== this.#deferredPublishGen) return;
				this.#unconfirmedPublishPath = undefined;
				this.#queuedConflictRecoveries = 0;
				onConfirm();
			})
			.catch(err => {
				// The loss already moved this session and republished it, or stopped it (see #onSessionClaimLost),
				// unless the session was sealed (see #noteDiskFailure).
				if (err instanceof SessionLeaseLostError) {
					if (generation === this.#deferredPublishGen) this.#unconfirmedPublishPath = undefined;
					this.#noteDiskFailure(err);
					return;
				}
				// A publish for a session this manager has since left describes
				// none of the current session's state; it is only reported.
				if (sessionFile === this.#sessionFile) {
					if (generation === this.#deferredPublishGen) this.#unconfirmedPublishPath = undefined;
					// Another writer changed the file: recover as a write-time conflict does.
					if (generation === this.#deferredPublishGen && this.#recoverQueuedConflict(err, sessionFile)) return;
					this.#fileIsCurrent = false;
					try {
						this.#expectedDiskSize = this.#storage.existsSync(sessionFile)
							? this.#storage.statSync(sessionFile).size
							: null;
					} catch {
						// Backend unreadable: leave the record for the next write to re-establish.
					}
				}
				this.#noteDiskFailure(err);
			});
	}

	#titleSlotLine(mask = this.storeMask()): string {
		return serializeTitleSlot(
			maskTitleUpdate(
				{
					title: this.#sessionName,
					source: this.#titleSource,
					updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
				},
				mask,
			),
		);
	}

	/** Serialize the whole file lazily, retaining only one JSONL record at a time. */
	#serializeBody(): SessionFileBody {
		const mask = this.storeMask();
		const titleLine = this.#titleSlotLine(mask);
		const headerLine = this.#lineFor(this.#header, mask);
		const entries = this.#entries;
		const entryCount = entries.length;
		const manager = this;
		let bytes = 0;
		let oversizedLines = new Set<string>();
		const lines: Iterable<string> = {
			*[Symbol.iterator]() {
				bytes = 0;
				oversizedLines = new Set();
				let bytesSinceGc = 0;
				for (const line of [titleLine, headerLine]) {
					const lineBytes = Buffer.byteLength(line, "utf8");
					bytes += lineBytes;
					bytesSinceGc += lineBytes;
					yield line;
				}
				for (let index = 0; index < entryCount; index++) {
					const entry = entries[index]!;
					const line = manager.#lineFor(entry, mask, true);
					const lineBytes = Buffer.byteLength(line, "utf8");
					bytes += lineBytes;
					if (lineBytes > TRANSCRIPT_READ_CAP) oversizedLines.add(entry.id);
					bytesSinceGc += lineBytes;
					yield line;
					if (bytesSinceGc >= 64 * 1024 * 1024) {
						Bun.gc(false);
						bytesSinceGc = 0;
					}
				}
			},
		};
		const stamp: SessionBodyStamp = {
			generation: this.#entriesGeneration,
			entryCount,
			revision: this.#bodyRevision,
			prefix: titleLine + headerLine,
		};
		return {
			lines,
			get bytes() {
				return bytes;
			},
			get oversizedLines() {
				return oversizedLines;
			},
			stamp,
		};
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/**
	 * Live path for concurrent completed appends during {@link moveTo}.
	 * Prefers destination once rename has landed (source gone); otherwise
	 * source. Never invents a path that does not already exist.
	 */
	#liveRelocationWritePath(): string | null {
		const relocating = this.#sessionFileRelocating;
		if (!relocating) return null;
		if (relocating.copying && this.#storage.existsSync(relocating.source)) return relocating.source;
		if (this.#storage.existsSync(relocating.dest)) return relocating.dest;
		if (this.#storage.existsSync(relocating.source)) return relocating.source;
		// Rename in flight with neither path visible (rare cross-device edge):
		// fall back to destination so we do not recreate a vacated source.
		return relocating.dest;
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 *
	 * During {@link moveTo}, writes to the live relocation path (source pre-
	 * rename, destination post-rename) rather than always `#sessionFile`, so
	 * concurrent completed entries are durable without recreating a vacated source.
	 */
	#rewriteSynchronously(): void {
		if (this.#released) return;
		if (!this.#persist || !this.#shouldHaveSessionFile()) return;
		if (this.#deferRewriteForPendingDrop()) return;
		let targetPath = this.#liveRelocationWritePath() ?? this.#sessionFile;
		if (!targetPath) return;
		// This manager's own publish of the path is still unconfirmed: its
		// confirmation re-issues the transcript (see #unconfirmedPublishPath).
		if (targetPath === this.#unconfirmedPublishPath) return;

		// A subagent transcript whose parent's lease it cannot hold publishes under the parent's sibling, once it exists.
		if (this.#holdForParentMove()) return;
		try {
			if (this.#sessionOwnedElsewhere()) {
				const sibling = this.#moveOffSessionFile("open-elsewhere");
				// A session that stops instead writes nothing more, at its old path least of all.
				if (!sibling) return;
				targetPath = sibling;
			}
			let body = this.#serializeBody();
			// This manager's own atomic publish in flight: the store's index already holds its body.
			const atomicInFlight = this.#atomicRewriteFenceEpoch !== null;
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			for (let recoveries = 0; ; recoveries++) {
				try {
					const options = { expectedSize: this.#expectedDiskSize };
					if (this.#storage.writeLinesSync) this.#storage.writeLinesSync(targetPath, body.lines, options);
					else this.#storage.writeTextSync(targetPath, Array.from(body.lines).join(""), options);
					break;
				} catch (err) {
					const retryPath = this.#recoverFromWriteConflictSync(err, recoveries);
					if (retryPath) {
						targetPath = retryPath;
						body = this.#serializeBody();
						continue;
					}
					// A store that publishes later reads nothing synchronously: its recovery reads the
					// stored size again before any write states one, so the refused size is never stated again.
					if (!atomicInFlight && this.#recoverQueuedConflict(err, targetPath)) return;
					throw err;
				}
			}
			if (this.#storage.defersSyncPublish) {
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				// The publish is only queued: record nothing until the backend
				// confirms (hV-oB). A racing rewrite still carries the last
				// confirmed token, so the store's queue-time size check fail-fasts
				// it instead of queueing a second provisional publish behind the
				// unconfirmed one; a racing append finds the store's size past the
				// durable frontier and takes the same path. The success handler
				// below is the single place the replacement becomes durable state.
				// A manager current on the previous body (a branch from a flushed
				// session) must stop being current too, or racing appends take
				// the hot path onto the queued body.
				this.#fileIsCurrent = false;
				const generation = ++this.#deferredPublishGen;
				const { bytes, oversizedLines, stamp } = body;
				this.#confirmDeferredPublish(targetPath, generation, () => {
					// The manager switched to another session since: this body
					// says nothing about the current session's file.
					if (targetPath !== this.#sessionFile && !this.#sessionFileRelocating) return;
					this.#recordPublish(stamp, bytes, oversizedLines, targetPath === this.#sessionFile);
					if (targetPath !== this.#sessionFile) return;
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#hasTitleSlot = true;
					// Entries that raced the unconfirmed publish follow it as one append (rvEW).
					// A sealed manager leaves that write to close().
					if (this.#hasUnsavedEntries()) {
						if (this.#released) this.#closeOwesPublish = true;
						else this.#appendToCurrentSessionFile();
					}
				});
				return;
			}
			this.#recordPublish(body.stamp, body.bytes, body.oversizedLines, targetPath === this.#sessionFile);
			// Only mark the manager current when writing the active session path.
			// Mid-move writes update the live relocation path; `#sessionFile` is
			// still the pre-repoint source until moveTo repoints it.
			if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
				this.#fileIsCurrent = true;
				this.#materializeBreadcrumb();
				this.#hasTitleSlot = true;
			} else {
				// Destination body is current on disk; in-memory still needs a
				// header-cwd rewrite after repoint, but entries are durable.
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#hasTitleSlot = true;
			}
		} catch (err) {
			// The durable frontier still describes the file, so a later append
			// restores whatever this rewrite carried without republishing.
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized after the writer is closed. The fence
	 * is enabled BEFORE `#closeWriterHandle()` and stays active until the last
	 * atomic publish returns, so a sync append landing in the close-yield window
	 * cannot open a fresh writer that the pending replacement would then detach
	 * from the current JSONL path. A `commitGuard` also prevents a superseding
	 * synchronous rewrite from being overwritten by the stale body serialized
	 * before it ran. `queuedRecovery` marks the publish of a queued write's
	 * conflict recovery (see {@link #recoverQueuedConflict}), whose own
	 * conflicts recover the same way. Any other rewrite starts only once a
	 * recovery in flight has read the stored size again, and on a store that
	 * recovers queued conflicts hands its own refusal to that recovery and
	 * settles with it, rejecting when it did not publish; elsewhere a rewrite
	 * that meets a file changed on a deferring store rejects.
	 */
	async #rewriteAtomically(queuedRecovery = false): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#released) return;
		// A publish now would state the size the recovery is reading again.
		if (!queuedRecovery && this.#queuedConflictRecovery) await this.#queuedConflictRecovery;

		const startEpoch = this.#diskEpoch;
		const outcome: FencedRewriteOutcome =
			(await this.#scheduleDiskWork(
				async () => {
					const rewrite = await this.#runFencedAtomicRewrite(startEpoch, queuedRecovery);
					if (rewrite === "published") {
						this.#fileIsCurrent = true;
						this.#materializeBreadcrumb();
						this.#hasTitleSlot = true;
					}
					return rewrite;
				},
				{ epoch: startEpoch },
			)) ?? "skipped";
		switch (outcome) {
			case "published":
				// Entries recorded while it published follow it as one append (see #appendToCurrentSessionFile).
				if (!this.#released && this.#hasUnsavedEntries()) this.#appendToCurrentSessionFile();
				return;
			case "handedOver":
				await this.#queuedConflictRecovery;
				if (this.#rewriteRequired && this.#diskFailure) throw this.#diskFailure;
				return;
			case "skipped":
				return;
		}
	}

	/**
	 * The first write of a new session file (a subagent's transcript, a seance
	 * fork). A store that refuses it leaves the session as a refused append
	 * does: the refusal is latched and reported, the entries stay in memory,
	 * and a later write sends them (this session's next append, or a write
	 * another session lands on the same store, see {@link #storeAccepted}).
	 * One attempt, no wait. Any other error rejects, as before. Resolves to
	 * whether the write landed.
	 */
	async #writeNewSessionFile(): Promise<boolean> {
		this.#forceFileCreation = true;
		try {
			await this.#rewriteAtomically();
			return true;
		} catch (error) {
			if (!isSessionStoreWriteRefusal(error)) throw error;
			this.#rewriteRequired = true;
			return false;
		}
	}

	/**
	 * Fenced atomic-rewrite loop behind `#rewriteAtomically`. Holds
	 * `#atomicRewriteActive` across
	 * the writer close and the full-file replace, and loops on
	 * `#atomicRewriteDirty` so any fenced append that lands during the rewrite
	 * is captured before the task resolves. Skips (`skipped`) when the disk
	 * epoch moved so callers skip current-marking updates; a body that landed
	 * before that change still advances the durable byte record after
	 * readback. A refusal it hands to the queued-conflict recovery is
	 * `handedOver`, not thrown: the caller settles with that recovery.
	 */
	async #runFencedAtomicRewrite(epoch: number, queuedRecovery: boolean): Promise<FencedRewriteOutcome> {
		if (this.#released) return "skipped";
		if (this.#deferRewriteForPendingDrop()) return "skipped";
		this.#atomicRewriteFenceEpoch = epoch;
		let recoveries = 0;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				// This manager's own publish of the file is still unconfirmed:
				// its confirmation settles #expectedDiskSize (or re-issues, which
				// moves the epoch and supersedes this rewrite below).
				const unconfirmed = this.#unconfirmedPublishPath;
				if (unconfirmed !== undefined && unconfirmed === this.#sessionFile) {
					await this.#storage.confirmWrites?.(unconfirmed).catch(() => undefined);
				}
				if (this.#holdForParentMove()) return "skipped";
				if (this.#sessionOwnedElsewhere() && !this.#moveOffSessionFile("open-elsewhere")) return "skipped";
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return "skipped";
				if (this.#diskEpoch !== epoch) return "skipped";
				const body = this.#serializeBody();
				const options = {
					expectedSize: this.#expectedDiskSize,
					commitGuard: () => !this.#released && this.#diskEpoch === epoch,
				};
				try {
					await (this.#storage.writeLinesAtomic
						? this.#storage.writeLinesAtomic(sessionFile, body.lines, options)
						: this.#storage.writeTextAtomic(sessionFile, Array.from(body.lines).join(""), options));
				} catch (error) {
					// Another holder took the session over: the next pass publishes
					// the whole transcript in the sibling it moves to; a session
					// that stops instead publishes nothing more.
					if (error instanceof SessionLeaseLostError && this.#followParentMove()) throw error;
					if (error instanceof SessionLeaseLostError && isSessionExclusive()) {
						this.#moveOffSessionFile("open-elsewhere", { why: "another omp process took its lease over" });
						throw error;
					}
					const claimLost = error instanceof SessionLeaseLostError;
					if (
						(claimLost && recoveries < MAX_WRITE_CONFLICT_RECOVERIES) ||
						(await this.#recoverFromWriteConflict(error, recoveries, queuedRecovery))
					) {
						recoveries++;
						// Publish the whole transcript against what the recovery found on the next pass.
						this.#atomicRewriteDirty = true;
						continue;
					}
					// A store that recovers queued conflicts reads the stored size again in its recovery,
					// which publishes this transcript: a size the store refused published nothing to read back.
					if (!queuedRecovery && this.#recoverQueuedConflict(error, sessionFile)) return "handedOver";
					let landed = false;
					try {
						landed = await this.#bodyMatchesStorage(sessionFile, body);
					} catch {
						// Preserve the publish error when durable state cannot be read back.
					}
					if (!landed) throw error;
					// A body proven durable despite its failed acknowledgement has published, except while an
					// atomic entry batch is open: the body carries the batch's uncommitted entries, so the
					// batch must still see the failure and roll them back. Recording the landed size lets the
					// rollback's repair replace that body instead of adopting the staged entries back as
					// another writer's.
					if (this.#atomicEntryBatch) {
						this.#expectedDiskSize = body.bytes;
						this.#oversizedLines = new Set(body.oversizedLines);
						this.#durable = undefined;
						throw error;
					}
				}
				if (this.#diskEpoch !== epoch) {
					try {
						if (await this.#bodyMatchesStorage(sessionFile, body)) {
							this.#recordPublish(body.stamp, body.bytes, body.oversizedLines);
						}
					} catch {
						// A superseding rewrite owns the durability record when its body cannot be read back.
					}
					return "skipped";
				}
				this.#recordPublish(body.stamp, body.bytes, body.oversizedLines);
			} while (this.#atomicRewriteDirty);
			return "published";
		} finally {
			// Only relinquish the fence if we still own it. A superseding
			// synchronous rewrite (`flushSync` → `#rewriteSynchronously`) may
			// have reset `#diskTail`, scheduled a fresh atomic task at the new
			// epoch, and that task may have taken ownership of the fence while
			// this stale rewrite was still awaiting storage. Clearing it here
			// unconditionally would strand appends during the newer publish.
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (this.#released || !this.#persist || !this.#sessionFile) return;
		// The delete of this file is running: the entry stays past the frontier.
		if (this.#pendingDropOfSessionFile()) return;
		if (this.#atomicEntryBatch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// The first durable entry after draft consumption races the old manager's
		// close-time GC. Serialize that one transition with the GC; once any
		// durable entry exists, later appends cannot satisfy its delete predicate.
		if (
			this.#storage.withSessionFileLockSync &&
			this.#draftOnlySessionCleanupArmed &&
			!isDraftOnlyMetadataEntry(entry) &&
			this.#entries.every(candidate => candidate === entry || isDraftOnlyMetadataEntry(candidate))
		) {
			try {
				this.#storage.withSessionFileLockSync(this.#sessionFile, () => this.#appendToCurrentSessionFile());
			} catch (err) {
				this.#noteDiskFailure(err);
			}
			return;
		}
		this.#appendToCurrentSessionFile();
	}

	/**
	 * Bring the session file up to date with `#entries`. When it still holds
	 * exactly what the durable frontier records, append every entry past the
	 * frontier as one write: usually the entry just recorded, after a failure
	 * also the ones that missed the file, so no successor lands before its
	 * parent. Anything else republishes the whole journal. Never throws: the
	 * core turn loop calls it without try/catch, and a failure is reported and
	 * retried by the next append.
	 */
	#appendToCurrentSessionFile(): void {
		if (this.#pendingDropOfSessionFile()) return;
		// Atomic replacement / move window: do not open a fresh append writer that
		// a Windows EPERM replace could detach from the current JSONL path.
		// - moveTo: write a full body to the live relocation path (source pre-
		//   rename, destination post-rename) so completed entries are durable
		//   without recreating a vacated source.
		// - in-place atomic fence: supersede the pending publish with a
		//   synchronous full-body rewrite; bumping `#diskEpoch` abandons the
		//   in-flight atomic via its `commitGuard`. Not on a store that
		//   publishes later: its index already holds the in-flight body, so a
		//   synchronous rewrite checked against the size before it is refused.
		//   There the entry waits: it follows the rewrite as one append once
		//   the rewrite lands, and a repair publishes again with it.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously();
			return;
		}
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			if (this.#storage.defersSyncPublish) {
				if (this.#authoritativeRepair) this.#atomicRewriteDirty = true;
				return;
			}
			this.#atomicRewriteDirty = true;
			this.#rewriteSynchronously();
			return;
		}
		// Not written yet, a structural change, another live owner, or bytes
		// this manager cannot account for (a publish not yet confirmed, another
		// writer) → rewrite the whole file synchronously, unless a recovery of a
		// refused write is reading the stored size again: a rewrite now would
		// state the refused size, and the recovery's publish carries this entry.
		const durable = this.#frontierMatchingSessionFile();
		if (!durable) {
			if (this.#queuedConflictRecovery) return;
			this.#rewriteSynchronously();
			return;
		}
		this.#appendTailPastFrontier(durable);
	}

	/**
	 * The durable frontier when it describes the live entries and the session
	 * file, which no other live process owns, measures exactly what it issued.
	 * Entries another writer appended past it are adopted first when the
	 * bytes past it are this manager's next entries followed only by them, so
	 * this manager's entries follow them instead of a republish writing them
	 * first.
	 */
	#frontierMatchingSessionFile(): DurableFrontier | undefined {
		const sessionFile = this.#sessionFile;
		const durable = this.#durable;
		if (!sessionFile || durable?.generation !== this.#entriesGeneration || this.#sessionOwnedElsewhere())
			return undefined;
		let storedSize: number;
		try {
			storedSize = this.#storage.statSync(sessionFile).size;
		} catch {
			// Absent or unreadable: nothing on disk is known.
			return undefined;
		}
		if (storedSize === durable.issuedSize) return durable;
		if (storedSize < durable.issuedSize || !this.#adoptEntriesAppendedPastFrontier(sessionFile, durable, storedSize))
			return undefined;
		const adopted = this.#durable;
		return adopted?.issuedSize === storedSize ? adopted : undefined;
	}

	/**
	 * Append every entry past `durable`'s issued position to the session file,
	 * which holds exactly what the frontier issued. Never throws; a failure is
	 * latched and the entries stay unsaved.
	 */
	#appendTailPastFrontier(durable: DurableFrontier): void {
		const start = durable.issued;
		const end = this.#entries.length;
		if (start === end) return;
		try {
			const writer = this.#appendWriter();
			// Whole entries, at most SESSION_TAIL_APPEND_CHUNK_BYTES per append (an
			// entry larger than that goes alone), so a long backlog never becomes
			// one transcript-sized string; every chunk that lands moves the frontier.
			let line: string | undefined;
			let lineBytes = 0;
			for (let from = start; from < end;) {
				let chunk = "";
				let bytes = 0;
				let to = from;
				for (; to < end; to++) {
					if (line === undefined) {
						const entry = this.#entries[to]!;
						line = this.#lineFor(entry);
						lineBytes = Buffer.byteLength(line, "utf8");
						if (lineBytes > TRANSCRIPT_READ_CAP) this.#oversizedLines.add(entry.id);
					}
					if (bytes > 0 && bytes + lineBytes > SESSION_TAIL_APPEND_CHUNK_BYTES) break;
					chunk += line;
					bytes += lineBytes;
					line = undefined;
				}
				this.#appendTailChunk(writer, durable, from, to, chunk, bytes);
				from = to;
			}
		} catch (err) {
			this.#noteDiskFailure(err);
		}
	}

	/**
	 * Append `chunk`, the `bytes` of serialized entries `[start, end)` that
	 * follow the frontier's issued position, and advance the frontier over
	 * them: at once on storage that applies the bytes before returning, on
	 * confirmation on a deferring backend. Throws when the writer refuses it.
	 */
	#appendTailChunk(
		writer: SessionStorageWriter,
		durable: DurableFrontier,
		start: number,
		end: number,
		chunk: string,
		bytes: number,
	): void {
		// File writers apply the bytes to the OS page cache before returning,
		// so a software crash right after still keeps them.
		if (writer.appendSync && !this.#storage.defersSyncPublish) {
			writer.appendSync(chunk);
			durable.confirmed = durable.issued = end;
			durable.confirmedSize = durable.issuedSize = durable.issuedSize + bytes;
			this.#expectedDiskSize = durable.confirmedSize;
			if (end === this.#entries.length && !this.#rewriteRequired) this.#clearDiskError();
			SessionManager.#storeAccepted(this.#storage, this);
			return;
		}
		// A backend that only queues the publish (indexed) confirms later: the
		// issued position lets the next append extend past these entries, and
		// the durable size advances only on confirmation, so a lost publish
		// never leaves the CAS token describing bytes the store never accepted.
		if (writer.appendSync) writer.appendSync(chunk);
		const appendedTo = this.#sessionFile ?? "";
		const confirmation = writer.appendSync ? writer.flush() : writer.append(chunk);
		const startSize = durable.issuedSize;
		durable.issued = end;
		durable.issuedSize += bytes;
		const settled = confirmation.then(
			() => {
				if (this.#durable !== durable) return;
				// Confirmations can settle out of order; one that lands past
				// the confirmed position waits until the gap before it fills.
				durable.confirmedAhead.set(start, { end, bytes });
				for (let next = durable.confirmedAhead.get(durable.confirmed); next;) {
					durable.confirmedAhead.delete(durable.confirmed);
					durable.confirmed = next.end;
					durable.confirmedSize += next.bytes;
					next = durable.confirmedAhead.get(durable.confirmed);
				}
				// A later chunk's rejection may have rewound the issued position
				// before this one confirmed; what the store confirmed is issued.
				if (durable.issued < durable.confirmed) {
					durable.issued = durable.confirmed;
					durable.issuedSize = durable.confirmedSize;
				}
				this.#expectedDiskSize = durable.confirmedSize;
				if (durable.confirmed === this.#entries.length && !this.#rewriteRequired) this.#clearDiskError();
				SessionManager.#storeAccepted(this.#storage, this);
			},
			err => {
				// The store keeps every append queued before this one and
				// fails every append queued after it, so this chunk and later
				// ones are re-sent; an earlier chunk that confirmed ahead of a
				// still-pending one stays confirmed.
				if (this.#durable === durable && durable.issued > start) {
					durable.issued = start;
					durable.issuedSize = startSize;
					for (const key of durable.confirmedAhead.keys()) if (key >= start) durable.confirmedAhead.delete(key);
				}
				// Another writer changed the file under the append: recover as a write-time conflict does.
				if (this.#recoverQueuedConflict(err, appendedTo)) return;
				this.#noteDiskFailure(err);
			},
		);
		this.#pendingAppendConfirmations.add(settled);
		void settled.finally(() => this.#pendingAppendConfirmations.delete(settled));
	}

	/**
	 * Persist a title change. Its `title_change` entry is the new leaf, so it
	 * goes through the ordinary append path; the fixed title slot is content,
	 * rewritten in place when it can be and otherwise carried by the next full
	 * rewrite.
	 */
	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#appendToSessionFile(entry);
		if (!this.#shouldHaveSessionFile()) return;
		const drop = this.#pendingDropOfSessionFile();
		if (drop) {
			drop.titleHeld = true;
			return;
		}
		// A batch's or a move's own full rewrite publishes the slot, and while an
		// entry is missing from storage a full rewrite would only fail again.
		if (this.#atomicEntryBatch || this.#sessionFileRelocating || this.#hasUnsavedEntries()) {
			this.#rewriteRequired = true;
			return;
		}
		if (!this.#hasTitleSlot) {
			this.#rewriteRequired = true;
			await this.#rewriteAtomically();
			return;
		}
		await this.#writeTitleSlot(update);
	}

	/**
	 * Write `update` into the title slot in place on the disk queue. When that
	 * fails, rewrite the whole file as any full rewrite does
	 * ({@link #rewriteAtomically}), once that disk work settled: it waits for a
	 * recovery in flight, the entries recorded meanwhile follow it as one
	 * append, and it settles with a recovery it hands its refusal to. A write
	 * that moved the disk epoch meanwhile (a synchronous rewrite, a repair)
	 * already published the header, and with it the title.
	 */
	async #writeTitleSlot(update: SessionTitleUpdate): Promise<void> {
		const epoch = this.#diskEpoch;
		const slotFailed = await this.#scheduleDiskWork(
			async () => {
				const sessionFile = this.#sessionFile;
				if (this.#released || !sessionFile) return false;
				const drop = this.#pendingDropOfSessionFile();
				if (drop) {
					drop.titleHeld = true;
					return false;
				}
				try {
					await this.#storage.updateSessionTitle(sessionFile, maskTitleUpdate(update, this.storeMask()));
					return false;
				} catch {
					this.#rewriteRequired = true;
					return true;
				}
			},
			{ epoch },
		);
		if (slotFailed && this.#diskEpoch === epoch) await this.#rewriteAtomically();
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("collab entry hook failed", { error: String(err) });
			}
		}
	}

	#resetToNewSession(options?: NewSessionOptions, forcedSessionFile?: string): string | undefined {
		const previousSessionFile = this.#sessionFile;
		this.#diskTail = Promise.resolve();
		this.#forgetMoveOffs();
		this.#clearDiskError();
		this.#expectedDiskSize = null;
		this.#oversizedLines = new Set();
		this.#reconcileSessionDirForFallback();
		if (options?.sessionDir && this.#persist) {
			this.#sessionDir = path.resolve(options.sessionDir);
			this.#storage.ensureDirSync(this.#sessionDir);
		}
		this.#sessionId = options?.sessionId ?? mintSessionId();
		this.#taskSiblingCandidate = undefined;
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;

		const timestamp = nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
			taskPromptCacheKey: options?.taskPromptCacheKey,
		};
		const workspace = normalizeSessionWorkspace({
			cwd: this.#cwd,
			directories: options?.additionalDirectories ?? [],
		});
		this.#additionalDirectories = additionalWorkspaceDirectories(workspace);
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = [...this.#additionalDirectories];
		}
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#index.clear();
		this.#resetColdCut(undefined, false);
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#loadedMalformedRecords = 0;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, true);
		} else {
			this.#sessionFile = undefined;
		}

		this.#notifySessionFileChanged(previousSessionFile);
		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[]): void {
		this.#adoptHeader(header);
		this.#entries = entries;
		this.#loadRevision++;
		warnRepairedUsage(normalizeLoadedUsage(entries));
		this.#reindexEntries();
	}

	/** Index `#entries` again after they changed as a whole; the cut is computed again at the next context build. */
	#reindexEntries(): void {
		this.#index.rebuild(this.#entries);
		this.#coldCutStale = true;
	}

	/** Take the session's identity and title from a loaded `header`. */
	#adoptHeader(header: SessionHeader): void {
		this.#header = header;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = header.timestamp;
	}

	/**
	 * Start over with `store` as the cold store: the cut is computed again, for
	 * no model yet, at the next context build when `stale`, else once a trigger
	 * marks it stale.
	 */
	#resetColdCut(store: ColdEntryStore | undefined, stale: boolean): void {
		this.#adoptColdStore(store);
		this.#coldCutModel = undefined;
		this.#coldCutStale = stale;
	}

	/** Make `store` the one new cold entries go to, holding it in place of the previous one. */
	#adoptColdStore(store: ColdEntryStore | undefined): void {
		if (store === this.#coldStore) return;
		this.#coldStore?.release(false);
		this.#closeLeftColdStore = false;
		store?.retain();
		this.#coldStore = store;
	}

	/**
	 * The store new cold entries go to, created on first use: over a file, or
	 * kept compressed in memory where none can be made.
	 */
	#openColdStore(): ColdEntryStore {
		if (this.#coldStore) return this.#coldStore;
		const store = ColdEntryStore.open(this.#blobs);
		this.#adoptColdStore(store);
		return store;
	}

	/**
	 * Whether a convert pass can make an entry cold: false once the store
	 * closed, when {@link convertToColdEntry} keeps every entry whole.
	 */
	#coldStoreTakesRecords(): boolean {
		return this.#coldStore?.writable ?? true;
	}

	/**
	 * Bring every entry in line with `boundary`: in the `hydrate` phase the
	 * entries it keeps whole become whole again, in the `convert` phase the
	 * others become cold.
	 */
	#applyColdBoundary(boundary: ColdBoundary, phase: "hydrate" | "convert"): void {
		const entries = this.#entries;
		if (phase === "convert") {
			convertColdEntries(entries, boundary, () => this.#openColdStore());
			return;
		}
		hydrateKeptEntries(entries, boundary);
	}

	/**
	 * The boundary to apply before the next context build, or undefined when
	 * the last one still holds. A trigger (load, compaction, branch move) marks
	 * it stale. A build that names a model whose provider or API differs from
	 * the model the cut was computed for adopts that model, whose readable
	 * compaction can start the context earlier, and computes the cut again: the
	 * first build for a model switched to reads no cold entry. A build that only
	 * measures (`measureOnly`) changes neither. The cut stays stale until the
	 * build applies it ({@link buildSessionContext}).
	 */
	#staleColdBoundary(options: SessionContextBuildOptions | undefined): ColdBoundary | undefined {
		if (!this.#coldStoreEnabled || options?.measureOnly) return undefined;
		const model = options?.transcript ? undefined : options?.model;
		const current = this.#coldCutModel;
		if (model && (current === undefined || model.provider !== current.provider || model.api !== current.api)) {
			this.#coldCutModel = model;
			this.#coldCutStale = true;
		}
		if (!this.#coldCutStale) return undefined;
		return coldBoundary(this.#entries, this.#index.branchView(), this.#coldCutModel);
	}

	#freshEntryFields(): { id: string; parentId: string | null; timestamp: string; runtime: RuntimeIdentity } {
		return {
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
		};
	}

	/** Move the leaf; when it moves, the cut is computed again at the next context build. */
	#setLeaf(id: string | null): void {
		if (this.#index.leafId() !== id) this.#coldCutStale = true;
		this.#index.setLeaf(id);
		const batch = this.#atomicEntryBatch;
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = id;
		}
	}

	#recordEntry(entry: SessionEntry): void {
		if (this.#released) {
			logger.warn("Dropped session entry appended after terminal release", { type: entry.type });
			// A flush or close of a stopped session reports it unsaved (see #stopLeftEntriesUnsaved).
			if (this.#exclusiveStop) this.#exclusiveStop.dropped = true;
			return;
		}
		if (entry.type === "message" && entry.message.role === "assistant" && normalizeAssistantUsage(entry.message)) {
			logger.warn("Assistant message recorded with incomplete usage", { id: entry.id });
		}
		this.#entries.push(entry);
		const leafBefore = this.#index.leafId();
		this.#index.insert(entry);
		// An insert that selects an off-branch entry moves the leaf as `#setLeaf` does.
		if (this.#index.leafId() !== leafBefore && entry.parentId !== leafBefore) this.#coldCutStale = true;
		// A compaction moves the cut once the agent's context is rebuilt from it
		// (the next context build). A model change moves it at the first build
		// for the new model, which adopts that model.
		if (entry.type === "compaction") this.#coldCutStale = true;
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			// An off-branch entry replays to the leaf it captured, not to itself.
			batch.externalLeafId = sessionEntryLeafId(entry);
		}
		this.#appendToSessionFile(entry);
		if (batch) batch.deferredNotifications.push(entry);
		else this.#notifyEntryAppended(entry);
	}

	#rollbackAtomicEntryBatch(batch: AtomicEntryBatch): void {
		const retainedAncestor = (id: string | null): string | null => {
			const seen = new Set<string>();
			while (id && batch.entryIds.has(id) && !seen.has(id)) {
				seen.add(id);
				id = this.#index.get(id)?.parentId ?? null;
			}
			return id;
		};
		const retained = this.#entries.filter(entry => !batch.entryIds.has(entry.id));
		for (const entry of retained) {
			entry.parentId = retainedAncestor(entry.parentId);
			// An off-branch entry captured a staged leaf; keep it pointing at a surviving entry.
			if (typeof entry.activeLeafId === "string") {
				entry.activeLeafId = retainedAncestor(entry.activeLeafId);
			}
		}
		const restoredLeaf = retainedAncestor(batch.externalLeafChanged ? batch.externalLeafId : batch.preBatchLeafId);
		// The rolled-back entries never reached the file (a batch defers its
		// appends), so a frontier over pre-batch entries still holds for the
		// retained array, and later turns keep appending past it.
		const durable = this.#durable;
		const keepsFrontier =
			durable?.generation === this.#entriesGeneration &&
			this.#entries.slice(0, durable.issued).every(entry => !batch.entryIds.has(entry.id));
		this.#entries = retained;
		if (durable && keepsFrontier) durable.generation = this.#entriesGeneration;
		this.#reindexEntries();
		this.#index.setLeaf(restoredLeaf && this.#index.has(restoredLeaf) ? restoredLeaf : null);
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsSync(markerPath);
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#artifactManagerForSession(): ArtifactManagerApi | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		const pendingCopy = this.#pendingArtifactCopy;
		this.#artifactManager = new ArtifactManager(
			sessionFile.slice(0, -JSONL_SUFFIX_LENGTH),
			pendingCopy?.sessionFile === sessionFile ? pendingCopy.done : undefined,
			this.getSeanceSourceArtifactsDir() ?? undefined,
		);
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of Array.from(this.#sessionNameChangedCallbacks)) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	/** Puts a binary blob into the blob store and returns the blob reference. */
	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	/** Synchronous variant of {@link putBlob} for rebuild-only render paths. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	captureState(): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			expectedDiskSize: this.#expectedDiskSize,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			durable:
				this.#durable?.generation === this.#entriesGeneration && this.#durable.issued === this.#durable.confirmed
					? { count: this.#durable.confirmed, size: this.#durable.confirmedSize }
					: undefined,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			fallbackRuntimeOnly: this.#fallbackRuntimeOnly,
			taskSiblingCandidate: this.#taskSiblingCandidate,
			// Entries are snapshotted by reference (switch/reload replaces the
			// array wholesale). The header is cloned: moveTo mutates it in place
			// (cwd, additionalDirectories), so a by-reference capture would let
			// a rollback observe the move it is undoing.
			header: structuredClone(this.#header),
			entries: [...this.#entries],
			oversizedLines: new Set(this.#oversizedLines),
			coldStore: this.#coldStore,
			coldCutModel: this.#coldCutModel,
		};
	}

	/**
	 * Create an independent manager for the current logical session and branch.
	 * The clone shares the storage backend but owns its entry index and writer, so
	 * callers can finish session-owned work after this manager switches elsewhere.
	 * Set `persist` false when the original session is intentionally being dropped.
	 */
	cloneCurrentSession(options?: { persist?: boolean }): SessionManager {
		const persist = options?.persist ?? this.#persist;
		const clone = new SessionManager(this.#cwd, this.#sessionDir, persist, this.#storage, this.#coldStoreEnabled);
		clone.#storeMasking = this.#storeMasking;
		clone.#suppressBreadcrumb = true;
		clone.restoreState(this.captureState());
		if (!persist) {
			clone.#sessionFile = undefined;
			clone.#expectedDiskSize = null;
			clone.#oversizedLines = new Set();
			clone.#fileIsCurrent = false;
			clone.#rewriteRequired = false;
			clone.#durable = undefined;
			clone.#forceFileCreation = false;
		} else if (this.#sessionClaim?.release) {
			// A clone of the manager that holds this journal's claim is that
			// writer handing the journal over, not a second writer on it:
			// `BashRunner.beginSessionTransition` clones just before the host
			// moves to another session, and `newSession` does the same. Without
			// this the clone's first append is refused by the one-writer rule and
			// the detached work goes to a sibling file nobody reads — and on a
			// backend whose full rewrites fail, nowhere at all.
			//
			// Its OWN slot, never a copy of this manager's claim record: two
			// managers sharing one release closure would each disarm the other,
			// so the first of them to switch away or close would leave the
			// journal reading `free` while the other still appends to it, and
			// that is exactly the live-journal-offered-as-parked state this
			// change exists to end.
			clone.#writerOwned = this.#writerOwned;
			clone.#claimSession({ handover: true });
			// Remember which journal went where, so coming back to this session
			// while the clone still writes it is not refused as a second writer
			// ({@link #reclaimsJournalHandedToClone}).
			if (clone.#sessionClaim?.release && clone.#sessionFile) {
				// Entries are read lazily, so drop the ones whose clone is gone here
				// rather than let a long-lived manager accumulate one per session it
				// ever cloned.
				for (const [id, handed] of this.#journalsHandedToClones) {
					if (handed.clone.deref() === undefined) this.#journalsHandedToClones.delete(id);
				}
				this.#journalsHandedToClones.set(clone.#sessionId, {
					sessionFile: clone.#sessionFile,
					clone: new WeakRef(clone),
				});
			}
		}
		return clone;
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		const previousSessionFile = this.#sessionFile;
		this.#closeWriterEventually();
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#expectedDiskSize = snapshot.expectedDiskSize;
		this.#oversizedLines = new Set(snapshot.oversizedLines);
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#fallbackRuntimeOnly = snapshot.fallbackRuntimeOnly;
		// A completed moveTo drops the stash, so a rollback restores it here.
		this.#taskSiblingCandidate = snapshot.taskSiblingCandidate;
		this.#applyEntries(snapshot.header, [...snapshot.entries]);
		// The copy holds the same entries in the same order, so the file still
		// holds the snapshot's durable prefix of it.
		this.#durable = snapshot.durable
			? durableFrontier(this.#entriesGeneration, snapshot.durable.count, snapshot.durable.size)
			: undefined;
		this.#adoptColdStore(snapshot.coldStore);
		// A rollback leaves the agent's context the one built for this model (a
		// switch restores it, a move keeps it), so the cut `#applyEntries` marked
		// stale, recomputed at the next build or recool, keeps whole what that
		// context holds.
		this.#coldCutModel = snapshot.coldCutModel;
		this.#additionalDirectories = snapshot.header.additionalDirectories ?? [];
		this.#sessionName = snapshot.sessionName;
		// A rolled-back switch gives up the claim it took on the session it opened.
		const claim = this.#sessionClaim;
		if (claim && claim.sessionId !== this.#sessionId) {
			claim.release?.();
			this.#sessionClaim = undefined;
		}

		this.#titleSource = snapshot.titleSource;
		this.#titleUpdatedAt = snapshot.titleUpdatedAt;
		this.#hasTitleSlot = snapshot.hasTitleSlot;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
		// The restored session is the one this manager's agent loop now writes.
		if (this.#writerOwned) this.#claimSession();
		this.#notifySessionFileChanged(previousSessionFile);
	}

	/**
	 * Undo a {@link moveTo} using a {@link captureState} snapshot: rename the
	 * session and artifacts back into the captured bucket, then restore the
	 * captured metadata (cwd, header, additionalDirectories) and the stashed
	 * sibling candidate the forward move dropped. The captured header is
	 * persisted after relocation so a fresh open of the source session sees the
	 * pre-move metadata, including workspace roots the move filtered out.
	 * Rollbacks must not re-enter forward-move hooks, so this bypasses
	 * AgentSession entirely. If the rename-back itself fails, the
	 * manager stays pointed at the actual moved file (restoring the snapshot
	 * would split the transcript across a recreated source and the stranded
	 * target) and the error names where the session file actually lives.
	 */
	async rollbackMove(snapshot: SessionManagerStateSnapshot): Promise<void> {
		try {
			const targetSessionDir = snapshot.sessionFile ? path.dirname(snapshot.sessionFile) : snapshot.sessionDir;
			await this.moveTo(snapshot.cwd, targetSessionDir);
		} catch (error) {
			const movedFile = this.getSessionFile();
			throw new Error(
				`could not relocate the session back to ${snapshot.sessionDir} (${error instanceof Error ? error.message : String(error)}); the session file remains at ${movedFile}`,
			);
		}
		// The inverse moveTo already rewrote the restored source file and left
		// #expectedDiskSize describing that on-disk body. restoreState resets it
		// to the pre-move snapshot size, so capture the post-relocation size and
		// reapply it — otherwise the final rewrite would compare a stale size and
		// reject an otherwise successful rollback.
		const relocatedDiskSize = this.#expectedDiskSize;
		const relocatedOversizedLines = this.#oversizedLines;
		this.restoreState(snapshot);
		// Persist the captured header so disk and memory agree after a fresh open.
		if (this.#persist && this.#sessionFile) {
			this.#expectedDiskSize = relocatedDiskSize;
			this.#oversizedLines = relocatedOversizedLines;
			this.#durable = undefined;
			this.#forceFileCreation = true;
			this.#rewriteRequired = true;
			await this.#rewriteAtomically();
		}
	}
	/**
	 * Switch to a different session file (resume / branch). With `claim`, on
	 * a storage that confirms claims (SQL storage), it first takes the
	 * session's lease, waiting up to `claim.waitMs` for another holder's to go
	 * or expire, and only then loads it and takes its id: while it waits this
	 * manager still reports the session it had. A session another process
	 * still holds then moves to a sibling with a new id in the same step (or,
	 * under `OMP_SESSION_EXCLUSIVE=1`, stops), so the held id is never this
	 * manager's. A session that stopped under `OMP_SESSION_EXCLUSIVE=1`, also
	 * during this switch, opens no other: the switch rejects with
	 * {@link SessionExclusiveStopError} and records no session as left.
	 */
	async setSessionFile(
		sessionFile: string,
		options?: { claim?: { waitMs?: number; onWait?: (holder: SessionClaimHolder) => void } },
	): Promise<void> {
		if (this.#exclusiveStop) await this.#refuseSwitchAfterStop(this.#exclusiveStop);
		const previousSessionFile = this.#sessionFile;
		const switched: { left?: { id: string; file: string } } = {};
		await this.#setSessionFileClaiming(sessionFile, options?.claim, switched);
		const left = switched.left;
		if (left && this.#sessionId !== left.id) this.#recordLeftSession(left.id, left.file);
		this.#notifySessionFileChanged(previousSessionFile);
	}

	async #setSessionFileClaiming(
		sessionFile: string,
		claim: { waitMs?: number; onWait?: (holder: SessionClaimHolder) => void } | undefined,
		switched: { left?: { id: string; file: string } },
	): Promise<void> {
		const storage = this.#storage;
		if (!claim || !storage.acquireSessionClaim || !this.#persist) {
			return this.#setSessionFile(sessionFile, { switched });
		}
		const resolved = path.resolve(sessionFile);
		// An append to this file still running (a stopped work pool's discards, `appendCustomEntriesToFile`) writes
		// as the journal's writer: let it land before this switch takes the writer claim, or the two meet, and the
		// append's session or this one moves to a sibling.
		await SessionManager.#pendingAppends.get(resolved);
		const sessionId = await readSessionHeaderId(resolved, storage);
		if (!sessionId) return this.#setSessionFile(resolved, { switched });
		// A reload of the session this manager holds keeps its own claim through the load: a write in between (a work
		// pool's record; a reload cancels no jobs) takes that claim, not the switch's handover slot, which is the only
		// one left once the manager gives its own back and which a write's claim cannot share. The adoption then lets
		// the switch's duplicate slot go.
		const rereads = this.#rereadsItsOwnSession(sessionId, resolved);
		let holder: SessionClaimHolder | undefined;
		let release: (() => void) | null;
		for (;;) {
			holder = undefined;
			release = await storage.acquireSessionClaim(sessionId, resolved, {
				waitMs: claim.waitMs,
				onWait: found => {
					holder = found;
					claim.onWait?.(found);
				},
				writer: true,
				handover: rereads || this.#reclaimsJournalHandedToClone(sessionId, resolved),
				onLost: () => this.#onSessionClaimLost(sessionId),
			});
			// An append that started while the claim was taken would meet it: give the claim back, let the append
			// land, and take it again. A refused claim holds no writer slot and waits no more: the adoption moves off.
			const pending = SessionManager.#pendingAppends.get(resolved);
			if (!pending || !release) break;
			release();
			await pending;
		}
		// The claim is this call's until the load adopts it with the id: every other way out lets it go, a throw, a
		// file that holds another session by then, or one emptied since its header was read (a new session starts
		// there, under an id of its own).
		const claimed = { sessionId, release, holder, adopted: false };
		try {
			await this.#setSessionFile(resolved, { claimed, switched, keepClaim: rereads });
		} finally {
			if (!claimed.adopted) release?.();
		}
	}

	async #setSessionFile(
		sessionFile: string,
		options?: Pick<TranscriptLoadOptions, "throwIfMissing" | "preloaded"> & {
			newSession?: NewSessionOptions;
			keepClaim?: boolean;
			/**
			 * Set by `#open`, which waited for the file's pending {@link appendCustomEntriesToFile} writes before its
			 * load, or, for that writer's own load, must not: the load then does not wait for them.
			 */
			appendsAwaited?: boolean;
			/**
			 * The lease {@link setSessionFile} took before it loaded the file: adopted with the id, in one step, and
			 * marked `adopted`; {@link setSessionFile} releases it otherwise.
			 */
			claimed?: {
				sessionId: string;
				release: (() => void) | null;
				holder: SessionClaimHolder | undefined;
				adopted: boolean;
			};
			/**
			 * Set to the session the switch leaves, read once the drain and the claim release are over (see
			 * {@link setSessionFile}): a write the drain runs, or a lease loss while the claim waited, can move the
			 * session to a sibling, and that sibling is the session left.
			 */
			switched?: { left?: { id: string; file: string } };
			/**
			 * {@link open}'s choice of workspace: the cwd of the header it probed, and the session dir
			 * and launch cwd it chose from. A transcript replaced since records its own, which then chooses.
			 */
			opened?: { probedCwd: string | undefined; sessionDir: string | undefined; initialCwd: string | undefined };
		},
	): Promise<void> {
		// An append to this file that is still running (a stopped work pool's discards) lands first,
		// so the session loads it and its next entry follows it. `#open` waits before its own load.
		if (!options?.appendsAwaited) await SessionManager.#pendingAppends.get(path.resolve(sessionFile));
		await this.#drainWrites();
		// A queued write's conflict the drain met starts a recovery (#recoverQueuedConflict): it keeps the other
		// writer's entries and publishes the transcript again, or moves this session to a sibling. Let it finish, as
		// flush() does, before the switch gives up the claim and reads the session it leaves: its entries are then
		// published and its sibling is the session left. Bound: one wait per recovery of a chain, which ends by its
		// (MAX_WRITE_CONFLICT_RECOVERIES + 1)th, as that one moves the session off as contested. A recovery still
		// running past the bound reports what it could not publish (#recoverQueuedConflict).
		for (let pass = 0; this.#queuedConflictRecovery && pass <= MAX_WRITE_CONFLICT_RECOVERIES; pass++) {
			await this.#queuedConflictRecovery;
		}
		// A write the drain or a recovery was the first to see refused can stop the session: it stays the session the
		// stop judges, and the switch leaves nothing.
		if (this.#exclusiveStop) await this.#refuseSwitchAfterStop(this.#exclusiveStop);
		// What the drain left: a write while the switch loads shows as new disk work (see the load below).
		let drainedTail = this.#diskTail;
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;
		// A switch gives up the previous file. Opening claims nothing: the first
		// write does, or claimOpenedSession(), so inspecting a session never counts
		// as owning it. A reread of the same session under its claim keeps it. A
		// manager a running agent loop owns re-claims the new file below.
		if (!options?.keepClaim) {
			this.#sessionClaim?.release?.();
			this.#sessionClaim = undefined;
			this.#forgetMoveOffs();
		}
		const switching = options?.switched !== undefined;
		if (options?.switched) {
			// Until the load below sets the new file, a write lands in the session left, and a move off it (a write's,
			// a lease loss's, a follow's or a recovery's) records the sibling it makes there (see #activeSwitch).
			this.#activeSwitch = options.switched;
			// A transcript adopted under a refused claim that no follow has forked or moved yet was never this
			// manager's (see #heldAdoptionFile).
			if (this.#sessionFile && this.#heldAdoptionFile !== this.#sessionFile) {
				options.switched.left = { id: this.#sessionId, file: this.#sessionFile };
			}
		}

		let resolvedSessionFile: string;
		let loaded: LoadedTranscript | undefined;
		let headerCwd: string | undefined;
		let headerCwdEnterable = false;
		try {
			// `gc --archive` leaves cold transcripts gzipped outside the sessions
			// tree. Bring one back to its own path before anything reads or appends
			// to it: the writer appends raw JSONL, so a `.jsonl.gz` must never
			// become this manager's session file.
			const requestedFile = path.resolve(sessionFile);
			resolvedSessionFile = isArchivedSessionPath(requestedFile)
				? (await restoreArchivedSession(requestedFile)).sessionPath
				: requestedFile;
			loaded = await this.#loadTranscript(resolvedSessionFile, {
				throwIfMissing: options?.throwIfMissing,
				preloaded: options?.preloaded,
			});
			if (loaded.invalidHeader) {
				throw new Error(
					`Cannot resume session "${resolvedSessionFile}": the session header is missing or malformed. The file was not modified.`,
				);
			}
			// Every await of the load runs before the new file is set, so the file, the id and the entries change in
			// one step: a write in between would claim the session left's id at the new file's path. The load itself
			// migrates the entries, applies their prune and patch records, and gives the blobs they name their
			// reference rows (see #loadTranscript).
			// Another writer can replace the transcript between `open`'s header probe and this load, which reads it
			// again: the workspace then comes from the header loaded here (#openWorkspace, set with the new file
			// below), so whether its cwd can be entered is read even when that cwd is this manager's.
			const opened = options?.opened;
			const reprobed = opened && loaded.header?.cwd !== opened.probedCwd ? opened : undefined;
			const recordedCwd = loaded.header?.cwd;
			if (recordedCwd) {
				headerCwd = path.resolve(recordedCwd);
				headerCwdEnterable =
					(reprobed !== undefined || headerCwd !== path.resolve(this.#cwd)) &&
					(await directoryIsEnterable(headerCwd));
			}
			// A write while the switch loaded went to the session left, or to the sibling a move off it made: let it
			// land there, and a recovery it started finish, before the new file is set, as the drain above did for the
			// writes before. A follow is not waited for: one that moves now is recorded (#activeSwitch), and once the
			// new file is set it moves nothing (#switchedSince). Bound: GAP_DRAIN_PASSES drains. A write's bytes go to
			// the writer of the file it was made at when it is made (#appendToCurrentSessionFile), so a write after the
			// last drain still lands in the session left; only its confirmation is not waited for.
			for (
				let pass = 0;
				pass < GAP_DRAIN_PASSES &&
				(this.#diskTail !== drainedTail ||
					this.#queuedConflictRecovery ||
					this.#pendingAppendConfirmations.size > 0);
				pass++
			) {
				await this.#drainWrites();
				for (let wait = 0; this.#queuedConflictRecovery && wait <= MAX_WRITE_CONFLICT_RECOVERIES; wait++) {
					await this.#queuedConflictRecovery;
				}
				drainedTail = this.#diskTail;
			}
			// A write in the session left that the gap drains were the first to see refused can stop the session too.
			if (this.#exclusiveStop) await this.#refuseSwitchAfterStop(this.#exclusiveStop);
			// A writer a write opened since then is the session left's too: its appends go there.
			if (this.#writer) this.#closeWriterEventually();
			if (reprobed) {
				const workspace = SessionManager.#openWorkspace(
					recordedCwd,
					headerCwdEnterable,
					requestedFile,
					reprobed.sessionDir,
					reprobed.initialCwd,
					this.#storage,
				);
				this.#cwd = workspace.cwd;
				this.#sessionDir = path.resolve(workspace.sessionDir);
			}
			// `SessionManager.open` derived the session dir from the archive path.
			// Follow the transcript home, or /new and /branch would write there.
			if (resolvedSessionFile !== requestedFile && this.#sessionDir === path.dirname(requestedFile)) {
				this.#sessionDir = path.dirname(resolvedSessionFile);
			}
			this.#sessionFile = resolvedSessionFile;
			if (switching) {
				this.#switchGeneration++;
				this.#heldAdoptionFile = undefined;
			}
		} catch (error) {
			// A load this switch does not adopt closes the store of older entry bodies it opened, now, not at a collection.
			loaded?.coldStore?.close();
			throw error;
		} finally {
			if (switching) {
				this.#activeSwitch = undefined;
			}
		}
		const sourceSize = loaded.sourceSize;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const { header, titleSlot } = loaded;
		if (!header) {
			if (options?.throwIfMissing) {
				throw new Error(
					`Cannot resume session "${resolvedSessionFile}": the session file holds no entries. The file was not modified.`,
				);
			}
			// Explicit but empty/missing path (e.g. a subagent's transcript):
			// start fresh but keep the requested path and materialize the header
			// immediately.
			this.#resetToNewSession(options?.newSession, resolvedSessionFile);
			this.#expectedDiskSize = sourceSize;
			if (await this.#writeNewSessionFile()) this.#fileIsCurrent = true;
			return;
		}

		// Adopt the loaded session's working directory only when it is verifiably
		// accessible. Sessions live in a dir keyed by their cwd, so resuming a
		// session from another project must re-point cwd/sessionDir at that
		// project — but a deleted OR permission-blocked directory (macOS TCC
		// denial) must not be adopted: callers without a cwd-change callback
		// (extension UI, RPC) would otherwise track a directory the process
		// cannot enter. Keep the current cwd so the session stays where the
		// user already is.
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && headerCwdEnterable) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#fallbackRuntimeOnly = false;
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		} else if (headerCwd && headerCwd !== path.resolve(this.#cwd)) {
			// Header cwd not enterable: keep runtime cwd but mark fallback
			// so workspace changes stay runtime-only until the transcript
			// is relocated.
			this.#fallbackRuntimeOnly = true;
		} else {
			this.#fallbackRuntimeOnly = false;
		}

		this.#adoptLoadedTranscript(header, loaded);
		this.#expectedDiskSize = sourceSize;
		this.#oversizedLines = loaded.oversizedLines;
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = loaded.migrated || loaded.malformedRecords > 0 || loaded.sanitized;
		// Migration assigns ids and parents the file lacks, and a torn record
		// would swallow the next append, so either republishes first.
		this.#durable =
			loaded.migrated || loaded.malformedRecords > 0 || sourceSize === null
				? undefined
				: durableFrontier(this.#entriesGeneration, this.#entries.length, sourceSize);
		// Storage holds every entry just read, whether or not the frontier can prove it (see #stopLeftEntriesUnsaved).
		this.#loadedEntries = {
			file: resolvedSessionFile,
			generation: this.#entriesGeneration,
			count: this.#entries.length,
		};
		this.#loadedMalformedRecords = loaded.malformedRecords;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		if (loaded.sanitized) this.#bodyRevision++;
		// Adopt a lease taken before the load with the id, before any await:
		// nothing observes the id without its claim, or a held id at all.
		const claimed = options?.claimed;
		if (claimed && claimed.sessionId === this.#sessionId) {
			claimed.adopted = true;
			// A write while the switch loaded landed in the session left and claimed it again, or a move off it then
			// claimed the sibling it made: that claim is another id's, not the adopted one. Let it go, or nothing does.
			const prior = this.#sessionClaim;
			if (options?.keepClaim && prior?.sessionId === claimed.sessionId && prior.release && claimed.release) {
				// A reload kept the manager's own claim through the load: the switch's slot duplicates it.
				claimed.release();
			} else {
				if (prior && prior.sessionId !== claimed.sessionId) prior.release?.();
				this.#sessionClaim = { sessionId: claimed.sessionId, release: claimed.release ?? undefined };
			}
			// The held session (or a subagent transcript under a held parent) was never this manager's: the switch leaves
			// the one it had (setSessionFile), so neither the follow's fork nor the move-off records it as left, and a
			// switch away before the follow forks or moves the transcript does not either.
			if (!claimed.release) {
				if (this.#followParentMove({ recordLeft: false })) this.#heldAdoptionFile = this.#sessionFile;
				else {
					this.#moveOffSessionFile(
						"open-elsewhere",
						{ holder: claimed.holder, why: "another omp process holds its lease" },
						undefined,
						{ recordLeft: false },
					);
				}
			}
		}
		// The agent loop that owns this manager now writes this journal: claim it
		// here rather than at its first append, so a roster scan cannot offer the
		// adopted transcript as revivable in between.
		if (this.#writerOwned) this.#claimSession();
	}

	/** Make a {@link LoadedTranscript} this manager's entries, under `header`. */
	#adoptLoadedTranscript(header: SessionHeader, loaded: LoadedTranscript): void {
		this.#adoptHeader(header);
		this.#entries = loaded.entries;
		this.#loadRevision++;
		this.#index = loaded.index;
		this.#resetColdCut(loaded.coldStore, false);
		warnRepairedUsage(loaded.repairedUsage);
		SessionManager.#releaseLoadedTranscript(loaded);
	}

	/**
	 * Empty a {@link LoadedTranscript} its manager took over. The promise that
	 * delivered it can stay referenced by an engine cache after the load, and
	 * would keep every entry alive after the manager released them.
	 */
	static #releaseLoadedTranscript(loaded: LoadedTranscript): void {
		loaded.entries = [];
		loaded.index = new SessionEntryIndex();
		loaded.coldStore = undefined;
	}

	/**
	 * Stream the session at `filePath` into memory one entry at a time, so the
	 * transcript is never held whole: each entry is migrated, its usage
	 * completed, adapted for a fork and indexed. When the stream reaches a
	 * compaction, the entries before its kept start that are not kept whole by
	 * kind are written to a new cold store; the entries since stay whole until
	 * a later compaction or the end of the stream decides, so a session with no
	 * compaction and no other branch writes nothing. After the stream the cut
	 * is computed for the leaf, the entries it keeps whole are made whole
	 * again, stale replay metadata is stripped (after any load-time pass, so
	 * from what the passes left), every other entry still whole goes to the
	 * store (an entry off the leaf's path, or one a pass or the stripping made
	 * whole), and the whole entries' blob references are resolved.
	 *
	 * A full rewrite or delete that replaced the transcript mid-read
	 * (`SessionReadConflictError`) makes the whole load run again from its
	 * start, as often as {@link retryRacedRead} allows before the error
	 * surfaces: each pass builds its entries and its cold store afresh, and a
	 * pass that throws closes the store it opened, so nothing of it reaches
	 * the next one.
	 */
	#loadTranscript(filePath: string, options: TranscriptLoadOptions): Promise<LoadedTranscript> {
		return retryRacedRead(async () => {
			// A current-version file whose first entry has no id may predate ids
			// altogether; only a pass over every entry tells (see migrateToCurrentVersion).
			// Each pass learns it afresh: what a raced read found of the transcript
			// says nothing about the one read next.
			let unindexed: boolean | undefined;
			for (;;) {
				const loaded = await this.#streamTranscript(filePath, options, unindexed);
				if (loaded) return loaded;
				unindexed = await this.#transcriptIsUnindexed(filePath, options);
			}
		});
	}

	/** Visit the transcript at `filePath`, or the copy of it `options.preloaded` already holds. */
	async #visitTranscript(
		filePath: string,
		options: TranscriptLoadOptions,
		visit: (entry: FileEntry) => void | boolean,
	): Promise<SessionFileVisit> {
		if (options.preloaded) return visitLoadedSession(options.preloaded, visit);
		return visitSessionFile(filePath, this.#storage, visit, { throwIfMissing: options.throwIfMissing });
	}

	/** Whether `filePath` has non-header entries and none of them has an id. */
	async #transcriptIsUnindexed(filePath: string, options: TranscriptLoadOptions): Promise<boolean> {
		const count = new UnindexedCount();
		await this.#visitTranscript(filePath, options, entry => !count.add(entry));
		return count.unindexed;
	}

	/**
	 * One streamed pass of {@link #loadTranscript}. Returns undefined, having
	 * kept nothing, when `unindexed` is still unknown and the file needs it.
	 * A known `unindexed` that this pass's own body contradicts came from a
	 * body another writer replaced between the passes: the pass then fails as
	 * a raced read (`SessionReadConflictError`), so the load runs again. Against
	 * `unindexed: true` it fails at the first entry with an id.
	 */
	async #streamTranscript(
		filePath: string,
		options: TranscriptLoadOptions,
		unindexed: boolean | undefined,
	): Promise<LoadedTranscript | undefined> {
		const fork = options.fork;
		let header: SessionHeader | undefined;
		let migration: SessionEntryMigration | undefined;
		let needsIndexCheck = false;
		// What this pass's body says of a known `unindexed`; an unknown one is not counted.
		const count = unindexed === undefined ? undefined : new UnindexedCount();
		let sanitized = false;
		let repairedUsage = 0;
		// Ids of the entries whose line holds TRANSCRIPT_READ_CAP bytes or more, measured on each entry as read,
		// before a migration changes it: no line of a file under the cap reaches it, so a smaller one is not measured.
		const oversizedLines = new Set<string>();
		let transcriptBytes = options.preloaded?.sourceSize ?? 0;
		if (!options.preloaded) {
			try {
				transcriptBytes = this.#storage.statSync(filePath).size;
			} catch {
				// A missing path: the visit below applies the missing-file rules.
			}
		}
		const measureLines = transcriptBytes >= TRANSCRIPT_READ_CAP;
		// The entries live only in `intake`, emptied before this returns: an
		// async function keeps its locals in a scope that its closures (and an
		// engine call-site cache holding the last visitor) can keep alive, and
		// that scope must not keep the transcript alive once the manager lets go.
		const interner = new LoadedValueInterner();
		// The blobs every entry names, cold ones too, by hash with their MIME types (see the end of the pass); only
		// the blob tier's pass reads them, so without a tier none are collected.
		const named = this.#blobs.tier ? new Map<string, string | undefined>() : undefined;
		const intake: {
			entries: SessionEntry[];
			index: SessionEntryIndex;
			store: ColdEntryStore | undefined;
			/** Entries before this index were offered to the store by a compaction's kept start. */
			cooled: number;
			/** Entries carrying replay metadata a resume strips, sanitized once the load-time passes ran. */
			unsanitized: SessionEntry[];
		} = {
			entries: [],
			index: new SessionEntryIndex(),
			store: undefined,
			cooled: 0,
			unsanitized: [],
		};
		const openStore = () => {
			intake.store ??= ColdEntryStore.open(this.#blobs);
			return intake.store;
		};
		const startMigration = (current: SessionHeader): SessionEntryMigration => {
			const started = new SessionEntryMigration(current, unindexed ?? false);
			started.migrate(current);
			return started;
		};
		try {
			const visited = await this.#visitTranscript(filePath, options, raw => {
				if (!header) {
					header = raw as SessionHeader;
					return;
				}
				if (!migration) {
					if (
						unindexed === undefined &&
						(header.version ?? 1) >= 2 &&
						(raw.type === "session" || lacksEntryId(raw))
					) {
						needsIndexCheck = true;
						return false;
					}
					migration = startMigration(header);
				}
				// An entry with an id already contradicts a body without ids.
				if (count?.add(raw) && unindexed) throw new SessionReadConflictError(filePath);
				if (measureLines && raw.type !== "session" && typeof raw.id === "string" && isOversizedEntry(raw)) {
					oversizedLines.add(raw.id);
				}
				migration.migrate(raw);
				if (raw.type === "session" && fork) return;
				let entry = raw as SessionEntry;
				if (
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					normalizeAssistantUsage(entry.message)
				) {
					repairedUsage++;
				}
				if (fork?.resetInheritedCost) SessionManager.#resetInheritedUsageCost(entry);
				if (fork?.seance && entry.type === "session_init") entry = SessionManager.#neutralizedSessionInit(entry);
				if (
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message) !== entry.message
				) {
					intake.unsanitized.push(entry);
				}
				interner.intern(entry, entry.parentId === null ? undefined : intake.index.get(entry.parentId));
				intake.entries.push(entry);
				intake.index.insert(entry);
				// Before the entry can go cold: the blobs it names, which the open writes back and references.
				if (named) collectBlobRefNames(entry, named);
				if (this.#coldStoreEnabled && entry.type === "compaction") {
					const keptStart = streamedKeptStart(intake.entries, entry, intake.cooled, id => intake.index.has(id));
					for (; intake.cooled < keptStart; intake.cooled++) {
						const older = intake.entries[intake.cooled]!;
						if (coldKindOf(older).wholeByKind) continue;
						convertToColdEntry(older, openStore, { imagesExternalized: true, paced: true });
					}
				}
			});
			if (needsIndexCheck) {
				intake.store?.close();
				return undefined;
			}
			if (count && count.unindexed !== unindexed) {
				throw new SessionReadConflictError(filePath);
			}
			if (header && !migration) migration = startMigration(header);
			intake.index.settleLeaf(intake.entries);
			const boundary = this.#coldStoreEnabled
				? coldBoundary(intake.entries, intake.index.branchView(), undefined)
				: undefined;
			if (boundary) hydrateKeptEntries(intake.entries, boundary, { resolveBlobs: false });
			// Prune records, then patch records, apply after migration, to targets
			// made whole without their images (wholeTargetsOf); convertColdEntries
			// below returns those to the store.
			const targets = wholeTargetsOf(intake.index);
			applyToolResultPrunes(intake.entries, targets);
			applyEntryPatches(intake.entries, targets);
			// Sanitize after the load-time passes, as a load of the whole transcript
			// does, since a pass can change what an entry replays: every whole entry,
			// and each entry the stream found replay metadata on, made whole for it.
			for (const entry of intake.unsanitized) hydrateColdEntry(entry, { resolveBlobs: false });
			intake.unsanitized = [];
			for (const entry of intake.entries) {
				if (!isColdEntry(entry) && SessionManager.#sanitizeLoadedEntry(entry)) sanitized = true;
			}
			// Put in the store every entry the boundary leaves cold that the load
			// holds whole: one the stream kept whole after the newest compaction's
			// kept start that the leaf's path leaves, and one a load-time pass
			// (writing through an accessor) or the replay-metadata stripping made
			// whole, which goes back with the values it now holds.
			if (boundary) convertColdEntries(intake.entries, boundary, openStore, { paced: true });
			// The blobs this session names get its reference rows, so another session's delete keeps them: those
			// of every entry the stream read (`named`), the ones now cold included. A fork's come with its own write.
			// The active snapcompact compaction is looked up among every entry, since a cold entry (a patch record)
			// can lie on its branch, by tree fields a cold entry keeps; only the whole entries are walked for blobs.
			await resolveBlobRefsInEntries(
				intake.entries.filter(entry => !isColdEntry(entry)),
				this.#blobs,
				fork ? undefined : filePath,
				{ collected: named, transcript: intake.entries },
			);
			if (intake.store && !intake.entries.some(isColdEntry)) {
				intake.store.close();
				intake.store = undefined;
			}
			const loaded: LoadedTranscript = {
				...visited,
				header: visited.invalidHeader ? undefined : header,
				entries: intake.entries,
				index: intake.index,
				coldStore: intake.store,
				migrated: migration?.needed ?? false,
				sanitized,
				repairedUsage,
				oversizedLines,
			};
			intake.entries = [];
			intake.index = new SessionEntryIndex();
			intake.store = undefined;
			return loaded;
		} catch (error) {
			intake.store?.close();
			throw error;
		}
	}

	/**
	 * Start a new session and persist its header before returning, except for a
	 * `drop` (/delete) successor.
	 *
	 * The durable empty boundary prevents a later process on another terminal
	 * from selecting the previous conversation as the most recent session. The
	 * drop path does not need it: the fresh terminal breadcrumb already pins
	 * this terminal to the successor, and if deleting the predecessor failed,
	 * that surviving non-empty transcript is the correct resume target.
	 * Materializing the successor there would only leave a zero-turn stub
	 * behind when the user quits, so it keeps the ordinary lazy gate and writes
	 * once it has content.
	 *
	 * Entries the previous session's file is missing are appended first. When
	 * that fails, this rejects with the failure and switches nothing; calling
	 * again for the same unsaved entries switches anyway, abandoning them.
	 */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		const refused = this.#refusedSessionSwitch;
		const abandoning = refused?.generation === this.#entriesGeneration && refused.count === this.#entries.length;
		// Only a tail past a valid frontier is healed here: a journal awaiting
		// a republish (or a deferred publish's confirmation) switches as before.
		const unsaved =
			!abandoning &&
			this.#persist &&
			this.#sessionFile !== undefined &&
			this.#durable?.generation === this.#entriesGeneration &&
			this.#hasUnsavedEntries();
		if (unsaved) await this.#healMissingEntriesAndSettle();
		let failure: unknown;
		try {
			await this.#drainAndCloseWriter();
		} catch (error) {
			failure = error;
		}
		const unsavedAfterDrain =
			!abandoning &&
			this.#persist &&
			this.#sessionFile !== undefined &&
			this.#durable?.generation === this.#entriesGeneration &&
			this.#hasUnsavedEntries();
		if ((unsaved || unsavedAfterDrain) && this.#hasUnsavedEntries()) {
			this.#refusedSessionSwitch = { generation: this.#entriesGeneration, count: this.#entries.length };
			throw failure ?? this.#diskFailure ?? new Error("Session entries could not be saved before switching.");
		}
		if (failure !== undefined && !abandoning) throw failure;
		this.#refusedSessionSwitch = undefined;
		this.#recordLeftSession(this.#sessionId, this.#sessionFile);
		const sessionFile = this.#resetToNewSession(options);
		if (options?.drop !== true) await this.ensureOnDisk();
		return sessionFile;
	}

	/**
	 * Delete a session file and its artifact directory. ENOENT is treated as
	 * success. For the current session file:
	 * - From the moment this is called, nothing this manager starts writes
	 *   that path: no append, heal, rewrite or title write. A publish already
	 *   on the disk queue lands before the delete; an authoritative repair
	 *   already in flight is abandoned and waited for.
	 *   Entries recorded meanwhile stay in memory; rewrites and titles wait.
	 * - The file counts as gone when the delete succeeds, or when it fails and
	 *   a stat of the journal then fails with ENOENT (its artifact cleanup, or
	 *   an indexed backend's remove of the other paths, can fail after the
	 *   journal was deleted). Any other stat result counts as
	 *   present. Once gone, the file's persistence ends: the entries stay in
	 *   memory, this manager never writes that path again, and the next
	 *   {@link newSession} or {@link setSessionFile} starts from scratch. A
	 *   failed delete still rethrows.
	 * - When the delete fails with the journal present, the session keeps
	 *   saving as before, by append alone where full rewrites cannot land
	 *   (a read-only directory). A title set meanwhile is written to the
	 *   title slot in place; a full rewrite runs only for an edit or abandoned
	 *   publish that waited, or when the slot write fails. The next append,
	 *   `flush()` or `close()` appends the entries recorded meanwhile and any
	 *   that missed the journal before the drop, or reports the failure. On
	 *   indexed storage the whole journal is instead published once, checked
	 *   against the stored size, so a row the failed remove deleted is
	 *   reported, never recreated without its header. It runs before this
	 *   returns when any entry is unsaved (a turn or title recorded meanwhile,
	 *   or one that missed the journal before the drop), since `flush()`,
	 *   `close()` and a switch only append; otherwise it is the next write.
	 *   The next
	 *   {@link newSession} for the same entries switches without appending
	 *   the ones the file is missing, so it writes nothing to it.
	 */
	async dropSession(sessionPath: string): Promise<void> {
		const sessionFile = this.#sessionFile;
		if (sessionFile === undefined || path.resolve(sessionFile) !== path.resolve(sessionPath)) {
			await this.#drainAndCloseWriter();
			try {
				await SessionManager.deleteSessionFile(sessionPath, this.#storage);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}
		const drop: PendingDrop = {
			sessionFile,
			deferredRewrite: false,
			titleHeld: false,
			settled: Promise.withResolvers<void>(),
		};
		this.#pendingDrop = drop;
		try {
			// An authoritative repair runs off the disk queue and could publish
			// after the unlink: abandon it through its commit guard, owe its body
			// instead, and wait for it below. A publish on the disk queue already
			// past its pending-drop check finishes before the writer drain, so
			// before the delete.
			if (this.#authoritativeRepair) {
				this.#diskEpoch++;
				this.#deferRewriteForPendingDrop();
			}
			await this.#authoritativeRepair;
			try {
				await this.#drainAndCloseWriter();
			} catch {
				// A failed append's error, raised again on close, concerns only the
				// file being deleted.
			}
			let failure: unknown;
			try {
				await this.#storage.deleteSessionWithArtifacts(sessionPath);
			} catch (err) {
				if (!isEnoent(err)) failure = err;
			}
			if (failure === undefined) {
				this.#endDroppedSessionFile(sessionFile);
				return;
			}
			// The journal can be gone even though the delete failed (its artifact
			// cleanup failed after the unlink): that ends persistence too.
			if (this.#sessionFileGone(sessionFile)) {
				this.#endDroppedSessionFile(sessionFile);
				throw failure;
			}
			this.#pendingDrop = undefined;
			if (this.#sessionFile === sessionFile) {
				// An indexed remove can fail after deleting the row while its
				// readback fails too, so the row may be gone: publish the whole
				// journal once, size-checked, which reports a missing row where an
				// append would recreate it without a header. flush(), close() and a
				// switch only append past the frontier, so when any entry is
				// unsaved that publish runs now; otherwise the next write is it.
				if (this.#storage.defersSyncPublish) {
					if (!this.#allEntriesHandedToStorage()) drop.deferredRewrite = true;
					this.#durable = undefined;
				}
				// The caller asked to discard these entries: /delete's newSession()
				// must not append the ones the file is missing.
				this.#refusedSessionSwitch = { generation: this.#entriesGeneration, count: this.#entries.length };
				// The file stays: publish what the delete held back. A title alone
				// goes through the title slot; anything else needs a full rewrite.
				if (drop.deferredRewrite || (drop.titleHeld && !this.#hasTitleSlot)) {
					this.#rewriteRequired = true;
					await this.#rewriteAtomically().catch(() => undefined);
				} else if (drop.titleHeld) {
					await this.#writeTitleSlot({
						title: this.#sessionName,
						source: this.#titleSource,
						updatedAt: this.#titleUpdatedAt,
					}).catch(() => undefined);
				}
			}
			throw failure;
		} finally {
			if (this.#pendingDrop === drop) this.#pendingDrop = undefined;
			drop.settled.resolve();
		}
	}

	/** Whether `sessionFile` is known to be absent: its stat fails with ENOENT. Any other stat error counts as present. */
	#sessionFileGone(sessionFile: string): boolean {
		try {
			this.#storage.statSync(sessionFile);
			return false;
		} catch (error) {
			return isEnoent(error);
		}
	}

	/** End the persistence of `sessionFile`, which {@link dropSession} deleted, when it is still the current file. */
	#endDroppedSessionFile(sessionFile: string): void {
		if (this.#sessionFile !== sessionFile) return;
		this.#sessionFile = undefined;
		this.#durable = undefined;
		this.#refusedSessionSwitch = undefined;
		this.#clearDiskError();
		this.#expectedDiskSize = null;
		this.#oversizedLines = new Set();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#sessionClaim?.release?.();
		this.#sessionClaim = undefined;
	}

	/** The pending {@link dropSession} deleting the current session file, if one is running. */
	#pendingDropOfSessionFile(): PendingDrop | undefined {
		const drop = this.#pendingDrop;
		return drop !== undefined && drop.sessionFile === this.#sessionFile ? drop : undefined;
	}

	/**
	 * While a {@link dropSession} deletes the current session file, record that
	 * a full rewrite is owed instead of writing, and return `true`.
	 */
	#deferRewriteForPendingDrop(): boolean {
		const drop = this.#pendingDropOfSessionFile();
		if (!drop) return false;
		drop.deferredRewrite = true;
		this.#rewriteRequired = true;
		return true;
	}

	/**
	 * Delete the session file at `sessionPath` and its artifacts from `storage`,
	 * refusing while another live omp process holds the session. On a storage
	 * that confirms claims (`acquireSessionClaim`, SQL storage) the claim is
	 * taken before anything is deleted and held until the delete has run, so
	 * the delete meets the write fence like any other write; a claim this
	 * process holds already is shared. Other storages delete as before. ENOENT
	 * propagates.
	 */
	static async deleteSessionFile(
		sessionPath: string,
		storage: SessionStorage = defaultSessionStorage(),
	): Promise<void> {
		let release = (): void => {};
		if (storage.acquireSessionClaim) {
			const sessionId = await readSessionHeaderId(sessionPath, storage);
			if (sessionId) {
				const claim = await storage.acquireSessionClaim(sessionId, sessionPath);
				if (!claim) {
					throw new Error(
						`Cannot delete session "${sessionPath}": another live omp process writes it. Nothing was deleted.`,
					);
				}
				release = claim;
			}
		}
		try {
			await storage.deleteSessionWithArtifacts(sessionPath);
		} finally {
			release();
		}
	}

	/**
	 * Fork the current session into a new file with the same entries.
	 * @returns the old and new session file paths, or undefined when not persisting.
	 */
	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		await this.#drainAndCloseWriter();
		this.#clearDiskError();
		this.#reconcileSessionDirForFallback();
		// Read once the drain is over: a write it ran can move the session to a sibling, which is the session
		// this fork leaves and copies.
		const oldSessionFile = this.#sessionFile;
		if (!oldSessionFile) return undefined;
		const parentSessionId = this.#sessionId;
		this.#recordLeftSession(parentSessionId, oldSessionFile);

		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#taskSiblingCandidate = undefined;
		this.#sessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		this.#expectedDiskSize = null;
		this.#oversizedLines = new Set();
		this.#durable = undefined;
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
			parentSession: parentSessionId,
			providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(this.#header),
			taskPromptCacheKey: this.#header.taskPromptCacheKey,
		};
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#draftOnlySessionCleanupArmed = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		await this.#rewriteAtomically();
		this.#notifySessionFileChanged(oldSessionFile);
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	/**
	 * Move a session transcript through the storage that holds it. A file
	 * backend cannot rename across devices, so it falls back to a copy; a
	 * `"move"` records that in the relocation, so appends that land while the
	 * copy runs reach the destination too. On a storage with a refusing rename
	 * neither a `"move"` nor a `"rollback"` replaces: a destination (or, for a
	 * rollback, an old path) another client wrote since fails with `EEXIST`
	 * and changes neither path.
	 */
	async #moveSessionFile(from: string, to: string, mode: "move" | "rollback"): Promise<void> {
		try {
			if (this.#storage.renameNoReplace) await this.#storage.renameNoReplace(from, to);
			else await this.#storage.rename(from, to);
		} catch (error) {
			if (!(this.#storage instanceof FileSessionStorage) || !isFsError(error) || error.code !== "EXDEV") throw error;
			if (mode === "move" && this.#sessionFileRelocating) this.#sessionFileRelocating.copying = true;
			await moveFileAcrossDevices(from, to);
		}
	}

	/** Move the session to a new working directory. */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const previousSessionFile = this.#sessionFile;
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));
		const expectedSessionFile = this.#sessionFile
			? path.join(nextSessionDir, path.basename(this.#sessionFile))
			: undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			!this.#fallbackRuntimeOnly &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir)) &&
			(!expectedSessionFile || path.resolve(this.#sessionFile!) === path.resolve(expectedSessionFile))
		) {
			return;
		}

		// A move writes both paths: it must neither move a session another live
		// omp process writes nor replace a destination one writes. Checked before
		// relocation starts (appends still go to the source) and before any
		// directory is created, so a refusal touches nothing.
		let destination: { id: string; release: () => void } | undefined;
		// Hold the lease of the session in the destination file until the move
		// settles, so its owner cannot start writing mid-move. Our own id is
		// refcounted, never contended.
		const claimDestination = async (file: string): Promise<void> => {
			// A shared store (`session.storage: sql`) may hold a session another
			// client committed at the destination since this one loaded its view.
			await this.#storage.refresh?.();
			const id = await readSessionHeaderId(file, this.#storage);
			if (id === undefined || id === destination?.id) return;
			// A storage without claims (file storage always has them; SQL storage
			// only when built with `claims`) cannot tell whether another process
			// writes the session there, not even a copy of this session, so it
			// never moves onto a session at all.
			if (!this.#storage.claimSession) {
				throw new SessionMoveRefusedError(
					id === this.#sessionId
						? `Cannot move session to "${file}": it already holds a copy of this session. Nothing was moved.`
						: `Cannot move session to "${file}": it holds another session. Nothing was moved.`,
				);
			}
			// SQL storage answers its claim only once the database did, so wait for it here.
			const release = this.#storage.acquireSessionClaim
				? await this.#storage.acquireSessionClaim(id, file)
				: this.#storage.claimSession(id, file);
			if (release === null) {
				throw new SessionMoveRefusedError(
					`Cannot move session to "${file}": another live omp process writes the session there. Nothing was moved.`,
				);
			}
			destination?.release();
			destination = { id, release };
		};
		// The file at the source path must still be this session: if another
		// session replaced it, moving it would carry that session away from its
		// writer, whose lease our id never covered.
		const assertSourceIsOurs = async (file: string): Promise<void> => {
			const id = await readSessionHeaderId(file, this.#storage);
			if (id !== undefined && id !== this.#sessionId) {
				throw new SessionMoveRefusedError(
					`Cannot move session "${file}": the file now holds a different session. Nothing was moved.`,
				);
			}
		};
		if (this.#persist && this.#sessionFile && this.#storage.claimSession) {
			// Every persisted move rewrites the journal (at least its header cwd),
			// even when the path stays the same.
			await assertSourceIsOurs(this.#sessionFile);
			// SQL storage answers a claim only once the database has; wait for it.
			if (this.#storage.acquireSessionClaim) await this.#holdClaim();
			else this.#claimSession();
			if (this.#sessionClaim?.release === undefined) {
				throw new SessionMoveRefusedError(
					`Cannot move session "${this.#sessionFile}": another live omp process writes it. Nothing was moved.`,
				);
			}
			if (expectedSessionFile && path.resolve(this.#sessionFile) !== path.resolve(expectedSessionFile)) {
				await claimDestination(expectedSessionFile);
			}
		}

		let sessionFileExisted = false;
		// Track source+dest for concurrent completed appends during relocation
		// (see `#sessionFileRelocating`). Existence of either path decides the
		// live write target — not a `#diskEpoch` bump, which would cancel any
		// disk task already queued at the current epoch (e.g. a header-only
		// `ensureOnDisk()` materializing rewrite) before the drain below runs it.
		if (this.#persist && this.#sessionFile) {
			const source = this.#sessionFile;
			const dest = path.join(nextSessionDir, path.basename(source));
			this.#sessionFileRelocating = { source, dest };
		}

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				await this.#drainAndCloseWriter();
				this.#clearDiskError();

				const oldSessionFile = this.#sessionFile;
				const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile);
				const newArtifactsDir = artifactsDirectoryFor(newSessionFile);
				const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
				const artifactPathChanged =
					oldArtifactsDir !== null &&
					newArtifactsDir !== null &&
					path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
				sessionFileExisted = this.#storage.existsSync(oldSessionFile);
				let sessionMoved = false;
				let artifactsRenamed = false;
				let movedTranscripts: TranscriptPlacement[] = [];

				try {
					if (sessionFileExisted && sessionPathChanged) {
						// The drain awaited: re-check that both paths still hold the
						// sessions we checked.
						await assertSourceIsOurs(oldSessionFile);
						await claimDestination(newSessionFile);
						await this.#moveSessionFile(oldSessionFile, newSessionFile, "move");
						sessionMoved = true;
						// The claim names the file its writer appends to, and the
						// journal is at the new path from here on. Point it there
						// before the artifact directory is relocated below — an
						// awaited rename a scan can land in the middle of — and
						// without giving the lease up for an instant, which a move
						// must not do. A scan then still reads this journal as the
						// one a session here is running, not as a copy of it.
						if (this.#sessionClaim?.release) {
							this.#storage.retargetWriterClaim?.(this.#sessionClaim.sessionId, newSessionFile);
						}
					}

					if (artifactPathChanged) {
						let artifactStat: fs.Stats | null = null;
						try {
							artifactStat = await fs.promises.stat(oldArtifactsDir);
						} catch (err) {
							if (!isEnoent(err)) throw err;
						}
						if (artifactStat?.isDirectory()) {
							// Artifacts are local files whatever holds the transcript, and a
							// key-indexed storage creates no directory for the session.
							await fs.promises.mkdir(path.dirname(newArtifactsDir), { recursive: true });
							// Only a whole-directory rename can be undone by renaming back;
							// a merge leaves the rollback below to the session file alone.
							artifactsRenamed =
								(await relocateArtifactsDirectory(oldArtifactsDir, newArtifactsDir)) === "renamed";
						}
						// What the directory move did not carry: under `session.storage:
						// sql` the subagent transcripts and the unsent draft are rows keyed
						// under the old directory, whatever the disk holds. Under file
						// storage the directory move placed everything but transcripts
						// whose name was taken, and it decides which tool artifacts stay.
						movedTranscripts = await moveTranscriptTree(
							this.#storage,
							oldArtifactsDir,
							newArtifactsDir,
							this.#storage instanceof FileSessionStorage ? "*.jsonl" : "*",
						);
					}
				} catch (err) {
					if (movedTranscripts.length > 0) {
						try {
							await restoreTranscripts(this.#storage, movedTranscripts);
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move subagent transcripts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}
					if (artifactsRenamed && oldArtifactsDir && newArtifactsDir) {
						try {
							await fs.promises.rename(newArtifactsDir, oldArtifactsDir);
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move artifacts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					if (sessionMoved) {
						try {
							await this.#moveSessionFile(newSessionFile, oldSessionFile, "rollback");
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move session file and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					throw this.#storage.renameNoReplace ? refusedByTakenKey(err) : err;
				}

				if (sessionFileExisted && sessionPathChanged) {
					this.#header.previousSessionFiles = [
						...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(oldSessionFile)]),
					];
				}

				this.#sessionFile = newSessionFile;
				// The freshness expectation must describe the NEW path. A successful
				// rename carried this manager's tracked bytes to `newSessionFile`, so
				// #expectedDiskSize still applies; without a rename the destination
				// holds no bytes this manager wrote, so a recreate-from-memory must
				// publish against an absent file rather than a stale size.
				if (sessionPathChanged && !sessionMoved) {
					this.#expectedDiskSize = null;
					this.#oversizedLines = new Set();
					this.#durable = undefined;
				}
				this.#artifactManager = null;
				this.#artifactManagerSessionFile = null;
				// Idempotent with the retarget above, which runs as the journal is
				// renamed; this one also covers a path change with no rename to do
				// (a session with nothing on disk yet).
				if (this.#sessionClaim?.release) {
					this.#storage.retargetWriterClaim?.(this.#sessionClaim.sessionId, newSessionFile);
				}
				// Path is repointed; hot-path appends may use `#sessionFile` again.
				this.#sessionFileRelocating = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;
			// The stash is scoped to the conversation's pre-move state: a completed
			// move must not let a later opted-in request promote it. Refusals and
			// the internal rollback rethrow above, and the no-op early return never
			// relocates, so all three keep it; a caller undoing this completed move
			// through rollbackMove() re-derives it from the captureState() snapshot.
			this.clearTaskSiblingCandidate();
			// Clear only after the rename has landed. If the move threw,
			// keep the flag so the next relocation retries.
			this.#fallbackRuntimeOnly = false;
			if (this.#additionalDirectories.length === 0) {
				this.#header.additionalDirectories = undefined;
			} else {
				// Re-filter additional roots: the new cwd may have been an
				// additional root, or it may now contain one.
				this.#additionalDirectories = this.#additionalDirectories.filter(d => d !== resolvedCwd);
				this.#header.additionalDirectories =
					this.#additionalDirectories.length > 0 ? this.#additionalDirectories : undefined;
			}

			// Rewrite at the new location when the file already existed (update cwd) or
			// there is in-memory output worth materializing; otherwise stay lazy.
			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically();
			}

			if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		} finally {
			this.#sessionFileRelocating = null;
			// The destination is ours or untouched now.
			destination?.release();
			// Whether the move landed or rolled back, the path this manager
			// writes is settled here; a rollback restores the old one and
			// notifies nothing.
			this.#notifySessionFileChanged(previousSessionFile);
		}
	}

	/**
	 * Force the session onto disk even with no assistant message yet (ACP
	 * session/new must create a discoverable file immediately).
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (!this.#hasUnsavedEntries()) return;
		await this.#rewriteAtomically();
	}

	/** Persist this session's transcript as a newly identified OMP session. */
	async persistCopy(
		options?: { sessionDir?: string; suppressBreadcrumb?: boolean },
		storage: SessionStorage = defaultSessionStorage(),
	): Promise<SessionManager> {
		const sessionDir = options?.sessionDir ?? SessionManager.getDefaultSessionDir(this.#cwd, undefined, storage);
		// An in-memory source holds every entry, and the copy persists: it moves older ones to a store.
		const coldStore = this.#persist ? this.#coldStoreEnabled : true;
		const manager = new SessionManager(this.#cwd, sessionDir, true, storage, coldStore);
		manager.#storeMasking = this.#storeMasking;
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#resetToNewSession({ taskPromptCacheKey: this.#header.taskPromptCacheKey });
		manager.#sessionName = this.#sessionName;
		manager.#titleSource = this.#titleSource;
		manager.#titleUpdatedAt = this.#titleUpdatedAt;
		manager.#header.title = this.#sessionName;
		manager.#header.titleSource = this.#titleSource;
		manager.#additionalDirectories = [...this.#additionalDirectories];
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? [...manager.#additionalDirectories] : undefined;
		// A whole entry is copied as `structuredClone` copies it (a `Date` or `Map` in a custom entry stays one), as
		// deep as a transcript line holds; a cold one is copied as a new cold entry over the same record.
		manager.#entries = this.#entries.map(entry =>
			isColdEntry(entry) ? copyColdEntry(entry) : structuredCloneDeep(entry),
		);
		manager.#loadRevision++;
		manager.#adoptColdStore(this.#coldStore);
		manager.#reindexEntries();
		manager.#forceFileCreation = true;
		try {
			await manager.#rewriteAtomically();
		} catch (error) {
			// No caller gets the copy to close, so its hold on the store goes now, not at a collection.
			manager.#releaseColdStore();
			throw error;
		}
		return manager;
	}

	/**
	 * Stage a synchronous group of entry appends and publish the resulting full
	 * journal with one atomic replace. A failed publish removes only the staged
	 * entries, preserves/reparents entries appended concurrently, restores the
	 * prior durable file view, and clears the failed writer latch for retry.
	 *
	 * The callback MUST be synchronous.
	 */
	appendEntriesAtomically<T>(append: () => T): Promise<T> {
		return this.#withAtomicPersistenceLock(() => this.#appendEntriesAtomicallyLocked(append));
	}

	async #appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		if (!this.#persist || !this.#sessionFile) return append();
		if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
		try {
			await this.ensureOnDisk();
			await this.flush();
		} catch (error) {
			const operationError = toError(error);
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
			throw error;
		}

		const batch: AtomicEntryBatch = {
			collecting: true,
			entryIds: new Set(),
			deferredNotifications: [],
			preBatchLeafId: this.#index.leafId(),
			externalLeafChanged: false,
			externalLeafId: null,
		};
		this.#atomicEntryBatch = batch;
		let result!: T;
		try {
			try {
				result = append();
			} finally {
				batch.collecting = false;
			}
			await this.#rewriteAtomically();
			if (this.#hasUnsavedEntries()) {
				throw new Error("Atomic session batch was superseded before commit.");
			}
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(batch.deferredNotifications);
			return result;
		} catch (error) {
			batch.collecting = false;
			const operationError = toError(error);
			this.#rollbackAtomicEntryBatch(batch);
			try {
				await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			} catch (repairError) {
				const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
				this.#pendingDurabilityNotifications.push(...retainedNotifications);
				this.#atomicEntryBatch = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (repairError instanceof SessionPersistenceIndeterminateError) throw repairError;
				throw this.#latchIndeterminate(operationError, [toError(repairError)]);
			}
			const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(retainedNotifications);
			throw error;
		}
	}

	/**
	 * Replace an uncertain append tail with the authoritative in-memory journal.
	 * Callers must only use this for monotonic recovery where every retained
	 * entry remains intended (for example, an explicit terminal tombstone).
	 */
	recoverPersistenceFromCurrentState(): Promise<void> {
		return this.#withAtomicPersistenceLock(async () => {
			if (!this.#persist || !this.#sessionFile) return;
			if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
			const operationError =
				this.#diskFailure ?? new Error("Authoritative session persistence recovery was requested.");
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
		});
	}

	/**
	 * Append the entries storage is missing past the durable frontier, and
	 * only append: when {@link #frontierMatchingSessionFile} holds. Anything
	 * else (a journal that needs a republish, a file that vanished or does not
	 * measure what the frontier issued, a move or atomic rewrite in flight,
	 * another live owner) is left to the next append, so flushing never starts
	 * a full rewrite and never recreates a deleted file. Writes nothing while
	 * an atomic batch is open, once the entries are released, or after
	 * {@link seal} unless `afterSeal` (close's terminal write). An
	 * indeterminate failure does not stop it, because the size check already
	 * refuses a file this manager cannot account for.
	 */
	#healMissingEntries(afterSeal = false): void {
		// A session that stopped under OMP_SESSION_EXCLUSIVE=1 writes nothing more, close()'s heal after the seal
		// included: another process holds its file.
		if (this.#exclusiveStop) return;
		if ((this.#released && !afterSeal) || this.#entriesReleased || this.#atomicEntryBatch) return;
		if (this.#pendingDropOfSessionFile()) return;
		if (this.#sessionFileRelocating || this.#atomicRewriteFenceEpoch === this.#diskEpoch) return;
		// A queued write's conflict recovery publishes the whole transcript (see #recoverQueuedConflict).
		if (this.#queuedConflictRecovery) return;
		if (!this.#hasUnsavedEntries()) return;
		const durable = this.#frontierMatchingSessionFile();
		if (durable) this.#appendTailPastFrontier(durable);
	}

	/** {@link #healMissingEntries} on the disk queue, then wait until a deferring backend confirms what it wrote. */
	async #healMissingEntriesAndSettle(afterSeal = false): Promise<void> {
		await this.#scheduleDiskWork(async () => this.#healMissingEntries(afterSeal), { ignoreEpoch: true }).catch(
			() => undefined,
		);
		await this.#scheduleDiskWork(async () => {
			await this.#storage.drain(this.#sessionFile);
		}).catch(() => undefined);
		await Promise.all(this.#pendingAppendConfirmations);
	}

	/**
	 * Flush pending writes. Call before switching sessions or on shutdown.
	 * Entries storage is missing (an append that failed, a snapshot restored
	 * past them) are written first. Rejects with the latched failure only
	 * while storage is still not proven to hold every entry; content a failed
	 * rewrite could not publish (a maintenance edit, a header change) waits
	 * for the next full rewrite instead. While a {@link dropSession} deletes
	 * the current file, this waits for the delete to settle first. After an
	 * `OMP_SESSION_EXCLUSIVE=1` stop it rejects with the stop
	 * ({@link SessionExclusiveStopError}) while storage does not hold every entry.
	 */
	async flush(): Promise<void> {
		await this.#pendingDrop?.settled.promise;
		if (!this.#persist || !this.#sessionFile) return;
		// A refused write found while draining may start a parent follow (see
		// #followParentMove); its publish in the parent's sibling is flushed too.
		for (let pass = 0; pass < 4; pass++) {
			// Failures below are reported through the latch; whether they cost an
			// entry is decided once everything has settled.
			await this.#scheduleDiskWork(async () => {
				const writer = this.#writer;
				if (writer?.isOpen() && !writer.getError()) await writer.flush();
			}).catch(() => undefined);
			// Drain any fire-and-forget backing writes (e.g. `writeTextSync` queued
			// on IndexedSessionStorage during `flushSync`) so callers relying on
			// flush() see the write durably visible to readers.
			await this.#scheduleDiskWork(async () => {
				await this.#storage.drain(this.#sessionFile);
			}).catch(() => undefined);
			await Promise.all(this.#pendingAppendConfirmations);
			await this.#pendingArtifactCopy?.done;
			if (this.#hasUnsavedEntries()) await this.#healMissingEntriesAndSettle();
			if (!this.#parentMoveFollow && !this.#queuedConflictRecovery) break;
			await this.#parentMoveFollow;
			await this.#queuedConflictRecovery;
		}
		await this.#rejectIfStopLeftEntriesUnsaved();
		if (this.#diskFailure && !this.#allEntriesHandedToStorage()) throw this.#diskFailure;
	}

	/**
	 * Synchronously makes the current append-only session durable. Avoid rewriting
	 * an already-current file: large restored sessions can contain GiB of compacted
	 * history, and Ctrl+C must not rebuild the whole JSONL string just to flush.
	 * Throws the latched failure only while storage is not proven to hold every entry.
	 * After an `OMP_SESSION_EXCLUSIVE=1` stop that left an entry unsaved it throws the stop.
	 *
	 * While a {@link dropSession} deletes the current file this returns without
	 * touching it and without throwing: the entries it would write are either
	 * discarded with the file the caller asked to delete, or, when the delete
	 * fails, appended by the next append, `flush()` or `close()`.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#pendingDropOfSessionFile()) return;
		if (this.#atomicEntryBatch) throw new Error("Cannot synchronously flush during an atomic session batch.");
		const stop = this.#exclusiveStop;
		if (stop && this.#stopLeftEntriesUnsaved(stop)) throw stop.error;
		if (this.#hasUnsavedEntries()) this.#appendToCurrentSessionFile();
		else {
			const writer = this.#writer;
			if (writer?.isOpen() && !writer.getError()) writer.flushSync?.();
		}
		if (this.#diskFailure && !this.#allEntriesHandedToStorage()) throw this.#diskFailure;
	}

	/**
	 * {@link flushSync}, then, on a storage that only queues the publish
	 * (indexed backends such as SQL), the wait for that publish: the promise
	 * settles once {@link flush} has seen the store take every queued write, and
	 * rejects when one failed. `undefined` when the synchronous flush alone made
	 * the session durable (file and memory storage).
	 *
	 * On such a storage a rewrite queued while this manager's own earlier
	 * publish is unconfirmed fails the store's size check. That publish's
	 * confirmation rewrites the transcript, the refused entries included, so
	 * the wait covers it before {@link flush} reports what is left. When the
	 * drain of this session's file fails and the flush still fails after it,
	 * the wait rejects with the drain's error (a failed write to this file, or
	 * to another while the store has landed none since; see
	 * {@link SessionStorage.drain}) instead of the size-check conflict the
	 * flush still holds.
	 *
	 * A write the lease fence refused latches no failure: the loss moves the
	 * session to a sibling, whose publish carries the refused entries. Under
	 * `OMP_SESSION_EXCLUSIVE=1` the loss stops the session instead, and writes
	 * them nowhere. So the promise also rejects when the session stopped, or
	 * when storage still lacks an entry once the flush has settled.
	 */
	flushSyncThenConfirm(): Promise<void> | undefined {
		if (!this.#storage.defersSyncPublish) {
			this.flushSync();
			return undefined;
		}
		let flushed: Promise<void>;
		try {
			this.flushSync();
			flushed = this.flush();
		} catch (error) {
			if (!(error instanceof SessionWriteConflictError)) throw error;
			// The drain hands back (and clears) this file's first failure, and the
			// conflict latched first keeps that failure out of the persistence log:
			// report it in place of the conflict when the flush fails too.
			flushed = this.#storage.drain(this.#sessionFile).then(
				() => this.flush(),
				drainError =>
					this.flush().catch(() => {
						throw drainError;
					}),
			);
		}
		return flushed.then(() => {
			if (this.#exclusiveStop) {
				throw new Error("The session stopped under OMP_SESSION_EXCLUSIVE=1 before storage held its last entries.");
			}
			if (this.#hasUnsavedEntries()) throw new Error("Storage does not hold every entry of the session.");
		});
	}

	/**
	 * The storage's {@link SessionStorage.waitForAppendAdmission}: settles once the storage may queue more
	 * transcript appends, or at once when `signal` fires. `undefined` when there is nothing to wait for: the
	 * storage admits more now, or never makes turns wait on queued appends.
	 */
	waitForAppendAdmission(signal?: AbortSignal): Promise<void> | undefined {
		return this.#storage.waitForAppendAdmission?.(signal);
	}

	/**
	 * Drop only session files that this manager saw materialized for a draft and
	 * that still contain no durable conversation or extension state. Explicit
	 * ensureOnDisk() records (ACP session/new, handoff) stay resumable.
	 */
	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsSync(draftPath)) return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		// Another process can consume the draft and append a real conversation
		// while this manager still has a draft-only in-memory view. Backends that
		// cannot make the final content check and deletion one atomic operation
		// must skip this opportunistic cleanup rather than risk data loss.
		if (!this.#storage.deleteSessionWithArtifactsIf) return;
		try {
			const artifactsDir = this.getArtifactsDir();
			const deleted = await this.#storage.deleteSessionWithArtifactsIf(sessionFile, content => {
				// An `/annotate` draft is work in progress the session must keep.
				if (artifactsDir && hasAnnotationDraftsSync(artifactsDir, this.#header.id)) return false;
				const onDisk = parseSessionContent(content);
				return (
					!onDisk.invalidHeader &&
					onDisk.malformedRecords === 0 &&
					(onDisk.entries.slice(1) as SessionEntry[]).every(isDraftOnlyMetadataEntry)
				);
			});
			if (!deleted) {
				await this.#clearDraftOnlySessionMarker();
				this.#draftOnlySessionCleanupArmed = false;
				return;
			}
			this.#fileIsCurrent = false;
			this.#durable = undefined;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	/**
	 * Write the entries storage is missing, then close the append writer and,
	 * unless a clone still holds it, the store of older entry bodies, so its
	 * descriptor and disk are freed now rather than at a collection. A manager
	 * that does not persist only lets go of the store. Close a
	 * manager last: an older entry of it cannot be read once its store is
	 * closed. Rejects only while storage is still not proven to hold every
	 * entry, and after an `OMP_SESSION_EXCLUSIVE=1` stop with the stop
	 * ({@link SessionExclusiveStopError}) while it does not. While a
	 * {@link dropSession} deletes the current file, this waits for the delete
	 * to settle first. A close that rejects while the store refuses this
	 * session's writes keeps the transcript (see {@link #hold}); a close that
	 * lands sends the sessions the same store refused and waits for those
	 * sends (see {@link #sendRefusedSessions}).
	 */
	async close(): Promise<void> {
		this.#closes++;
		await this.#pendingDrop?.settled.promise;
		if (!this.#persist) {
			// A clone made without persistence shares its source's store.
			this.#releaseColdStore();
			return;
		}
		let failed = false;
		try {
			await this.#closeLocked();
		} catch (error) {
			failed = true;
			// The rejection can be a repair failure that wraps the refusal
			// (SessionPersistenceIndeterminateError); the queue is where the
			// refusal itself was admitted (see #noteDiskFailure).
			if (
				this.#waitsForStore() &&
				this.#sessionFile &&
				!this.#entriesReleased &&
				!this.#exclusiveStop &&
				this.#shouldHaveSessionFile()
			)
				await this.#hold();
			throw error;
		} finally {
			// The close's writes read older entries from the store; nothing reads them after close, also when the
			// close fails early (a marker unlink that throws). A failed close whose transcript stays (held for a
			// later send, see #hold, or kept for an owner that stays open, see seal's `keepEntries`) still reads
			// them: the store then goes when the hold ends (see #unhold), or when the entries are released (see
			// releaseRetainedEntries).
			if (!failed || (!this.#heldBasis && !this.#keepsEntries)) this.#releaseColdStore();
			else this.#closeLeftColdStore = true;
			// Closing gives up this process's ownership claim; a later write
			// reclaims it. It goes last: until the final publish has run, the
			// claim keeps the session's write fence in place, so no write of this
			// close can land after another process claimed the session. A held
			// transcript keeps the claim until it is sent (see #unhold), so its
			// send is fenced the same way.
			if (!this.#heldBasis) this.#releaseSessionClaim();
			// SQL storage deletes its lease row after the release, giving up after
			// 2 s; waiting for it lets a clean exit free the session at once. The
			// release reports its own failure, and every write settled above.
			await this.#storage.drain(this.#sessionFile).catch(() => undefined);
			this.#forgetMoveOffs();
		}
		await SessionManager.#sendRefusedSessions(this.#storage, this);
	}

	#releaseSessionClaim(): void {
		const claim = this.#sessionClaim;
		claim?.release?.();
		if (claim) claim.release = undefined;
	}

	/** Sessions whose writes a store refused, oldest first, by store (see {@link #storeAccepted}). */
	static readonly #refusedSessions = new WeakMap<object, Set<SessionManager>>();

	/** Every file store writes the one local file system, so all of them share one key. */
	static #storeKey(storage: SessionStorage): object {
		return storage instanceof FileSessionStorage ? FileSessionStorage : storage;
	}

	/** Wait, behind the sessions the store refused before, for a write that lands on it. */
	#joinStoreQueue(): void {
		if (!this.#persist || !this.#sessionFile) return;
		const key = SessionManager.#storeKey(this.#storage);
		let queue = SessionManager.#refusedSessions.get(key);
		if (!queue) {
			queue = new Set();
			SessionManager.#refusedSessions.set(key, queue);
		}
		queue.add(this);
	}

	#leaveStoreQueue(): void {
		SessionManager.#refusedSessions.get(SessionManager.#storeKey(this.#storage))?.delete(this);
	}

	/**
	 * Whether this session waits for a write to land on its store: the store
	 * refused one of its writes and none has landed for it since.
	 */
	#waitsForStore(): boolean {
		return SessionManager.#refusedSessions.get(SessionManager.#storeKey(this.#storage))?.has(this) ?? false;
	}

	/**
	 * A write just landed on `storage`: send the oldest session the store
	 * refused, other than `sender`, once more, after the landing write returns.
	 * One send per landed write: the sent session goes to the back of the
	 * queue, so the next landed write sends the next one. A send that lands is
	 * itself a landed write, so once the store accepts writes again the queue
	 * drains one session after another. A session leaves the queue when its
	 * write lands, or when its held transcript is dropped.
	 */
	static #storeAccepted(storage: SessionStorage, sender: SessionManager): void {
		const queue = SessionManager.#refusedSessions.get(SessionManager.#storeKey(storage));
		if (!queue) return;
		for (const manager of queue) {
			if (manager === sender || manager.#storeSend) continue;
			queue.delete(manager);
			queue.add(manager);
			void manager.#sendOnce();
			return;
		}
	}

	/**
	 * A close that landed: send every session the store refused once, oldest
	 * first, one at a time, and wait for them, so a process that exits after
	 * this close keeps them. A session the store refuses again stays queued
	 * for later landed writes; the ones behind it are still sent.
	 */
	static async #sendRefusedSessions(storage: SessionStorage, sender: SessionManager): Promise<void> {
		const queue = SessionManager.#refusedSessions.get(SessionManager.#storeKey(storage));
		if (!queue) return;
		// A snapshot: sends change the queue as they go.
		for (const manager of Array.from(queue)) {
			if (manager !== sender && queue.has(manager)) await manager.#sendOnce();
		}
	}

	/** One send of this session, started after the caller returns; a send already running is joined. */
	#sendOnce(): Promise<void> {
		if (this.#storeSend) return this.#storeSend;
		const send = Promise.resolve()
			.then(() => (this.#heldBasis ? this.#sendHeld() : this.#resendRefusedEntries()))
			.finally(() => {
				this.#storeSend = undefined;
			});
		this.#storeSend = send;
		return send;
	}

	/**
	 * One more write of this live session's entries after the store refused
	 * them: the write its next append would make (the missing tail, or the
	 * whole body where the durable frontier is lost), under its atomic
	 * persistence lock so it never overlaps a repair, and settled before this
	 * resolves. A session that wrote meanwhile, or is closing, is left alone.
	 * Never rejects: a refusal is latched and keeps the session queued.
	 */
	async #resendRefusedEntries(): Promise<void> {
		try {
			await this.#withAtomicPersistenceLock(async () => {
				if (this.#released || this.#atomicEntryBatch || !this.#sessionFile || !this.#hasUnsavedEntries()) return;
				this.#appendToCurrentSessionFile();
				await Promise.all(this.#pendingAppendConfirmations);
			});
		} catch {
			// Latched by the write path; a refusal keeps this session queued.
		}
	}

	/**
	 * Keep this closed transcript in memory, with its session claim, as a
	 * live session keeps the entries a store refused, and wait with the other
	 * sessions the store refused (see {@link #storeAccepted}). The stored
	 * transcript the close left is read first, before the close rejects, so a
	 * send never replaces another one (see {@link #sendHeld}). Nothing limits
	 * how long or how many: held transcripts stay in memory until the store
	 * accepts them, and a process that exits while the store still refuses
	 * loses them, as it loses a live session's unsaved entries. Once the send
	 * lands, or the hold ends because another writer owns the file, a sealed
	 * session drops its transcript as {@link releaseRetainedEntries} does,
	 * unless it was sealed with `keepEntries` (see {@link seal}).
	 */
	async #hold(): Promise<void> {
		this.#heldBasis = (await this.#readStoredTranscript()).state;
		this.#joinStoreQueue();
	}

	/**
	 * Whether a close the store refused keeps this session's transcript in
	 * memory until a later write that lands on the same store sends it (see
	 * {@link #hold}). The session releases the transcript itself once the
	 * hold ends; its owner need not keep anything else for it.
	 */
	holdsTranscript(): boolean {
		return this.#heldBasis !== undefined;
	}

	/**
	 * End the hold; a sealed session has nothing left to write, so it drops its
	 * transcript too, unless its owner sealed it with `keepEntries`.
	 */
	#unhold(): void {
		const held = this.#heldBasis !== undefined;
		this.#heldBasis = undefined;
		this.#leaveStoreQueue();
		if (held) this.#releaseSessionClaim();
		// The held transcript was the store's last reader on this closed manager, unless its owner keeps the entries.
		if (held && !this.#keepsEntries) this.#releaseColdStore();
		if (this.#released && !this.#keepsEntries && !this.#entriesReleased) this.releaseRetainedEntries();
	}

	/**
	 * What the store holds at this session's path now, read in parts (see
	 * {@link readStoredTranscriptPass}); with `parseHeader`, also the first
	 * entry the read parsed. Never rejects.
	 */
	async #readStoredTranscript(parseHeader = false): Promise<{ state: StoredTranscriptState; first?: FileEntry }> {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return { state: { kind: "absent" } };
		try {
			const { size, sha256, first } = await retryRacedRead(() =>
				readStoredTranscriptPass(sessionFile, this.#storage, parseHeader),
			);
			return { state: { kind: "present", size, sha256 }, first };
		} catch (error) {
			return { state: { kind: isEnoent(error) ? "absent" : "unread" } };
		}
	}

	/**
	 * Whether the store still holds the transcript this session's close left:
	 * absent then and now, or the same content as then. When the close could
	 * not read it, the byte length this session last stored and its header,
	 * the stored transcript's `first` entry.
	 */
	#storedAsLeft(left: StoredTranscriptState, now: StoredTranscriptState, first: FileEntry | undefined): boolean {
		if (left.kind === "absent") return now.kind === "absent";
		if (left.kind === "present")
			return now.kind === "present" && now.size === left.size && now.sha256 === left.sha256;
		if (now.kind === "absent") return this.#expectedDiskSize === null;
		if (now.kind !== "present" || now.size !== this.#expectedDiskSize) return false;
		return isValidSessionHeader(first) && first.id === this.#sessionId;
	}

	/**
	 * One send of the held transcript, only over the stored transcript the
	 * close left (see {@link #storedAsLeft}). The store holding exactly this
	 * transcript already counts as sent. Any other stored state is another
	 * writer's and is never replaced: the hold ends with a warning. A stored
	 * file that cannot be read keeps the hold without a write. Never rejects:
	 * a refusal is latched and keeps the hold.
	 */
	async #sendHeld(): Promise<void> {
		const sessionFile = this.#sessionFile;
		const left = this.#heldBasis;
		if (!sessionFile || !left || this.#entriesReleased) {
			this.#unhold();
			return;
		}
		try {
			// When the close could not read the store, the stored header says whose transcript it holds now.
			const now = await this.#readStoredTranscript(left.kind === "unread");
			if (now.state.kind === "unread") return;
			// One body throughout: its byte count is known once a pass has read
			// every line (its digest, or the write).
			const body = this.#serializeBody();
			let digest: SessionBodyDigest | undefined;
			const storedIsBody = (stored: StoredTranscriptState): boolean => {
				if (stored.kind !== "present") return false;
				digest ??= sessionBodyDigest(body);
				return stored.size === digest.bytes && stored.sha256 === digest.sha256;
			};
			if (storedIsBody(now.state)) return this.#heldSent(body);
			if (!this.#storedAsLeft(left, now.state, now.first))
				return this.#dropHeld(sessionFile, "another writer changed the file");
			const options = { expectedSize: now.state.kind === "present" ? now.state.size : null };
			try {
				await (this.#storage.writeLinesAtomic
					? this.#storage.writeLinesAtomic(sessionFile, body.lines, options)
					: this.#storage.writeTextAtomic(sessionFile, Array.from(body.lines).join(""), options));
				await this.#storage.drain(sessionFile);
			} catch (error) {
				if (!(error instanceof SessionWriteConflictError)) throw error;
				if (storedIsBody((await this.#readStoredTranscript()).state)) return this.#heldSent(body);
				return this.#dropHeld(sessionFile, "another writer changed the file");
			}
			return this.#heldSent(body);
		} catch (error) {
			this.#noteDiskFailure(error);
			if (!isSessionStoreOutage(error)) this.#dropHeld(sessionFile, toError(error).message);
		}
	}

	#heldSent(body: SessionFileBody): void {
		this.#clearDiskError();
		this.#recordPublish(body.stamp, body.bytes, body.oversizedLines);
		this.#unhold();
	}

	#dropHeld(sessionFile: string, reason: string): void {
		logger.warn("Dropped a held session transcript", { sessionFile, reason });
		this.#unhold();
	}

	/** Drop this manager's move-offs from `sessionMoveOffs`, and from its own record of files it moved off. */
	#forgetMoveOffs(): void {
		for (const from of this.#movedOffFrom) sessionMoveOffs.delete(from);
		this.#movedOffFrom.clear();
	}

	async #closeLocked(): Promise<void> {
		// Failures below are reported through the latch; whether they cost an
		// entry is decided once everything has settled, as in flush(). A prior
		// `flushSync` can self-conflict with this manager's own unconfirmed
		// deferred publish, so the drain still runs and that publish can confirm.
		if (this.#sessionFile && this.#hasUnsavedEntries()) await this.#healMissingEntriesAndSettle(true);
		await this.#scheduleDiskWork(async () => {
			const hadWriter = this.#writer !== undefined;
			await this.#closeWriterHandle();
			if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
				this.#fileIsCurrent = true;
		}).catch(() => undefined);
		await this.#pendingArtifactCopy?.done;
		await this.#dropIfEmptyAndNoDraft();
		// Wait for any queued backing writes (IndexedSessionStorage per-path
		// tail) to become durable so a graceful shutdown does not exit while
		// a fire-and-forget publish is still on the wire.
		await this.#scheduleDiskWork(async () => {
			await this.#storage.drain(this.#sessionFile);
		}).catch(() => undefined);
		await Promise.all(this.#pendingAppendConfirmations);
		// A parent follow publishes this transcript in the parent's sibling before the claim goes.
		for (let pass = 0; (this.#parentMoveFollow || this.#queuedConflictRecovery) && pass < 4; pass++) {
			await this.#parentMoveFollow;
			await this.#queuedConflictRecovery;
			await this.#scheduleDiskWork(async () => {
				await this.#storage.drain(this.#sessionFile);
			}).catch(() => undefined);
		}
		// A deferring backend rejected an append while closing: append the
		// missing tail again, which needs no full rewrite.
		if (this.#sessionFile && this.#hasUnsavedEntries()) {
			await this.#healMissingEntriesAndSettle(true);
			await this.#scheduleDiskWork(async () => this.#closeWriterHandle(), { ignoreEpoch: true }).catch(
				() => undefined,
			);
		}
		if (
			(this.#diskFailure || this.#closeOwesPublish) &&
			this.#sessionFile &&
			this.#storage.defersSyncPublish &&
			!this.#entriesReleased &&
			// A session that stopped under OMP_SESSION_EXCLUSIVE=1 writes nothing more: another process holds its
			// file, and a signal's teardown may close it during the stop's wait.
			!this.#exclusiveStop &&
			this.#hasUnsavedEntries()
		) {
			// Deferred-publish only: a synchronous backend's drain() is a
			// no-op, so any failure there is a genuine external conflict or a
			// permanent write failure, not a self-race this retry can catch
			// up on. seal() disabled the ordinary mid-life repair path and the
			// re-issue a late confirmation owes, so close() issues the
			// terminal write directly instead.
			const operationError =
				this.#diskFailure ?? new Error("Session entries were still unpublished when the session closed.");
			const sessionFile = this.#sessionFile;
			await this.#scheduleDiskWork(async () => {
				await this.#publishAuthoritativeBody(sessionFile, operationError);
				this.#closeOwesPublish = false;
			}).catch(() => undefined);
		}
		// A move the terminal publish made copies the artifacts to the sibling in the background: let it land.
		await this.#pendingArtifactCopy?.done;
		await this.#rejectIfStopLeftEntriesUnsaved();
		// After a terminal release the entries are gone, so a latched failure
		// cannot be shown harmless.
		if (this.#diskFailure && (this.#entriesReleased || !this.#allEntriesHandedToStorage())) throw this.#diskFailure;
	}

	/** Drop this manager's hold on its cold store, closing the store when no other manager holds it. */
	#releaseColdStore(): void {
		this.#coldStore?.release(true);
		this.#coldStore = undefined;
		this.#closeLeftColdStore = false;
	}

	/**
	 * Raise the terminal write barrier ahead of the final {@link close}. Once
	 * sealed:
	 * - every later append, title change, and rewrite is a dropped no-op —
	 *   including work an event handler tries to enqueue while dispose is
	 *   awaiting `close()` on the disk tail;
	 * - the disk epoch is bumped, so queued-but-unexecuted tail work is
	 *   superseded and an ALREADY-RUNNING fenced/repair rewrite (awaiting the
	 *   tail, drain, writer close, or the atomic stage) fails its commit guard
	 *   at the rename fence instead of publishing over a revived file.
	 * The final `close()` itself is scheduled after the bump and still runs;
	 * pre-seal hot-path appends are already in the page cache. Idempotent;
	 * terminal.
	 *
	 * With `keepEntries`, the end of a hold (see {@link #hold}) leaves the
	 * entries in memory instead of releasing them: the owner stays open after
	 * a failed close and still reads them (the interactive mode's `/export`).
	 * A sealed session writes nothing else, so keeping them is safe; an
	 * explicit {@link releaseRetainedEntries} still drops them.
	 */
	seal(options: { keepEntries?: boolean } = {}): void {
		if (options.keepEntries) this.#keepsEntries = true;
		if (this.#released) return;
		this.#released = true;
		this.#diskEpoch++;
	}

	/**
	 * Terminal release: drop the in-memory transcript and complete the
	 * {@link seal}. The entry journal and its index mirror the agent's message
	 * array (tool results, file contents, base64 frame images); on a disposed
	 * session — e.g. a parked subagent still referenced by the lifecycle
	 * adoption record — they would otherwise stay pinned for the process
	 * lifetime.
	 *
	 * Closes the append writer; with the seal up, nothing can reopen it. A
	 * revival may reopen the same JSONL through a NEW manager the moment
	 * dispose returns; a late event handler resuming on THIS manager must
	 * never race that writer — and a post-release rewrite would persist the
	 * now-empty entry list, truncating the transcript. Reads after this point
	 * reopen from disk (revival, `history://`). Only call from session
	 * dispose, after the final `close()`; idempotent.
	 */
	releaseRetainedEntries(): void {
		this.seal();
		this.#entries = [];
		this.#durable = undefined;
		this.#refusedSessionSwitch = undefined;
		this.#index.clear();
		// A clone or a snapshot taken for a rollback can still read the store; it closes once collected. The
		// store a failed close left open for these entries closes now, as that close would have.
		if (this.#closeLeftColdStore) this.#releaseColdStore();
		this.#resetColdCut(undefined, false);
		this.#inMemoryArtifacts = null;
		this.#closeWriterEventually();
		this.#entriesReleased = true;
		// With its entries gone there is nothing left to send.
		this.#unhold();
	}

	getCwd(): string {
		return this.#cwd;
	}

	/** Recorded cwd from the session header (original project), may differ from runtime {@link getCwd} when fallback retained launch cwd. */
	getRecordedCwd(): string | undefined {
		return this.#header?.cwd;
	}

	setCwdWithoutRelocation(newCwd: string): void {
		const resolvedCwd = path.resolve(newCwd);
		if (resolvedCwd === path.resolve(this.#cwd)) {
			this.#fallbackRuntimeOnly = true;
			return;
		}
		this.#cwd = resolvedCwd;
		this.#fallbackRuntimeOnly = true;
		if (this.#sessionFile) {
			this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		}
	}
	adoptRecordedCwd(): void {
		const recordedCwd = this.#header.cwd;
		if (!recordedCwd) return;
		this.#cwd = path.resolve(recordedCwd);
		if (this.#sessionFile) this.#sessionDir = path.dirname(this.#sessionFile);
		this.#fallbackRuntimeOnly = false;
		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
	}

	/**
	 * Re-anchor the session bucket to the runtime cwd after a fallback.
	 * The fallback flag keeps the transcript at its recorded path (stale
	 * bucket) while runtime cwd is the launch dir; only a true relocation
	 * should recompute sessionDir. Workspace-dir mutations must not clear
	 * it early.
	 */
	#reconcileSessionDirForFallback(): void {
		if (this.#fallbackRuntimeOnly) {
			this.#sessionDir = computeDefaultSessionDir(this.#cwd, this.#storage);
			this.#fallbackRuntimeOnly = false;
		}
	}

	/** Additional workspace directories beyond cwd (multi-root), absolute and normalized. */
	getAdditionalDirectories(): string[] {
		return [...this.#additionalDirectories];
	}

	/**
	 * Persist a workspace-directory change to the session header. Respects the
	 * lazy-persistence gate: a session with no durable output yet keeps the
	 * change in memory (the header lands with the first real write), so seeding
	 * roots at launch never materializes an empty resumable session file.
	 */
	async #persistWorkspaceDirectoriesChange(): Promise<void> {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Add a workspace directory. Normalizes (relative to cwd), dedupes, rejects
	 * the cwd itself, persists to the session header, and triggers an atomic
	 * rewrite so the change survives a crash. Returns the resolved absolute
	 * path or `null` when the directory was already present (no-op).
	 */
	async addWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		if (resolved === path.resolve(this.#cwd)) {
			throw new Error("The current working directory is already the primary workspace root.");
		}
		if (this.#additionalDirectories.includes(resolved)) return null;
		this.#additionalDirectories = [...this.#additionalDirectories, resolved];
		// In fallback the transcript is still in the stale bucket; keep
		// workspace edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			return resolved;
		}
		this.#header.additionalDirectories = this.#additionalDirectories;
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/**
	 * Remove a workspace directory by absolute or cwd-relative path. Persists
	 * the trimmed header. Returns the resolved path that was removed, or
	 * `null` when the directory was not an additional root (no-op).
	 */
	async removeWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		const idx = this.#additionalDirectories.findIndex(p => path.resolve(p) === resolved);
		if (idx === -1) return null;
		this.#additionalDirectories = this.#additionalDirectories.filter((_, i) => i !== idx);
		// In fallback keep edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			return resolved;
		}
		if (this.#additionalDirectories.length === 0) {
			this.#header.additionalDirectories = undefined;
		} else {
			this.#header.additionalDirectories = this.#additionalDirectories;
		}
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/** Seed additional directories from settings or a passed list. Also called on resumed sessions with --add-dir; persists the updated header when the session file is already durable. No-op when the normalized list is unchanged (avoids rewriting large session files on every startup). */
	async setAdditionalDirectories(directories: string[]): Promise<void> {
		const workspace = normalizeSessionWorkspace({ cwd: this.#cwd, directories });
		const next = additionalWorkspaceDirectories(workspace);
		// In fallback keep edits runtime-only until relocation.
		if (this.#fallbackRuntimeOnly) {
			this.#additionalDirectories = next;
			return;
		}
		if (
			next.length === this.#additionalDirectories.length &&
			next.every((d, i) => d === this.#additionalDirectories[i])
		) {
			return;
		}
		this.#additionalDirectories = next;
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = this.#additionalDirectories;
		} else {
			this.#header.additionalDirectories = undefined;
		}
		await this.#persistWorkspaceDirectoriesChange();
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	/**
	 * Open a new per-turn budget window: snapshot the cumulative output baseline,
	 * reset the eval-subagent counter, and set the (optional) ceiling.
	 */
	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	/** The storage this session's transcripts, and its subagents', are read from and written to. */
	getStorage(): SessionStorage {
		return this.#storage;
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	/**
	 * The order mark of the latest session this manager left, 0 before any: what
	 * {@link getLeftSessions} counts from.
	 */
	getLeftSessionsMark(): number {
		return this.#leftSessionsMark;
	}

	/**
	 * Every session this manager left after the order mark `since` ({@link getLeftSessionsMark}),
	 * oldest first: its id and the file it last left the session at. A session is left when this
	 * manager goes on in another one: a resume, `/new`, a whole-session fork, a fork or branch from
	 * an entry, or the move to a new file when another process holds the old one. A work pool
	 * stopped after such a change writes its discards into the sessions among these that hold its
	 * spawn records.
	 */
	getLeftSessions(since = 0): Array<{ id: string; file: string }> {
		const left: Array<{ id: string; file: string; mark: number }> = [];
		for (const [id, { file, mark }] of this.#leftSessions) if (mark > since) left.push({ id, file, mark });
		return left.sort((a, b) => a.mark - b.mark).map(({ id, file }) => ({ id, file }));
	}

	/**
	 * Record that this manager left the session `id`, last written at `file`. A transcript adopted under a refused
	 * claim that no follow has forked or moved yet ({@link #heldAdoptionFile}) was never this manager's: leaving it
	 * (`/new`, `/fork`, a branch) records nothing.
	 */
	#recordLeftSession(id: string, file: string | undefined): void {
		if (!id || !file) return;
		if (file === this.#heldAdoptionFile) {
			this.#heldAdoptionFile = undefined;
			return;
		}
		this.#leftSessions.set(id, { file, mark: ++this.#leftSessionsMark });
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	/**
	 * Whether this session began an `OMP_SESSION_EXCLUSIVE=1` stop: it is sealed, writes nothing more, and the process
	 * ends. An entry appended now is dropped and counts as unsaved (see {@link flush}), so bookkeeping a teardown
	 * would record (the session exit marker) is skipped instead.
	 */
	isExclusiveStopped(): boolean {
		return this.#exclusiveStop !== undefined;
	}

	/**
	 * Whether the current session has actually been materialized to durable
	 * storage (the JSONL exists on disk / in the active storage backend).
	 *
	 * Session persistence is lazy: the file is only written once the history
	 * contains an assistant message (or an explicit {@link ensureOnDisk}
	 * caller forces it). Until then {@link getSessionFile} returns an allocated
	 * path that leads nowhere, so a `--resume <id>` hint built from it would
	 * always fail. Consumers that advertise a resume command must gate on this
	 * (issue #8860).
	 */
	isSessionOnDisk(): boolean {
		return !!this.#sessionFile && this.#storage.existsSync(this.#sessionFile);
	}

	/**
	 * {@link isSessionOnDisk}, counting only what the backing store has
	 * confirmed. Remote storage publishes asynchronously, so a hint printed
	 * just before the process exits must not count a write still in flight:
	 * the exit aborts it and `--resume <id>` would find nothing. A deferring
	 * store without `existsConfirmedSync` cannot vouch for its writes, so it
	 * reports false.
	 */
	isSessionConfirmedOnDisk(): boolean {
		const sessionFile = this.#sessionFile;
		if (!sessionFile) return false;
		const storage = this.#storage;
		if (storage.existsConfirmedSync) return storage.existsConfirmedSync(sessionFile);
		return !storage.defersSyncPublish && storage.existsSync(sessionFile);
	}

	/**
	 * Whether a disk failure is latched: the session file stopped being written,
	 * and the failed entry and any later ones live only in memory.
	 */
	hasPersistenceFailure(): boolean {
		return this.#diskFailure !== undefined;
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	/** Source artifacts a seance fork reads in place; null for ordinary sessions. */
	getSeanceSourceArtifactsDir(): string | null {
		return artifactsDirectoryFor(this.#header?.seanceSource);
	}

	adoptArtifactManager(manager: ArtifactManagerApi): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManagerApi | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		if (this.#released) return {};
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		if (this.#released) return undefined;
		const manager = this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		// Non-persistent session: keep an in-memory copy so spill truncation works.
		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	/**
	 * Content of a spill artifact kept in memory by a non-persistent session.
	 * Null for unknown ids and for file-backed sessions, whose artifacts resolve
	 * through {@link getArtifactPath}.
	 */
	getArtifactContent(id: string): string | null {
		return this.#inMemoryArtifacts?.get(id) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		const sessionFile = this.#sessionFile;
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			!this.#storage.existsSync(sessionFile) &&
			this.#entries.every(isDraftOnlyMetadataEntry);
		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, this.storeMask()?.maskText(text) ?? text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	/** Bumped when entries change in place (`rewriteEntries`, `patchEntries`, replay sanitizing); appends do not bump it. */
	get bodyRevision(): number {
		return this.#bodyRevision;
	}

	/**
	 * Bumped each time the entries are read in whole: a session file opened, resumed or read again (a `/resume` of the
	 * session already held, a reload), copied into a new session (`forkFrom`: `omp --fork`, a resume of a session that
	 * moved away, a `/tan` or task fork; {@link persistCopy}), a captured state restored. Records read from the entries
	 * and kept by session (image drops, the provider's fallbacks) are read again at a new revision:
	 * another process may have continued the session file since this one last read it, and the records a read brings
	 * stand over what this process held before it.
	 */
	get loadRevision(): number {
		return this.#loadRevision;
	}

	/** Tracks user rename requests; background title updates do not invalidate them. */
	get titleRevision(): number {
		return this.#titleRevision;
	}

	/** Malformed JSONL records skipped when this session file was loaded (0 for new sessions). */
	get loadedMalformedRecords(): number {
		return this.#loadedMalformedRecords;
	}

	/** Invalidate older generated renames before starting a new request. */
	reserveTitleRevision(): number {
		return ++this.#titleRevision;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	/**
	 * The persistence failure latched for the current session file, or
	 * `undefined`: the one a rejecting flush()/close() throws.
	 */
	getPersistenceFailure(): Error | undefined {
		return this.#diskFailure;
	}

	/**
	 * Subscribe to persistence failures so hosts can surface lost-durability state.
	 *
	 * A failure latched before this call — a store that failed on its first write,
	 * before the host wired its observer — is replayed to the new subscriber.
	 * Without the replay the host sees only a dispose rejection it cannot
	 * attribute to persistence (issue #11493).
	 */
	onPersistenceError(cb: (error: Error) => void): () => void {
		this.#persistenceErrorCallbacks.add(cb);
		const latched = this.#diskFailure;
		if (latched) this.#invokePersistenceObserver(cb, latched);
		return () => {
			this.#persistenceErrorCallbacks.delete(cb);
		};
	}

	/**
	 * Subscribe to {@link SessionPersistenceNotice}s: this session moved to a new
	 * file and keeps saving there, which the user should hear about but which is
	 * not a failure. Every notice raised before this call is replayed to the new
	 * subscriber, as {@link onPersistenceError} replays a latched failure, so each
	 * subscriber sees each notice once however late it subscribed.
	 */
	onPersistenceNotice(cb: (notice: SessionPersistenceNotice) => void): () => void {
		for (const notice of this.#persistenceNotices) this.#invokePersistenceObserver(cb, notice);
		this.#persistenceNoticeCallbacks.add(cb);
		return () => {
			this.#persistenceNoticeCallbacks.delete(cb);
		};
	}

	/**
	 * The id this session had in `notice.from`, for a notice of a move to a sibling under a new id; `undefined` for
	 * a move that kept the id (a subagent transcript that followed its parent session's move). The sibling's header
	 * does not name the old id as a continuation, so a later resume of the old file does not follow it; this tells an
	 * observer which session the copy carries on.
	 */
	movedOffSessionId(notice: SessionPersistenceNotice): string | undefined {
		return this.#movedOffSessionIds.get(notice);
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#released) return false;
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		if (source === "user") this.#titleRevision++;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#notifyEntryAppended(entry);
		await this.#persistTitleChangeEntry(entry, { title, source, updatedAt: timestamp });
		// Keep the recent-sessions title index current so welcome-screen lookups
		// never have to content-scan this session's file.
		if (this.#persist && this.#storage instanceof FileSessionStorage) {
			recordMaskedHistory(this, title, "title", stored => recordSessionTitle(this.#sessionId, stored));
		}

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Rename a session file that is not loaded in this process, e.g. from the
	 * resume picker. Returns the title as stored (the session canonicalizes
	 * it), or null when the rename did not happen.
	 *
	 * The cross-process ownership lease is claimed before the transcript is
	 * loaded and held until the write is done. Claiming first is what makes
	 * the rename safe: another process appending between our load and our
	 * write would leave us parenting the title entry to a stale leaf, so the
	 * reopened session followed the older branch and hid the other process's
	 * turn. Holding the lease from before the load keeps the loaded leaf
	 * stable until the title is written.
	 */
	static async renameSessionTitle(
		sessionPath: string,
		title: string,
		options?: { cwd?: string },
	): Promise<string | null> {
		const storage = defaultSessionStorage();
		// The header id is what the lease is keyed on; a null claim means
		// another live process owns the session, so leave it alone. SQL storage
		// answers a claim only once the database has, so wait for that answer
		// before anything is loaded. A backend that claims nothing has no lease to take.
		const sessionId = await readSessionHeaderId(sessionPath, storage);
		if (!sessionId) return null;
		const probe = storage.acquireSessionClaim
			? await storage.acquireSessionClaim(sessionId, sessionPath)
			: storage.claimSession
				? storage.claimSession(sessionId, sessionPath)
				: () => {};
		if (!probe) return null;
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(sessionPath, undefined, storage, {
				initialCwd: options?.cwd,
				suppressBreadcrumb: true,
				throwIfMissing: true,
			});
			if (manager.getSessionFile() !== sessionPath) return null;
			if (!(await manager.setSessionName(title, "user"))) return null;
			return manager.getSessionName() ?? null;
		} finally {
			try {
				await manager?.close();
			} finally {
				probe();
			}
		}
	}

	/**
	 * Append custom entries to the session `sessionId` journaled at `sessionPath`, through this
	 * manager's storage, when this manager does not write it now: a session a work pool's spawn
	 * records are in, after its owner went on in another one. See {@link appendCustomEntriesToFile}.
	 * Resolves "refused", and writes nothing, once this session stopped under
	 * `OMP_SESSION_EXCLUSIVE=1`: the process ends, and nothing of this session writes after the stop.
	 */
	appendCustomEntriesToSession(
		sessionId: string,
		sessionPath: string,
		entries: ReadonlyArray<{ customType: string; data: unknown }>,
		options?: { holding?: readonly string[] },
	): Promise<CustomEntriesAppend> {
		if (this.#exclusiveStop) return Promise.resolve("refused");
		return SessionManager.appendCustomEntriesToFile(sessionId, sessionPath, entries, this.#storage, options);
	}

	/**
	 * Append custom entries to the session `sessionId` journaled at `sessionPath` in `storage`, a
	 * session no manager of this process writes now. Modelled on {@link renameSessionTitle}: the
	 * ownership lease (when `storage` has one, as the session's own writes take it) is claimed
	 * before the transcript is loaded and held until the entries are written, so they parent to the
	 * session's current leaf.
	 *
	 * Resolves "refused", and writes nothing, when another live process owns the session or the
	 * path now holds another session: the lease refuses a header naming another id, and the loaded
	 * session's id is checked again, for a storage without a lease. Resolves "no-records", and
	 * writes nothing, when `holding` is given and the session holds none of those entries.
	 * Rejects when the file is gone: the open runs with `throwIfMissing`, so no session is made at
	 * the path.
	 *
	 * Until the append settles, a load of the same path in this process waits for it
	 * ({@link #setSessionFile}, {@link open}), so a session that goes back to the file at once (a
	 * quick `/resume` back) loads the entries and parents its next entry to them, instead of
	 * putting them on a side branch.
	 */
	static appendCustomEntriesToFile(
		sessionId: string,
		sessionPath: string,
		entries: ReadonlyArray<{ customType: string; data: unknown }>,
		storage: SessionStorage = defaultSessionStorage(),
		options?: { holding?: readonly string[] },
	): Promise<CustomEntriesAppend> {
		const resolvedPath = path.resolve(sessionPath);
		const append = async (): Promise<CustomEntriesAppend> => {
			// As {@link renameSessionTitle}: SQL storage answers a claim only once the database has.
			const release = storage.acquireSessionClaim
				? await storage.acquireSessionClaim(sessionId, resolvedPath)
				: storage.claimSession
					? storage.claimSession(sessionId, resolvedPath)
					: () => {};
			if (!release) return "refused";
			let manager: SessionManager | undefined;
			try {
				manager = await SessionManager.#open(
					resolvedPath,
					undefined,
					storage,
					{ suppressBreadcrumb: true, throwIfMissing: true },
					{ awaitPendingAppends: false },
				);
				if (manager.getSessionId() !== sessionId || manager.getSessionFile() !== resolvedPath) return "refused";
				const holding = options?.holding;
				if (holding && !holding.some(entryId => manager?.getEntry(entryId) !== undefined)) return "no-records";
				for (const entry of entries) manager.appendCustomEntry(entry.customType, entry.data);
				await manager.flush();
				return "appended";
			} finally {
				try {
					await manager?.close();
				} finally {
					release();
				}
			}
		};
		// Appends to one path run one after another, and a load of the path waits for them all.
		const appended = (SessionManager.#pendingAppends.get(resolvedPath) ?? Promise.resolve()).then(append);
		const settled = appended.then(
			() => {},
			() => {},
		);
		SessionManager.#pendingAppends.set(resolvedPath, settled);
		void settled.then(() => {
			if (SessionManager.#pendingAppends.get(resolvedPath) === settled)
				SessionManager.#pendingAppends.delete(resolvedPath);
		});
		return appended;
	}

	/** The appends of {@link appendCustomEntriesToFile} not yet settled, by resolved session path. */
	static readonly #pendingAppends = new Map<string, Promise<void>>();

	/**
	 * Journal an idle recap for this session in history.db. Recaps never enter
	 * the session file or LLM context; in-memory sessions are not journaled.
	 * Every other store journals them, `session.storage: sql` as files do: the
	 * archive's recap views and a resumed session's recap line read only this
	 * journal, so a store left out would show no recap at all.
	 */
	recordRecap(recap: string): void {
		if (this.#persist && !(this.#storage instanceof MemorySessionStorage)) {
			recordMaskedHistory(this, recap, "recap", stored => recordSessionRecap(this.#sessionId, this.#cwd, stored));
		}
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * The live header and entries, for collab replication. Nothing is copied:
	 * the host mutates entries in place on rewrite paths, so callers must not
	 * mutate what this returns and must serialize it synchronously, before any
	 * such rewrite can run.
	 */
	snapshotForReplication(): { header: SessionHeader; entries: readonly SessionEntry[] } {
		return { header: this.#header, entries: this.#entries };
	}

	/**
	 * Append a message as a child of the current leaf, then advance the leaf.
	 * CompactionSummaryMessage / BranchSummaryMessage are rejected here — they are
	 * top-level entries via appendCompaction()/branchWithSummary().
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append to a non-active branch without changing the current leaf.
	 * Used by work that retains ownership of a branch across tree navigation.
	 *
	 * The entry records the active leaf it interrupted (`activeLeafId`) so a
	 * reload replays the same leaf instead of adopting this off-branch tail.
	 * Pass `preserveActiveLeaf: false` when the caller selects the new entry as
	 * the leaf instead (a re-answered `ask`).
	 */
	appendMessageToBranch(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
		parentId: string | null,
		options?: { preserveActiveLeaf?: boolean },
	): string {
		if (parentId !== null && !this.#index.has(parentId)) throw new Error(`Entry ${parentId} not found`);
		const activeLeafId = this.#index.leafId();
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.#index),
			parentId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			message,
			...(options?.preserveActiveLeaf === false ? {} : { activeLeafId }),
		};
		// The entry never joins the active branch; keep it out of any branch view
		// already handed out. Recording `activeLeafId` leaves the index's leaf on
		// the active branch, as the in-memory contract requires.
		this.#index.detachBranchView();
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Record usage on its initiating branch without moving a successor branch or session. */
	appendModelUsage(
		usage: Pick<
			ModelUsageEntry,
			"purpose" | "role" | "api" | "provider" | "model" | "usage" | "stopReason" | "errorMessage" | "cacheRefresh"
		>,
		owner: { sessionId: string; parentId: string | null },
	): string | undefined {
		if (this.#sessionId !== owner.sessionId || (owner.parentId !== null && !this.#index.has(owner.parentId))) {
			return undefined;
		}
		const activeLeafId = this.#index.leafId();
		const entry: ModelUsageEntry = {
			type: "model_usage",
			id: generateId(this.#index),
			parentId: owner.parentId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			...usage,
			...(activeLeafId !== owner.parentId ? { activeLeafId } : {}),
		};
		this.#recordEntry(entry);
		// Through #setLeaf so an in-flight atomic batch restores this leaf, not the usage entry, on rollback.
		if (activeLeafId !== owner.parentId) this.#setLeaf(activeLeafId);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 * @param resolvedModelIsFallback Whether this transition selected a retry-fallback model
	 */
	appendModelChange(model: string, role?: string, resolvedModelIsFallback = false): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			...this.#freshEntryFields(),
			model,
			role,
			resolvedModelIsFallback,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string[];
		task: string;
		tools: string[];
		mountedTools?: string[];
		agent?: string;
		modelRole?: string;
		resolvedModel?: string;
		perCallModel?: boolean;
		perCallModelIdentity?: string;
		perCallThinkingLevel?: ConfiguredThinkingLevel | null;
		retryFallback?: RetryFallbackRole;
		readOnly?: boolean;
		outputSchema?: unknown;
		outputSchemaMode?: StructuredSubagentSchemaMode;
		restrictToolNames?: boolean;
		spawns?: string;
		readSummarize?: boolean;
		advisor?: string;
		compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
		isolated?: boolean;
		workPoolYieldItems?: WorkPoolYieldItem[];
		spawnSpec?: SubagentSpawnSpec;
		spawnCallId?: string;
		heldChangeBase?: HeldChangeBase;
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		options: {
			details?: T;
			fromExtension?: boolean;
			preserveData?: Record<string, unknown>;
			method?: CompactionMethod;
			providerReplayThroughEntryId?: string;
			tokensAfter?: number;
		} = {},
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			tokensAfter: options.tokensAfter,
			method: options.method,
			providerReplayThroughEntryId: options.providerReplayThroughEntryId,
			details: options.details,
			fromExtension: options.fromExtension,
			preserveData: options.preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append the durable conversation boundary recorded by `/clear`. The
	 * collapsed live transcript and the model-context rebuild start after the
	 * latest one, while the full history stays on disk (the plain
	 * `transcript:true` export walks it unchanged).
	 */
	appendResetBoundary(): string {
		const entry: ResetBoundaryEntry = { type: "reset_boundary", ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Rewrite the session file after in-place entry updates (e.g. pruning old tool
	 * outputs). Use sparingly. It persists content changes only; re-parenting
	 * entries in place is not supported. A failed rewrite leaves later appends
	 * incremental, and its edits reach the file with the next full rewrite.
	 * Field updates that {@link patchEntries} can describe go through it instead.
	 */
	async rewriteEntries(): Promise<void> {
		this.#bodyRevision++;
		if (!this.#persist || !this.#sessionFile) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Set fields on entries this session holds and persist them as one appended
	 * `entry_patch` record, whose size follows the patched fields rather than
	 * the transcript; whole-file readers replay it on load (`entry-patches.ts`).
	 * Bumps the body revision, as {@link rewriteEntries} does, so observers of
	 * in-place updates (the thread publisher) republish the entries. The record
	 * holds its own copy of each value, and an entry keeps a value it already
	 * holds (an elide pass passes a message's own `content`), so no entry
	 * shares an object with the record.
	 *
	 * When a target's line, as this manager last loaded or wrote it, holds
	 * {@link TRANSCRIPT_READ_CAP} bytes or more (a collab guest cannot fetch
	 * it), the fields are set and the file is rewritten, as
	 * {@link rewriteEntries} does, instead: a record would leave that line whole.
	 *
	 * Rejects before changing anything when a patch names an entry this
	 * session lacks or a field that entry's kind does not have, or when the
	 * record as its line holds it fails the check every reader applies (a
	 * count that is not a finite number writes as `null`): a reader skips such
	 * a record whole, its valid patches with it. A failed write does not
	 * reject: like every append, it reaches the persistence-error observers,
	 * the fields stay set, and the next successful write lands them. Resolves
	 * once pending writes, the record's or the rewrite's included, have settled.
	 */
	async patchEntries(patches: readonly EntryPatch[]): Promise<void> {
		if (patches.length === 0) return;
		const data = toEntryPatchData(patches);
		const changes = patches.map(patch => {
			const target = this.#index.get(patch.entryId);
			if (!target || !entryAcceptsPatch(target, patch)) {
				throw new Error(`Entry patch does not fit session entry ${patch.entryId}`);
			}
			return { target, patch };
		});
		// The record as its line holds it, as deep as a transcript line nests (an elided turn's tool call).
		const written = stringifyDeepJson(data, RECORD_LINE_JSON);
		if (!isEntryPatchData(JSON.parse(written ?? "null"))) {
			throw new Error("Entry patch holds a value its session line cannot hold");
		}
		for (const { target, patch } of changes) setPatchedFields(target, patch);
		const rewrite = patches.some(patch => this.#oversizedLines.has(patch.entryId));
		if (!rewrite) {
			this.#bodyRevision++;
			this.appendCustomEntry(ENTRY_PATCH_CUSTOM_TYPE, data);
		}
		try {
			await (rewrite ? this.rewriteEntries() : this.flush());
		} catch (error) {
			this.#noteDiskFailure(error);
		}
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 * @param tag Caller correlation id of the input the message came from
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
		timestamp?: number,
		tag?: string,
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const fresh = this.#freshEntryFields();
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...(tag !== undefined && { tag }),
			...fresh,
			// Prefer the initiating message's own timestamp: without it the entry
			// records the emission time, which on rebuild excludes provider
			// preparation / hook time from the prompt→yield anchor.
			timestamp: timestamp !== undefined ? new Date(timestamp).toISOString() : fresh.timestamp,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append `message`, a custom message the agent was sent, as its entry ({@link appendCustomMessageEntry}). The entry
	 * keeps the message's own timestamp: what names a turn by it (the image clamp, the date/cwd reminder) finds, after
	 * a re-read, the same turn the model was sent.
	 */
	appendCustomMessage<T>(message: CustomMessage<T>): string {
		return this.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
			message.attribution,
			message.timestamp,
		);
	}

	/** Append a TTSR injection entry recording which rules were injected. */
	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** All unique TTSR rule names injected on the current branch (root → leaf). */
	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	/** Append a credential pin recording which OAuth account served `provider`. */
	appendCredentialPin(provider: string, hash: string): string {
		const entry: CredentialPinEntry = {
			type: "credential_pin",
			...this.#freshEntryFields(),
			provider,
			hash,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Latest credential pin per provider on the current branch (root → leaf),
	 * with the effective last-use time of the pinned account.
	 *
	 * Pins are appended only when the serving account *changes*, so a long
	 * session on one account carries a single old pin entry. Any assistant turn
	 * for the same provider after that pin was necessarily served by the pinned
	 * account, so its timestamp advances `lastUsedAt` — a resume seconds after
	 * the last turn seeds a warm sticky instead of a stale one.
	 */
	getCredentialPins(): Map<string, { hash: string; lastUsedAt: number }> {
		const pins = new Map<string, { hash: string; lastUsedAt: number }>();
		for (const entry of this.getBranch()) {
			if (entry.type === "credential_pin") {
				pins.set(entry.provider, { hash: entry.hash, lastUsedAt: new Date(entry.timestamp).getTime() });
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const pin = pins.get(entry.message.provider);
				if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
			}
		}
		return pins;
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded. `skipEphemeral` passes over temporary
	 * switches (retry fallback hops, prewalk, context promotion), returning the
	 * role the session was last assigned.
	 */
	getLastModelChangeRole(options?: { skipEphemeral?: boolean }): string | undefined {
		return lastModelChangeRole(this.#index.branchView(), options);
	}

	/**
	 * The newest model change on the current branch when it selected a model for
	 * this session only (`temporary`, or a prewalk handoff); undefined when the
	 * newest change assigned a role, was a retry fallback hop, or none was recorded.
	 */
	getSessionLocalModelChange(): ModelChangeEntry | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "model_change") continue;
			return entry.role === "temporary" || entry.role === PREWALK_MODEL_CHANGE_ROLE ? entry : undefined;
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.#index.get(id);
	}

	/** All direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	/**
	 * Set or clear a label on an entry. Pass undefined/empty to clear.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from an entry to root, returning entries in path order. Includes all
	 * entry types; use buildSessionContext() for the resolved LLM messages.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	/**
	 * The active-leaf branch (same entries as `getBranch()`) without the
	 * defensive copy. The array is the manager's memo: never mutate it. It is
	 * live — an entry appended to the current leaf is pushed onto it — so use
	 * `getBranch()` when you need a snapshot that survives appends.
	 */
	getBranchView(): readonly SessionEntry[] {
		return this.#index.branchView();
	}

	/**
	 * The active-leaf branch from the cut on: the first entry the model context
	 * keeps of the latest compaction (see `coldCutPathIndex`) to the leaf. Their
	 * bodies stay in memory, except the records no turn reads there (patch
	 * records, `session_exit` records, a user's to-do edit, a to-do HUD choice
	 * or a mode change older than the newest of its kind, a compaction older
	 * than the one the context starts from), so a reader of the recent turns
	 * reads no older body.
	 * The whole branch when the context uses no compaction.
	 */
	getBranchFromCut(): SessionEntry[] {
		const branch = this.#index.branchView();
		return branch.slice(coldCutPathIndex(branch, readCompactions(branch, this.#coldCutModel)));
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: SessionContextBuildOptions): SessionContext {
		// Entries the new cut keeps become whole before the build reads them;
		// the ones it leaves behind go cold once the context no longer holds them.
		const boundary = this.#staleColdBoundary(options);
		if (boundary) this.#applyColdBoundary(boundary, "hydrate");
		const context = buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), {
			resolveFrameData: data => this.resolveFrameData(data),
			...options,
		});
		if (boundary) {
			// Applied: a hydration or a build that throws leaves the cut stale, so
			// the next build applies it again instead of reading the entries it
			// keeps through their accessors.
			this.#coldCutStale = false;
			if (this.#coldStoreTakesRecords()) this.#applyColdBoundary(boundary, "convert");
		}
		return context;
	}

	/**
	 * The display transcript (`buildSessionContext({ transcript: true })`) of
	 * the active branch from its newest compaction on. The full transcript ends
	 * with these same messages, since that compaction renders as its summary
	 * there too, so a reader of the last turns (the retry check of an idle
	 * session) gets them without reading an entry before the compaction.
	 */
	buildTranscriptSinceCompaction(): SessionContext["messages"] {
		const branch = this.#index.branchView();
		const start = branch.findLastIndex(entry => entry.type === "compaction");
		if (start < 0) return this.buildSessionContext({ transcript: true }).messages;
		return buildSessionContext(branch.slice(start), this.#index.leafId(), undefined, {
			transcript: true,
			resolveFrameData: data => this.resolveFrameData(data),
		}).messages;
	}

	/** Prompt blocks for a snapcompact archive, budgeted and resolved as {@link buildSessionContext} attaches them. */
	snapcompactHistoryBlocks(archive: snapcompact.Archive): (TextContent | ImageContent)[] {
		const resolveFrameData = (data: string) => this.resolveFrameData(data);
		return snapcompact.historyBlocks(archive, snapcompactHistoryBlockOptions(archive, { resolveFrameData }));
	}

	/** A snapcompact frame's payload, read from the blob store when persistence externalized it. */
	resolveFrameData(data: string): snapcompact.LazyFrameData | undefined {
		return lazyImageDataSync(this.#blobs, data);
	}

	/** Strip stale OpenAI Responses replay metadata from loaded assistant entries. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		// A cold entry was sanitized when it was loaded, before it went cold.
		for (const entry of this.#entries) {
			if (!isColdEntry(entry) && SessionManager.#sanitizeLoadedEntry(entry)) changed = true;
		}
		if (changed) this.#bodyRevision++;
		return changed;
	}

	/** {@link sanitizeLoadedOpenAIResponsesReplayMetadata} for one entry; whether it changed. */
	static #sanitizeLoadedEntry(entry: SessionEntry): boolean {
		if (entry.type !== "message" || entry.message.role !== "assistant") return false;
		const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
		if (sanitized === entry.message) return false;
		entry.message = sanitized;
		return true;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	static getInheritedProviderPromptCacheKey(header: SessionHeader | undefined): string | undefined {
		return header?.taskPromptCacheKey !== undefined ? undefined : (header?.providerPromptCacheKey ?? header?.id);
	}

	/** Seed automatic affinity without turning a legacy fork identity into an explicit override. */
	async setTaskPromptCacheKey(key: string): Promise<void> {
		if (this.#header.taskPromptCacheKey === key && this.#header.providerPromptCacheKey === undefined) return;
		this.#header.taskPromptCacheKey = key;
		this.#header.providerPromptCacheKey = undefined;
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically();
	}

	/**
	 * Stash the parent-derived sibling family candidate without touching the
	 * header. Unlike {@link setTaskPromptCacheKey} this is neither persisted nor
	 * carried into forks, moves, or new-session resets, so a fresh identity
	 * starts without it while the per-request policy gate still decides whether
	 * this session's requests consume it.
	 */
	setTaskSiblingCandidate(key: string): void {
		this.#taskSiblingCandidate = key;
	}

	/** Stashed sibling family candidate; consumed only when the request model opts in. */
	getTaskSiblingCandidate(): string | undefined {
		return this.#taskSiblingCandidate;
	}

	/** Drop the stash: a committed switch to a different session adopts that session's identity. */
	clearTaskSiblingCandidate(): void {
		this.#taskSiblingCandidate = undefined;
	}

	/** All session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return [...this.#entries];
	}

	/** How much of the session lives in its cold entry store; for diagnostics and tests. */
	coldStoreStats(): ColdStoreStats {
		let coldEntries = 0;
		for (const entry of this.#entries) if (isColdEntry(entry)) coldEntries++;
		const store = this.#coldStore;
		return {
			coldEntries,
			storeBytes: store?.bytes ?? 0,
			materializations: store?.materializations ?? 0,
			hydrations: store?.hydrations ?? 0,
			storeInMemory: store?.inMemory ?? false,
			compressedBytes: store?.compressedBytes ?? 0,
		};
	}

	/**
	 * Change nested values of the entry `id` in place: a cold entry's values
	 * read back frozen, so it is made whole first, `update` runs on it, and it
	 * goes back to the store with its new body. Persist with
	 * {@link rewriteEntries} afterwards, as for any in-place update.
	 */
	updateEntryBody<T>(id: string, update: (entry: SessionEntry) => T): T {
		const entry = this.#index.get(id);
		if (!entry) throw new Error(`Entry ${id} not found`);
		const wasCold = hydrateColdEntry(entry);
		const result = update(entry);
		if (wasCold) convertToColdEntry(entry, () => this.#openColdStore());
		return result;
	}

	/**
	 * Put back in the store, with the values they hold now, the entries before
	 * the cut (or off the current path) that a write made whole. A write to a
	 * field of a cold entry makes it whole: a prune pass blanking a result
	 * before the cut, or a failed persist restoring the previous values; this
	 * returns the entry to the store, to its former record when the values are
	 * unchanged.
	 */
	recoolEntries(): void {
		if (!this.#coldStoreEnabled || !this.#coldStoreTakesRecords()) return;
		this.#applyColdBoundary(coldBoundary(this.#entries, this.#index.branchView(), this.#coldCutModel), "convert");
	}

	/** {@link conversationTip} of the session at its active leaf. */
	getConversationTip(): SessionEntry | undefined {
		return conversationTip(this.#entries, this.#index.branchView());
	}

	/**
	 * The session as a tree. A well-formed session has exactly one root; orphaned
	 * entries (broken parent chain) are returned as roots too.
	 */
	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	/**
	 * Move the leaf to an earlier entry so the next append forms a new branch.
	 * Existing entries are never modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#setLeaf(null);
	}

	/**
	 * Durably move the active branch past a discarded entry.
	 *
	 * The loader reconstructs the active branch from the last physical journal
	 * entry, so changing the in-memory leaf alone is lost on reload. A
	 * metadata-only branch marker under the discarded entry's parent moves the
	 * leaf, followed by fresh copies of the entry's children when they are all
	 * `service_tier_change` entries; a subtree that may carry content stays
	 * off-branch as it is. The discard only appends, so it survives a restart
	 * while full rewrites fail.
	 *
	 * The discarded entry stays in the journal off-branch, so a discarded
	 * assistant turn keeps its billed usage: session totals and `omp stats`
	 * count every entry.
	 */
	async discardEntryDurably(entryId: string): Promise<void> {
		const entry = this.#index.get(entryId);
		if (!entry) return;
		const children = this.#index.childrenOf(entryId);
		this.branchWithSummary(entry.parentId, "", { kind: DISCARDED_ENTRY_BRANCH_MARKER, discardedEntryId: entryId });
		if (children.every((child): child is ServiceTierChangeEntry => child.type === "service_tier_change")) {
			for (const child of children) this.appendServiceTierChange(child.serviceTier);
		}
		await this.flush();
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			runtime: currentRuntimeIdentity(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to `leafId`.
	 * Label entries are left out and the labels of kept entries re-created after the
	 * last one under new ids; an entry that followed a left-out label hangs from that
	 * label's parent, so every kept entry points at one the copy holds
	 * ({@link newestCopiedEntryId} names the newest entry kept under its own id).
	 * With `copyArtifacts`, the source artifact directory is copied in the background;
	 * the new artifact manager waits for it before allocating ids or resolving
	 * `artifact://`, so kept references stay valid and new ids cannot collide.
	 * Returns the new file path, or undefined when not persisting.
	 *
	 * Callers `flush()` first. On a store that defers sync publishes, the
	 * branch's publish supersedes a still-unconfirmed publish of the source,
	 * so entries the source had not yet published reach only the branch.
	 */
	createBranchedSession(leafId: string, options?: { copyArtifacts?: boolean }): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);

		// Drop label entries from the path; recreate them fresh from the resolved map.
		// An entry after a dropped label takes the label's own (kept) parent.
		// Every kept entry lies on the forked path, so a late-usage or off-branch leaf
		// marker no longer applies.
		const entriesToKeep: SessionEntry[] = [];
		const droppedLabelParents = new Map<string, string | null>();
		for (const entry of branchPath) {
			const parentId =
				entry.parentId !== null && droppedLabelParents.has(entry.parentId)
					? (droppedLabelParents.get(entry.parentId) ?? null)
					: entry.parentId;
			if (entry.type === "label") {
				droppedLabelParents.set(entry.id, parentId);
				continue;
			}
			const reparented = parentId !== entry.parentId;
			if (!reparented && entry.activeLeafId === undefined) {
				entriesToKeep.push(entry);
				continue;
			}
			const overrides: { parentId?: string | null; activeLeafId?: undefined } = {};
			if (reparented) overrides.parentId = parentId;
			if (entry.activeLeafId !== undefined) overrides.activeLeafId = undefined;
			// A cold entry is copied as a new cold entry over the same record; a whole one as a shallow copy.
			entriesToKeep.push(isColdEntry(entry) ? copyColdEntry(entry, overrides) : { ...entry, ...overrides });
		}
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		this.#reconcileSessionDirForFallback();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				runtime: currentRuntimeIdentity(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#header = header;
		this.#entries = [...entriesToKeep, ...labels];
		this.#recordLeftSession(this.#sessionId, sourceSessionFile);
		this.#sessionId = newSessionId;
		this.#taskSiblingCandidate = undefined;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#reindexEntries();
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#forceFileCreation = this.#persist;

		if (!this.#persist) {
			this.#sessionFile = undefined;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			this.#notifySessionFileChanged(sourceSessionFile);
			return undefined;
		}

		this.#sessionFile = newSessionFile;
		if (options?.copyArtifacts && sourceSessionFile) {
			this.#pendingArtifactCopy = {
				sessionFile: newSessionFile,
				done: copySessionArtifacts(sourceSessionFile, newSessionFile, this.#storage),
			};
		}
		this.#expectedDiskSize = null;
		this.#oversizedLines = new Set();
		this.#rewriteSynchronously();
		this.#rememberBreadcrumb(this.#cwd, newSessionFile);
		this.#notifySessionFileChanged(sourceSessionFile);
		return newSessionFile;
	}

	/** Resolve the canonical default session directory for a cwd. */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in the session header)
	 * @param sessionDir Optional session directory; defaults to the cwd-derived dir.
	 * @param options New-session options; `sessionId` names the session instead of a minted id, and
	 *   `suppressBreadcrumb` keeps the terminal's last-session record untouched.
	 */
	static create(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
		options?: NewSessionOptions & { suppressBreadcrumb?: boolean },
	): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#resetToNewSession(options);
		return manager;
	}

	/**
	 * Create a new session under a launcher-chosen id, reserved for this process. The session claims
	 * the id's ownership lease first, then asks `isHeld` whether a stored session already holds it,
	 * and only then writes its header and records itself as the terminal's last session. So a second
	 * launch under the id, in another live process, finds it taken, and a later one finds it stored.
	 * Writes nothing when another live process owns the id or `isHeld` answers `true`.
	 *
	 * On a storage that confirms claims (`acquireSessionClaim`, SQL storage) the claim is the one the
	 * database confirmed, so two launches on PostgreSQL or MySQL cannot both pass it.
	 *
	 * The header is first published on the condition that its file does not exist yet, so a launch
	 * that drew the same file name (the same id at the same millisecond) loses there instead of
	 * taking the other launch's identical bytes for its own. A store with no ownership lease (a SQL
	 * store built without `claims`) still cannot make the `isHeld` check atomic for two different file
	 * names: there each launch looks again once its own header is durable in the shared store, and
	 * withdraws (deleting what it wrote) when another session is named for the id, so at most one
	 * goes on; two that each see the other both withdraw. A launch that loses either way reports
	 * `owned-elsewhere`: the other launch is creating the session now, so this one must not resume it.
	 */
	static async createWithSessionId(
		cwd: string,
		sessionDir: string | undefined,
		sessionId: string,
		isHeld: () => Promise<boolean>,
	): Promise<SessionIdCreation> {
		const manager = SessionManager.create(cwd, sessionDir, undefined, { sessionId, suppressBreadcrumb: true });
		// SQL storage answers a claim only once the database has; wait for it, as an opened session does.
		const ownedElsewhere = manager.#storage.acquireSessionClaim
			? (await manager.#holdClaim()) !== "held"
			: manager.#sessionOwnedElsewhere();
		if (ownedElsewhere) {
			await manager.close();
			return { status: "owned-elsewhere" };
		}
		if (await isHeld()) {
			await manager.close();
			return { status: "held" };
		}
		const sessionFile = manager.#sessionFile;
		if (sessionFile) {
			const body = manager.#serializeBody();
			try {
				await manager.#storage.writeTextAtomic(sessionFile, Array.from(body.lines).join(""), {
					expectedSize: null,
				});
			} catch (error) {
				if (!(error instanceof SessionWriteConflictError)) throw error;
				await manager.close();
				return { status: "owned-elsewhere" };
			}
			manager.#expectedDiskSize = body.bytes;
			manager.#oversizedLines = new Set(body.oversizedLines);
		}
		await manager.ensureOnDisk();
		if (!manager.#storage.claimSession && (await manager.#anotherSessionNamesThisId())) {
			const written = manager.#sessionFile;
			await manager.close();
			if (written) {
				await manager.#storage.deleteSessionWithArtifacts(written);
				// Durable before the refusal, so the launch that goes on never sees this one again.
				await manager.#storage.drain();
			}
			return { status: "owned-elsewhere" };
		}
		manager.#suppressBreadcrumb = false;
		if (manager.#sessionFile) manager.#rememberBreadcrumb(manager.#cwd, manager.#sessionFile);
		return { status: "created", manager };
	}

	/**
	 * Claim this process's ownership of the stored session `sessionId` at `sessionPath` before
	 * opening it, as {@link renameSessionTitle} does, so a caller can refuse a session another
	 * live omp process owns before opening it changes anything. Resolves to the release callback, or
	 * `null` while another live process owns the session. The claim is not a writer's, so the
	 * manager that opens the session takes its own writer claim beside it
	 * ({@link claimOpenedSession}, {@link isOwnedElsewhere}); release this one after that. A storage
	 * that claims nothing answers with a no-op release.
	 *
	 * It waits for a holder as {@link claimOpenedSession} does: SQL storage answers only once the
	 * database has, after waiting up to `waitMs` for the holder's lease to go or expire; file storage
	 * waits only under `OMP_SESSION_EXCLUSIVE=1`, trying the lease again every
	 * {@link OPEN_FILE_CLAIM_RETRY_MS} until `waitMs` runs out. `onWait` hears once that it waits.
	 */
	static async claimStoredSession(
		sessionPath: string,
		sessionId: string,
		options: { waitMs?: number; onWait?: (holder: SessionClaimHolder | undefined) => void } = {},
	): Promise<(() => void) | null> {
		const storage = defaultSessionStorage();
		if (storage.acquireSessionClaim) return await storage.acquireSessionClaim(sessionId, sessionPath, options);
		if (!storage.claimSession) return () => {};
		const deadline = Date.now() + (isSessionExclusive() ? (options.waitMs ?? 0) : 0);
		let waiting = false;
		for (;;) {
			const release = storage.claimSession(sessionId, sessionPath);
			const left = deadline - Date.now();
			if (release || left <= 0) return release;
			if (!waiting) {
				waiting = true;
				options.onWait?.(undefined);
			}
			await Bun.sleep(Math.min(OPEN_FILE_CLAIM_RETRY_MS, left));
		}
	}

	/**
	 * Whether a stored session other than this one is named for this session's id, read from the
	 * shared store once this manager's own writes are durable there.
	 */
	async #anotherSessionNamesThisId(): Promise<boolean> {
		await this.#storage.drain(this.#sessionFile);
		await this.#storage.refresh?.();
		const suffix = `_${this.#sessionId}.jsonl`;
		const own = this.#sessionFile ? path.resolve(this.#sessionFile) : undefined;
		// Key-indexed stores match only `*`, `*.ext` and exact names, so the id is matched here.
		const files = this.#storage.listAllSync?.() ?? this.#storage.listFilesSync(this.#sessionDir, "*.jsonl");
		return files.some(file => file.endsWith(suffix) && path.resolve(file) !== own);
	}

	/**
	 * Create a fresh empty session file in the default session directory for
	 * `cwd`, writing only the session header. The returned path can be passed to
	 * `setSessionFile` / `AgentSession.switchSession` when a caller explicitly
	 * needs a brand-new persisted session at a cwd-derived path.
	 */
	static createEmptySessionFile(cwd: string, storage: SessionStorage = defaultSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`);
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Artifacts are copied
	 * recursively by default; nested agents that deliberately share their parent's
	 * artifact root may disable this with `copyArtifacts: false`.
	 *
	 * `seance` creates a read-only consult fork instead: artifacts stay in the
	 * source (the header's `seanceSource` points lookups at them), inherited
	 * workspace roots are dropped, and the source's `session_init` contracts
	 * become inert `source_session_init` custom entries so revival never
	 * mistakes them for the fork's own.
	 *
	 * `storeMasking` is the binding of the session that owns the fork ({@link setStoreMasking}).
	 * The fork is written here, before any session binds the new manager, so it masks by its
	 * owner's `secrets.maskSessionStore` and agent dir; without it, as an unbound manager does.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
		options?: {
			copyArtifacts?: boolean;
			suppressBreadcrumb?: boolean;
			sessionFile?: string;
			resetInheritedCost?: boolean;
			repairInterruptedTail?: boolean;
			seance?: boolean;
			/** @internal `false` holds every entry in memory instead of moving older ones to a cold store. */
			coldStore?: boolean;
			storeMasking?: StoreMaskingBinding;
		},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage, options?.coldStore);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		if (options?.storeMasking) manager.setStoreMasking(options.storeMasking);

		// A missing source must fail instead of forking an empty parentless session:
		// the loader swallows ENOENT by default for fresh-session opens, so fork opts out.
		let loaded: LoadedTranscript;
		try {
			loaded = await manager.#loadTranscript(sourcePath, {
				throwIfMissing: true,
				fork: { resetInheritedCost: options?.resetInheritedCost, seance: options?.seance },
			});
		} catch (err) {
			if (isEnoent(err) || isEnotdir(err)) throw new ForkSourceNotFoundError(sourcePath);
			throw err;
		}

		const sourceHeader = loaded.header;
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: SessionManager.getInheritedProviderPromptCacheKey(sourceHeader),
				taskPromptCacheKey: sourceHeader?.taskPromptCacheKey,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#additionalDirectories = options?.seance
			? []
			: (sourceHeader?.additionalDirectories ?? []).filter(d => d !== path.resolve(cwd));
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? manager.#additionalDirectories : undefined;
		if (options?.seance) manager.#header.seanceSource = path.resolve(sourcePath);
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		const history = loaded.entries;
		manager.#entries = history;
		manager.#loadRevision++;
		manager.#index = loaded.index;
		manager.#resetColdCut(loaded.coldStore, false);
		// Stripped replay metadata changed loaded entries in place, as a resume counts it.
		if (loaded.sanitized) manager.#bodyRevision++;
		SessionManager.#releaseLoadedTranscript(loaded);
		if (options?.repairInterruptedTail) {
			const repairedFrom = history.length;
			SessionManager.#repairForkedInterruptedTail(history, manager.#index.pathTo());
			for (const entry of history.slice(repairedFrom)) manager.#index.insert(entry);
		}
		try {
			await manager.#writeNewSessionFile();
			if (!options?.seance && options?.copyArtifacts !== false) {
				await copySessionArtifacts(sourcePath, manager.#sessionFile!, storage);
			}
		} catch (error) {
			// No caller gets the fork to close, so the store its load opened closes now, not at a collection.
			manager.#releaseColdStore();
			throw error;
		}
		return manager;
	}

	/** An inherited `session_init` entry as an inert custom entry keeping the same tree position. */
	static #neutralizedSessionInit(entry: SessionInitEntry): CustomEntry {
		return {
			type: "custom",
			customType: "source_session_init",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			data: entry,
		};
	}

	/**
	 * Zero the monetary attribution (cost, credits, premium requests) of one
	 * forked entry: an assistant turn or a completed `task` result, in place.
	 *
	 * A tan fork is a fresh agent that inherits the parent's transcript purely
	 * for context; its spend must reflect only its own work. Session cost is
	 * derived by summing `usage.cost` over the transcript, so without this the
	 * clone's Agent Hub row would open at the parent's entire accumulated cost.
	 * Token counts are left intact — compaction anchors and context math depend
	 * on them — since only billing attribution is inherited, not context size.
	 */
	static #resetInheritedUsageCost(entry: SessionEntry): void {
		resetUsageCost(entryUsage(entry));
		if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "task") {
			resetTaskResultBilling(entry.message.details);
		}
	}

	/**
	 * Pair unresolved calls on the fork's active branch with diagnostic results.
	 *
	 * Forks can be taken while the source parent is still running. A result that
	 * arrives later is only present in that parent's history, so the child must
	 * preserve an unknown outcome instead of asserting the tool never ran.
	 *
	 * A source whose process exit follows its last message is no longer running;
	 * it keeps the resume recovery instead: startup warns about the pending
	 * calls, then pairs them with process-exit results and the interrupted-turn
	 * abort record.
	 *
	 * Sibling branches are excluded: only the root-to-active-leaf path is copied.
	 */
	static #repairForkedInterruptedTail(history: SessionEntry[], branch: readonly SessionEntry[]): void {
		const leaf = branch.at(-1);
		if (!leaf || sessionExitFollowsLastMessage(branch)) return;
		const results = createInterruptedToolResults(branch, "fork");
		if (results.length === 0) return;
		const usedIds = new Set(history.map(entry => entry.id));
		let parentId = leaf.id;
		for (const result of results) {
			const id = generateId(usedIds);
			usedIds.add(id);
			const entry: SessionMessageEntry = {
				type: "message",
				id,
				parentId,
				timestamp: nowIso(),
				runtime: currentRuntimeIdentity(),
				message: result,
			};
			history.push(entry);
			parentId = id;
		}
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 * @param options.throwIfMissing Propagate ENOENT instead of creating a new session at a missing path.
	 * @param options.parentSession Parent session file recorded when the file is empty or missing.
	 * @param options.coldStore `@internal` `false` holds every entry in memory instead of moving older ones to a cold store.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
		options?: {
			initialCwd?: string;
			parentSession?: string;
			suppressBreadcrumb?: boolean;
			throwIfMissing?: boolean;
			coldStore?: boolean;
		},
	): Promise<SessionManager> {
		return SessionManager.#open(filePath, sessionDir, storage, options, { awaitPendingAppends: true });
	}

	/**
	 * {@link open}; `awaitPendingAppends` waits for the file's pending
	 * {@link appendCustomEntriesToFile} writes first, which that writer's own load must not do.
	 */
	static async #open(
		filePath: string,
		sessionDir: string | undefined,
		storage: SessionStorage,
		options:
			| {
					initialCwd?: string;
					parentSession?: string;
					suppressBreadcrumb?: boolean;
					throwIfMissing?: boolean;
					coldStore?: boolean;
			  }
			| undefined,
		internal: { awaitPendingAppends: boolean },
	): Promise<SessionManager> {
		if (internal.awaitPendingAppends) await SessionManager.#pendingAppends.get(path.resolve(filePath));
		// A streamed transcript yields only its header here; its entries stream in below.
		const probed = await probeSessionFile(filePath, storage, {
			throwIfMissing: options?.throwIfMissing,
			digest: options?.throwIfMissing,
		});
		const probedCwd = probed.header?.cwd;
		const workspace = SessionManager.#openWorkspace(
			probedCwd,
			!!probedCwd && (await directoryIsEnterable(probedCwd)),
			filePath,
			sessionDir,
			options?.initialCwd,
			storage,
		);
		const manager = new SessionManager(workspace.cwd, workspace.sessionDir, true, storage, options?.coldStore);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		// Fail-closed callers yield while probing the recorded cwd. Before
		// adoption, digest the current content and parse again only if it
		// differs from the snapshot parsed above. A deleted, truncated, or
		// replaced transcript then still fails closed, and a stable
		// multi-gigabyte session is read once more but parsed only once. A
		// streamed transcript was not parsed above: it streams in after the probe.
		const preloaded =
			probed.loaded && options?.throwIfMissing && !(await sessionSnapshotIsCurrent(storage, filePath, probed.loaded))
				? undefined
				: probed.loaded;
		await manager.#setSessionFile(filePath, {
			throwIfMissing: options?.throwIfMissing,
			newSession: { parentSession: options?.parentSession },
			preloaded,
			appendsAwaited: true,
			opened: { probedCwd, sessionDir, initialCwd: options?.initialCwd },
		});
		// A finished async call can stay referenced by an engine cache; drop the
		// probe's copy of the entries so it cannot outlive the manager's.
		if (probed.loaded) probed.loaded.entries = [];
		return manager;
	}

	/**
	 * The cwd and session dir {@link open} resumes a session in whose header
	 * records `recordedCwd`: that cwd only when `recordedCwdUsable`, the
	 * caller's check that it is verifiably accessible. A deleted or
	 * permission-blocked (macOS TCC denial) project dir would make the
	 * constructor's #cwd — and the `setProjectDir` chdir interactive mode runs
	 * next — fail, so fall back to `initialCwd` (the launch cwd by default) and
	 * anchor /new and /branch there too, keeping the resumed session where the
	 * user already is. `sessionDir` when given, else the file's parent.
	 */
	static #openWorkspace(
		recordedCwd: string | undefined,
		recordedCwdUsable: boolean,
		filePath: string,
		sessionDir: string | undefined,
		initialCwd: string | undefined,
		storage: SessionStorage,
	): { cwd: string; sessionDir: string } {
		const cwd = recordedCwd && recordedCwdUsable ? recordedCwd : (initialCwd ?? getProjectDir());
		return {
			cwd,
			sessionDir:
				sessionDir ??
				(recordedCwd && !recordedCwdUsable
					? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
					: path.dirname(path.resolve(filePath))),
		};
	}

	/**
	 * Whether `session` was recorded in a worktree of `cwd`'s repository that no
	 * longer exists, e.g. a `/wt` worktree removed since. Resume such a session
	 * through {@link openRelocated} into `cwd`: its own directory cannot be entered.
	 * @param sessionDir `cwd`'s session directory; defaults to the cwd-derived one.
	 */
	static async isFromRemovedWorktree(
		session: Pick<SessionInfo, "path" | "cwd">,
		cwd: string,
		sessionDir?: string,
	): Promise<boolean> {
		if (!session.cwd || !(await directoryIsMissing(session.cwd))) return false;
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd);
		const home = path.resolve(path.dirname(session.path));
		return (await worktreeSessionDirs(cwd, dir)).some(sibling => path.resolve(sibling) === home);
	}

	/**
	 * Open a session whose recorded directory `recordedCwd` is gone and move it,
	 * artifacts included, into `cwd` so it resumes from there.
	 * @param sessionDir Target session directory; defaults to `cwd`'s.
	 * @throws {SessionMoveRefusedError} when another live omp process writes the session.
	 */
	static async openRelocated(
		sessionPath: string,
		recordedCwd: string,
		cwd: string,
		sessionDir?: string,
	): Promise<SessionManager> {
		// Anchor at the missing recorded cwd: `open` otherwise falls back to the
		// launch cwd, which would make the `moveTo` below a no-op whenever the move
		// target equals it. moveTo never chdirs, so the stale cwd is only the
		// relocation source, not a directory we enter.
		const manager = await SessionManager.open(sessionPath, sessionDir, undefined, { initialCwd: recordedCwd });
		try {
			await manager.moveTo(cwd, sessionDir);
		} catch (error) {
			await manager.close();
			throw error;
		}
		return manager;
	}

	/**
	 * Lock-free peek for cold subagent revival: returns the recorded working
	 * directory (session header) and the latest `session_init` contract (system
	 * prompt / tools / output schema) WITHOUT taking the single-writer lock that
	 * {@link open} acquires — the caller re-opens for the actual revive. Returns
	 * null when the file can't be read; `init` is null for files written before
	 * `session_init` was recorded (no faithful contract to rebuild from).
	 */
	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = defaultSessionStorage(),
	): Promise<{
		cwd: string;
		init: PersistedSessionInit | null;
		seanceSource?: string;
	} | null> {
		let header: SessionHeader | undefined;
		const initEntries: FileEntry[] = [];
		const visit = (entry: FileEntry): void => {
			if (entry.type === "session") {
				header ??= entry;
				return;
			}
			if (entry.type === "session_init") initEntries.push(entry);
		};

		try {
			// A full rewrite between two chunks of a long transcript fails the read: read it again from its start.
			await retryRacedRead(() => {
				header = undefined;
				initEntries.length = 0;
				return visitEntriesFromFile(filePath, visit, storage);
			});
		} catch {
			return null;
		}
		// A missing, empty, or invalid file has no usable session.
		if (!header) return null;
		return {
			cwd: header.cwd ?? getProjectDir(),
			init: extractSessionInit(initEntries),
			seanceSource: header.seanceSource,
		};
	}
	/**
	 * Continue the most recent session, or create a new one if none exists.
	 *
	 * When the chosen session's conversation went on in another file (it moved
	 * off its file; see `findSessionContinuation`), this opens the copy to
	 * resume instead and reports it to `onSessionContinuation`. The session the
	 * terminal's record of its last session names was chosen, as a file named
	 * to `--resume` is, so it is kept when it has turns its continuation lacks
	 * ({@link findSessionContinuation}). Without that record the pick goes by
	 * file time, and a process writes its exit record or an idle cache refresh
	 * long after its last turn, so the pick can be any copy
	 * ({@link findRecentSessionContinuation}).
	 */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
		options: {
			onSessionContinuation?: (continuation: SessionContinuation) => void;
		} = {},
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// A lazy fresh-session boundary whose JSONL was never materialized
			// (for example, initial creation followed by exit before any assistant
			// output). Honor the boundary rather than falling back to
			// findMostRecentSession(), which would resurrect an older transcript.
			// Explicit newSession() boundaries are materialized before it returns so
			// this remains correct even when the relaunch has a different terminal id.
			if (
				breadcrumb.fresh &&
				!breadcrumb.exists &&
				(!sessionDir || pathIsWithin(dir, path.dirname(breadcrumb.sessionFile)))
			) {
				const manager = new SessionManager(cwd, dir, true, storage);
				manager.#resetToNewSession();
				return manager;
			}

			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile, storage);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				if (!sessionDir || pathIsWithin(dir, breadcrumb.sessionFile)) {
					chosenSession = breadcrumb.sessionFile;
				}
			} else {
				// The terminal's last session started in a different cwd. Re-root only
				// when that cwd is gone *and* this location is the same directory
				// inode (a worktree move/rename). A missing path alone is not a move.
				// When an explicit sessionDir is reused across the move, the stale
				// breadcrumb file may be the newest entry there; prefer a genuine
				// current-cwd session.
				let newestInTargetDir = await findMostRecentNonEmptySession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !fs.existsSync(breadcrumbCwd);
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd &&
							!isEmptySession(session),
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const candidateForMove =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				// Absence of the recorded cwd is not a move: deleted, unmounted, and
				// offline paths also fail existsSync. Only re-root when the continue
				// cwd is the same directory inode the breadcrumb recorded — a rename.
				// Cross-filesystem `mv` (new inode) is intentionally not a re-root.
				const looksLikeMovedProject =
					candidateForMove && hasPositiveMovedProjectEvidence(breadcrumb.cwdIdentity, resolvedCwd);
				if (looksLikeMovedProject) {
					logger.warn("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					// The breadcrumb names this session, as a file named to `--resume` is named.
					const continuation = await findSessionContinuation(breadcrumb.sessionFile, storage);
					const manager = await SessionManager.open(
						continuation?.session.path ?? breadcrumb.sessionFile,
						undefined,
						storage,
						{ initialCwd: breadcrumbCwd },
					);
					try {
						await manager.moveTo(cwd, sessionDir);
						if (continuation) options.onSessionContinuation?.(continuation);
						return manager;
					} catch (err) {
						if (!(err instanceof SessionMoveRefusedError)) throw err;
						// Another live omp process still writes the session (the
						// project was renamed under it): leave it there and continue
						// as if no move were possible.
						logger.warn("Not re-rooting moved session: it is open in another omp process", {
							from: breadcrumbCwd,
							to: resolvedCwd,
						});
						await manager.close();
					}
				} else if (candidateForMove) {
					logger.warn(
						"Not relocating session: project directory is unavailable and there is no evidence it moved here",
						{ from: breadcrumbCwd, to: resolvedCwd },
					);
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentNonEmptySession(dir, storage);
		if (chosenSession) {
			const fromBreadcrumb = !!breadcrumb && path.resolve(chosenSession) === path.resolve(breadcrumb.sessionFile);
			const continuation = fromBreadcrumb
				? await findSessionContinuation(chosenSession, storage)
				: await findRecentSessionContinuation(chosenSession, storage);
			if (continuation) {
				options.onSessionContinuation?.(continuation);
				chosenSession = continuation.session.path;
			}
		}

		const manager = new SessionManager(cwd, dir, true, storage);
		if (chosenSession) await manager.setSessionFile(chosenSession);
		else manager.#resetToNewSession();
		return manager;
	}

	/** Create an in-memory session (no file persistence). */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * List sessions for a project directory.
	 * @param sessionDir Optional dir; defaults to the cwd-derived dir.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const sessions = await listSessions(dir, storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/** List all sessions across all project directories, pinned sessions first. */
	static async listAll(storage: SessionStorage = defaultSessionStorage()): Promise<SessionInfo[]> {
		const sessions = await listAllSessions(storage);
		return sortPinnedFirst(sessions, await loadPinnedSessionIds());
	}

	/**
	 * Picker-facing project listing in recency order (the picker floats pins),
	 * untitled empties dropped. Titled empties stay — a title is user intent worth resuming.
	 * Arrives in two passes: rows for history.db-indexed titles first, the full
	 * scan in `complete` (see {@link listSessionsForPicker}).
	 * By default includes the same folder in the repository's other git worktrees,
	 * so a session `/wt` moved stays reachable from the checkout it left.
	 * The directory scope limits the picker to its own session bucket.
	 */
	static async listForPicker(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = defaultSessionStorage(),
		worktreeScope: "directory" | "repo" = "repo",
	): Promise<PickerListing> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const [pinned, siblingDirs] = await Promise.all([
			loadPinnedSessionIds(),
			worktreeScope === "repo" ? worktreeSessionDirs(cwd, dir, storage) : [],
		]);
		return listSessionsForPicker(dir, storage, pinned, siblingDirs);
	}

	/** Picker-facing cross-project listing, same rules and passes as {@link listForPicker}. */
	static async listAllForPicker(storage: SessionStorage = defaultSessionStorage()): Promise<PickerListing> {
		return listAllSessionsForPicker(storage, await loadPinnedSessionIds());
	}
}

/** True when already-loaded entries carry at least one real user/assistant message. */
export function hasConversationalHistory(entries: readonly FileEntry[]): boolean {
	return entries.some(e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"));
}

/**
 * The persisted `session_init` contract a cold revive rebuilds a subagent from:
 * the {@link SessionInitEntry} payload without its tree bookkeeping fields.
 */
export interface PersistedSessionInit {
	systemPrompt: string[];
	task: string;
	tools: string[];
	mountedTools?: string[];
	agent?: string;
	modelRole?: string;
	resolvedModel?: string;
	perCallModel?: boolean;
	perCallModelIdentity?: string;
	perCallThinkingLevel?: ConfiguredThinkingLevel | null;
	retryFallback?: RetryFallbackRole;
	readOnly?: boolean;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	restrictToolNames?: boolean;
	spawns?: string;
	readSummarize?: boolean;
	advisor?: string;
	compactionThreshold?: { thresholdPercent: number; thresholdTokens: number };
	isolated?: boolean;
	workPoolYieldItems?: WorkPoolYieldItem[];
	/** The inputs the subagent was spawned with; absent on older files, a seance consult and a `/tan` clone. */
	spawnSpec?: SubagentSpawnSpec;
	/** The parent's top-level call the spawn was requested under ({@link SessionInitEntry.spawnCallId}). */
	spawnCallId?: string;
	/** {@link SessionInitEntry.heldChangeBase}. */
	heldChangeBase?: HeldChangeBase;
}

/**
 * Latest persisted `session_init` contract among already-loaded entries, or
 * null when the transcript carries none.
 */
export function extractSessionInit(entries: readonly FileEntry[]): PersistedSessionInit | null {
	let init: PersistedSessionInit | null = null;
	for (const entry of entries) {
		if (entry.type !== "session_init") continue;
		init = {
			systemPrompt: typeof entry.systemPrompt === "string" ? [entry.systemPrompt] : entry.systemPrompt,
			task: entry.task,
			tools: entry.tools,
			mountedTools: entry.mountedTools,
			agent: entry.agent,
			modelRole: entry.modelRole,
			resolvedModel: entry.resolvedModel,
			...(entry.perCallModel ? { perCallModel: true } : undefined),
			perCallModelIdentity: entry.perCallModelIdentity,
			perCallThinkingLevel: entry.perCallThinkingLevel,
			retryFallback: entry.retryFallback,
			readOnly: entry.readOnly,
			outputSchema: entry.outputSchema,
			outputSchemaMode: entry.outputSchemaMode,
			restrictToolNames: entry.restrictToolNames,
			readSummarize: entry.readSummarize,
			spawns: entry.spawns,
			advisor: entry.advisor,
			isolated: entry.isolated,
			...(entry.compactionThreshold !== undefined ? { compactionThreshold: entry.compactionThreshold } : undefined),
			...(entry.workPoolYieldItems !== undefined ? { workPoolYieldItems: entry.workPoolYieldItems } : undefined),
			...(entry.spawnSpec !== undefined ? { spawnSpec: entry.spawnSpec } : undefined),
			...(entry.spawnCallId !== undefined ? { spawnCallId: entry.spawnCallId } : undefined),
			...(entry.heldChangeBase !== undefined ? { heldChangeBase: entry.heldChangeBase } : undefined),
		};
	}
	return init;
}

/**
 * If the current session was created by `/move` and contains no real
 * user/assistant messages, delete it so empty move sessions don't accumulate.
 */
export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	if (hasConversationalHistory(sessionManager.getEntries())) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
