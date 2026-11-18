/**
 * A session's subagent transcripts nest in its artifacts directory
 * (`<session>/<Id>.jsonl`, `<session>/<Id>/<Id.Sub>.jsonl`, advisors as
 * `__advisor*.jsonl`). Under file storage they are files in that directory;
 * under a key-indexed storage (`session.storage: sql`) they are rows keyed by
 * the same paths, while the directory on disk holds only tool artifacts.
 * Copying, moving, or listing a session's children therefore goes through the
 * storage for the transcripts, whatever the filesystem does with the rest.
 */
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { SESSION_TITLE_SLOT_BYTES } from "./session-entries";
import { transcriptByteChunks } from "./session-loader";
import { LINE_STREAM_CHUNK, retryRacedRead, type SessionStorage, type SessionStorageWriter } from "./session-storage";
import { parseTitleSlotFromContent, titleUpdateFromSlot } from "./session-title-slot";

/**
 * Every file `storage` holds under `dir` whose name matches `pattern`
 * (default: transcripts, `*.jsonl`), at any depth, in walk order.
 */
export function listTranscriptTree(storage: SessionStorage, dir: string, pattern = "*.jsonl"): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const walk = (current: string): void => {
		const resolved = path.resolve(current);
		if (seen.has(resolved)) return;
		seen.add(resolved);
		found.push(...storage.listFilesSync(current, pattern));
		for (const name of storage.listDirsSync(current)) walk(path.join(current, name));
	};
	walk(dir);
	return found;
}

/** A transcript a tree operation placed, as `from` → `to`. */
export interface TranscriptPlacement {
	from: string;
	to: string;
}

/**
 * Copy every file the storage holds under `fromDir` whose name matches
 * `pattern` (default: transcripts) to the same relative path under `toDir`.
 * A key-indexed storage passes `*` so the session's draft row goes too. Never
 * replaces: a file already at the destination (one the filesystem copy of the
 * artifacts directory already placed, or one written there since) wins.
 * Returns the files it copied.
 */
export async function copyTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
): Promise<TranscriptPlacement[]> {
	const copied: TranscriptPlacement[] = [];
	// A shared store may hold rows another client committed since this one
	// loaded its view; a tree copy that missed them would drop children.
	await storage.refresh?.();
	for (const from of listTranscriptTree(storage, fromDir, pattern)) {
		const to = path.join(toDir, path.relative(fromDir, from));
		if (await storage.exists(to)) continue;
		// Removed since the listing: nothing left to copy.
		if (!(await copyTranscript(storage, from, to))) continue;
		copied.push({ from, to });
	}
	return copied;
}

/**
 * Copy `from` to `to` chunk by chunk, appending through a writer in batches of
 * about {@link LINE_STREAM_CHUNK}, so a transcript is never held whole and a
 * store that yields a chunk per stored part (SQL: about one per line) is not
 * appended to once per part; a title slot at its head is set on `to` as a
 * whole write would set it. Returns false, leaving nothing at `to`, when
 * `from` is gone; any other failure removes the partial copy and throws. A
 * full rewrite or delete of `from` between two chunks removes the partial
 * copy and copies `from` again from its start, as often as
 * {@link retryRacedRead} allows.
 */
export async function copyTranscript(storage: SessionStorage, from: string, to: string): Promise<boolean> {
	let head: string;
	try {
		// Each pass removes its partial copy when it fails, so a rerun after a race starts from nothing at `to`.
		head = await retryRacedRead(() => copyTranscriptPass(storage, from, to));
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	const title = titleUpdateFromSlot(parseTitleSlotFromContent(head));
	if (title) await storage.updateSessionTitle(to, title);
	return true;
}

/** One pass of {@link copyTranscript}: the head of `from` it copied; on any failure it removes the partial copy and throws. */
async function copyTranscriptPass(storage: SessionStorage, from: string, to: string): Promise<string> {
	const decoder = new TextDecoder();
	let writer: SessionStorageWriter | undefined;
	let head = "";
	let batch = "";
	try {
		for await (const chunk of transcriptByteChunks(from, storage)) {
			writer ??= storage.openWriter(to, { flags: "w" });
			const text = decoder.decode(chunk, { stream: true });
			if (head.length < SESSION_TITLE_SLOT_BYTES) head += text.slice(0, SESSION_TITLE_SLOT_BYTES - head.length);
			batch += text;
			if (batch.length < LINE_STREAM_CHUNK) continue;
			await writer.append(batch);
			batch = "";
		}
		writer ??= storage.openWriter(to, { flags: "w" });
		batch += decoder.decode();
		if (batch) await writer.append(batch);
		await writer.close();
		return head;
	} catch (err) {
		if (writer) {
			await writer.close().catch(() => {});
			await storage.unlink(to).catch(() => {});
		}
		throw err;
	}
}

/**
 * Move every file the storage holds under `fromDir` whose name matches
 * `pattern` to the same relative path under `toDir`. A key-indexed storage
 * passes `*`: it keeps the session's unsent prompt draft (`draft.txt`) beside
 * the subagent transcripts, and no directory move carries its rows. Returns
 * the files it moved, so a later failed step can move them back with
 * {@link restoreTranscripts}. All or nothing: when one move fails, the ones
 * before it are moved back before the error is thrown. A storage with a
 * refusing rename never replaces nor skips a taken destination, whether it
 * was taken before the move or another client takes it while the move runs:
 * that move fails with `EEXIST` naming it, so the session's tree never ends
 * up split or holding another session's child. Under file storage the
 * directory move already placed what it could, and a transcript whose
 * destination is taken stays where it is.
 */
export async function moveTranscriptTree(
	storage: SessionStorage,
	fromDir: string,
	toDir: string,
	pattern = "*.jsonl",
): Promise<TranscriptPlacement[]> {
	const moved: TranscriptPlacement[] = [];
	await storage.refresh?.();
	try {
		for (const from of listTranscriptTree(storage, fromDir, pattern)) {
			const to = path.join(toDir, path.relative(fromDir, from));
			if (!storage.renameNoReplace && (await storage.exists(to))) continue;
			storage.ensureDirSync(path.dirname(to));
			try {
				await (storage.renameNoReplace ? storage.renameNoReplace(from, to) : storage.rename(from, to));
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			moved.push({ from, to });
		}
	} catch (err) {
		try {
			await restoreTranscripts(storage, moved);
		} catch (rollbackErr) {
			// Not the move's own error: some transcripts stay at their new paths.
			throw new Error(
				`Failed to move subagent transcripts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
				{ cause: rollbackErr },
			);
		}
		throw err;
	}
	return moved;
}

/**
 * Move transcripts {@link moveTranscriptTree} moved back to where they were,
 * newest move first. With a refusing rename, a key another client wrote at an
 * old path since is kept: the restore fails with `EEXIST` there, leaving that
 * transcript at its new path.
 */
export async function restoreTranscripts(
	storage: SessionStorage,
	moved: readonly TranscriptPlacement[],
): Promise<void> {
	for (const { from, to } of [...moved].reverse()) {
		await (storage.renameNoReplace ? storage.renameNoReplace(to, from) : storage.rename(to, from));
	}
}
