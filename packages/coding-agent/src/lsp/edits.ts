import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEexist, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { throwIfAborted } from "../tools/tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type {
	CreateFile,
	CreateFileOptions,
	DeleteFile,
	DeleteFileOptions,
	Position,
	Range,
	RenameFile,
	RenameFileOptions,
	TextDocumentEdit,
	TextEdit,
	WorkspaceEdit,
} from "./types";
import { fileToUri, readTextFromDisk, uriToFile } from "./utils";

// =============================================================================
// Text Edit Application
// =============================================================================

/**
 * Apply text edits to a string in-memory.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export function applyTextEditsToString(content: string, edits: TextEdit[]): string {
	const lines = content.split("\n");
	const sortedEdits = sortAndValidateTextEdits(edits);

	for (const edit of sortedEdits) {
		const { start, end } = edit.range;

		// Single-line edit: replace substring within same line
		if (start.line === end.line) {
			const line = lines[start.line] || "";
			lines[start.line] = line.slice(0, start.character) + edit.newText + line.slice(end.character);
		} else {
			// Multi-line edit: splice across multiple lines
			const startLine = lines[start.line] || "";
			const endLine = lines[end.line] || "";
			const newContent = startLine.slice(0, start.character) + edit.newText + endLine.slice(end.character);
			lines.splice(start.line, end.line - start.line + 1, ...newContent.split("\n"));
		}
	}

	return lines.join("\n");
}

function comparePosition(a: Position, b: Position): number {
	return a.line === b.line ? a.character - b.character : a.line - b.line;
}
function positionsEqual(a: Position, b: Position): boolean {
	return a.line === b.line && a.character === b.character;
}

function rangesEqual(a: Range, b: Range): boolean {
	return positionsEqual(a.start, b.start) && positionsEqual(a.end, b.end);
}

function isEmptyRange(range: Range): boolean {
	return positionsEqual(range.start, range.end);
}

function formatRange(range: Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${range.end.character + 1}`;
}

/** True when two ranges overlap (share any position other than a touching boundary). */
export function rangesOverlap(a: Range, b: Range): boolean {
	return comparePosition(a.start, b.end) < 0 && comparePosition(b.start, a.end) < 0;
}

/**
 * Sort edits bottom-to-top for in-place application and reject overlaps.
 * Equal start positions tiebreak by original array index descending so that,
 * applied bottom-up, inserts at the same position land in array order
 * (LSP spec: the order of edits in the array defines the order in the result).
 * Byte-identical non-empty range edits are idempotent, so duplicate server
 * output is collapsed before overlap validation.
 */
function rejectSnippetTextEdits(edits: TextEdit[]): void {
	for (const edit of edits) {
		if ("insertTextFormat" in edit && edit.insertTextFormat === 2) {
			throw new ToolError("snippet-formatted LSP edits are unsupported");
		}
	}
}

export function sortAndValidateTextEdits(edits: TextEdit[]): TextEdit[] {
	rejectSnippetTextEdits(edits);
	const sorted = edits
		.map((edit, index) => ({ edit, index }))
		.sort((a, b) => {
			if (a.edit.range.start.line !== b.edit.range.start.line) {
				return b.edit.range.start.line - a.edit.range.start.line;
			}
			if (a.edit.range.start.character !== b.edit.range.start.character) {
				return b.edit.range.start.character - a.edit.range.start.character;
			}
			return b.index - a.index;
		})
		.map(entry => entry.edit);
	const unique: TextEdit[] = [];
	for (const edit of sorted) {
		const prev = unique[unique.length - 1];
		if (prev && !isEmptyRange(edit.range) && rangesEqual(prev.range, edit.range) && prev.newText === edit.newText) {
			continue;
		}
		unique.push(edit);
	}

	// Detect overlapping ranges: in reverse-sorted order, each edit's start
	// must be >= the next edit's end. If not, the edits would clobber each other
	// once applied bottom-up.
	for (let i = 0; i < unique.length - 1; i++) {
		const later = unique[i].range;
		const earlier = unique[i + 1].range;
		if (comparePosition(earlier.end, later.start) > 0) {
			throw new ToolError(
				`overlapping LSP edits: ${formatRange(earlier)} conflicts with ${formatRange(later)}; LSP produced inconsistent edits`,
			);
		}
	}

	return unique;
}

/**
 * Flatten a WorkspaceEdit's text edits into a Map<uri, TextEdit[]>.
 * Resource operations (create/rename/delete) are ignored — callers handle them separately.
 */
export function flattenWorkspaceTextEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
	const out = new Map<string, TextEdit[]>();
	const push = (uri: string, edits: TextEdit[]) => {
		if (edits.length === 0) return;
		const prev = out.get(uri);
		if (prev) prev.push(...edits);
		else out.set(uri, [...edits]);
	};
	if (edit.changes) {
		const changes = edit.changes;
		for (const uri in changes) push(uri, changes[uri]);
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
				const tdc = change as TextDocumentEdit;
				const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
				push(tdc.textDocument.uri, textEdits);
			}
		}
	}
	return out;
}

/**
 * Apply text edits to a file.
 * Edits are applied in reverse order (bottom-to-top) to preserve line/character indices.
 */
export async function applyTextEdits(filePath: string, edits: TextEdit[]): Promise<void> {
	const content = await readTextFromDisk(filePath);
	const result = applyTextEditsToString(content, edits);
	await Bun.write(filePath, result);
}

/** A reference file and the text edits a rename computed for it. */
export interface RenameReferenceEdit {
	filePath: string;
	edits: TextEdit[];
}

/**
 * Apply a rename's reference edits and then move `source` → `dest` as one unit.
 *
 * The reference edits (import/usage rewrites in other files) must be written
 * before the move so their positions match the pre-move file contents, but a
 * failed move must not leave those files half-rewritten: each edited file is
 * snapshotted first, and if `mkdir`/`rename` throws, every snapshot is restored
 * before the error propagates. A failed move therefore leaves the source,
 * destination, and every reference file exactly as they were.
 *
 * @throws the original `mkdir`/`rename` error, after rolling back the edits.
 */
export async function applyEditsThenRename(
	references: RenameReferenceEdit[],
	source: string,
	dest: string,
): Promise<void> {
	const backups: Array<{ filePath: string; original: string }> = [];
	for (const { filePath, edits } of references) {
		backups.push({ filePath, original: await readTextFromDisk(filePath) });
		await applyTextEdits(filePath, edits);
	}
	try {
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.rename(source, dest);
	} catch (err) {
		await Promise.all(backups.map(({ filePath, original }) => Bun.write(filePath, original)));
		throw err;
	}
}

// =============================================================================
// Workspace Edit Application
// =============================================================================

type WorkspaceEditOp =
	| { kind: "text"; uri: string; edits: TextEdit[] }
	| { kind: "create"; uri: string; options?: CreateFileOptions }
	| { kind: "rename"; oldUri: string; newUri: string; options?: RenameFileOptions }
	| { kind: "delete"; uri: string; options?: DeleteFileOptions };

/**
 * Flatten documentChanges into an ordered op list. Text edits are accumulated
 * per-URI and flushed before any resource op that touches the same URI (or,
 * for folder rename/delete, any descendant URI) so that renames, creates, and
 * deletes always see the correct prior file state.
 */
function planDocumentChanges(documentChanges: NonNullable<WorkspaceEdit["documentChanges"]>): WorkspaceEditOp[] {
	const ops: WorkspaceEditOp[] = [];
	const pending = new Map<string, TextEdit[]>();

	const flushUri = (uri: string) => {
		const edits = pending.get(uri);
		if (!edits) return;
		pending.delete(uri);
		ops.push({ kind: "text", uri, edits });
	};

	// Flush the exact URI plus every pending descendant (for folder-level
	// resource ops where the queued edits target child files of the target).
	const flushSubtree = (uri: string) => {
		const prefix = uri.endsWith("/") ? uri : `${uri}/`;
		const matches: string[] = [];
		for (const candidate of pending.keys()) {
			if (candidate === uri || candidate.startsWith(prefix)) matches.push(candidate);
		}
		for (const target of matches) {
			flushUri(target);
		}
	};

	for (const change of documentChanges) {
		if ("textDocument" in change && change.textDocument && "edits" in change && change.edits) {
			const tdc = change as TextDocumentEdit;
			const uri = tdc.textDocument.uri;
			const textEdits = tdc.edits.filter((e): e is TextEdit => "range" in e && "newText" in e);
			if (textEdits.length > 0) {
				const prev = pending.get(uri);
				if (prev) prev.push(...textEdits);
				else pending.set(uri, [...textEdits]);
			}
		} else if ("kind" in change && change.kind) {
			if (change.kind === "create") {
				const createOp = change as CreateFile;
				flushUri(createOp.uri);
				ops.push({ kind: "create", uri: createOp.uri, options: createOp.options });
			} else if (change.kind === "rename") {
				const renameOp = change as RenameFile;
				// Per LSP §3.16.2 documentChanges are applied in declared order.
				// Flush both the source subtree (so prior edits land before the move)
				// AND the destination subtree (so prior edits land on whatever exists
				// at newUri before the rename overwrites/replaces it — relevant under
				// `options.overwrite` and `options.ignoreIfExists`).
				flushSubtree(renameOp.oldUri);
				flushSubtree(renameOp.newUri);
				ops.push({
					kind: "rename",
					oldUri: renameOp.oldUri,
					newUri: renameOp.newUri,
					options: renameOp.options,
				});
			} else if (change.kind === "delete") {
				const deleteOp = change as DeleteFile;
				flushSubtree(deleteOp.uri);
				ops.push({ kind: "delete", uri: deleteOp.uri, options: deleteOp.options });
			}
		}
	}

	// Flush text edits not followed by a resource op.
	for (const uri of Array.from(pending.keys())) {
		flushUri(uri);
	}

	return ops;
}

/** One filesystem mutation actually performed by {@link applyWorkspaceEdit}. */
export type ExecutedWorkspaceChange =
	| { kind: "edit"; uri: string }
	| { kind: "create"; uri: string }
	| { kind: "rename"; oldUri: string; newUri: string }
	| { kind: "delete"; uri: string };

/** What {@link applyWorkspaceEdit} did: human-readable summaries plus the ops that really ran. */
export interface WorkspaceEditResult {
	applied: string[];
	/** Ops that mutated the filesystem — skipped `ignoreIfExists`/`ignoreIfNotExists` ops are excluded. */
	executed: ExecutedWorkspaceChange[];
}

/** How many paths a recursive delete that stops partway names; one more line counts the rest. */
const PARTIAL_DELETE_NAMED = 20;

/** A directory entry whose type the filesystem did not report (some report none). */
function isUntyped(entry: Dirent): boolean {
	return !(
		entry.isFile() ||
		entry.isDirectory() ||
		entry.isSymbolicLink() ||
		entry.isFIFO() ||
		entry.isSocket() ||
		entry.isBlockDevice() ||
		entry.isCharacterDevice()
	);
}

/** A path a recursive delete's listing found, relative to the root it deletes. */
interface ListedPath {
	relative: string;
	/** Whether the listing looks into it: a directory entry, or one with no type (read only if a directory). */
	directory: boolean;
}

/** The `relative` path's parent, relative to the same root ("" is the root). */
function parentOf(relative: string): string {
	const parent = path.dirname(relative);
	return parent === "." ? "" : parent;
}

/** A directory's identity: the device and inode `lstat` gave for it. */
type DirectoryId = { dev: bigint; ino: bigint };

/** Whether `absolute` is, by `lstat`, still the directory `id`. */
async function isSameDirectory(absolute: string, id: DirectoryId | undefined): Promise<boolean> {
	const stat = await fs.lstat(absolute, { bigint: true });
	return id !== undefined && stat.isDirectory() && stat.dev === id.dev && stat.ino === id.ino;
}

/**
 * List the paths under the directory `root`, relative to it, before a recursive delete of it, so
 * the paths it removed can be named if it fails partway. The listing only names. The delete itself
 * is Bun's recursive `rm`, which opens each directory from its parent's handle with `O_NOFOLLOW`
 * and removes each entry with `unlinkat` on that handle (Bun 1.4.4, read with strace), so on Linux
 * a directory swapped for a link while it runs is removed as the link and not read. It stops at
 * its first failure, and removes what it finds, a path added after the listing included.
 *
 * The listing follows no symbolic link either. It reads each directory with `readdir(…,
 * { withFileTypes: true })` and goes on only into a directory entry, or one with no type. Just
 * before it reads one it checks with `lstat` that a directory is at that path, and keeps that
 * directory's device and inode. Just after the read it checks again that the path, and its
 * parent's path, still lead to the directories kept for them; if either leads elsewhere, the read
 * is dropped: its entries are neither listed nor read. That catches the directory or its parent
 * swapped for a link before or during the read (`lstat` then finds a link), and a directory
 * further up swapped for a link to another directory since it was read (the parent's path then
 * leads to another directory). Each directory the walk reads was found by a kept read, so it
 * reads each directory of the tree once, plus at most one read for each directory swapped
 * meanwhile, and never goes further behind such a link.
 *
 * The check does not catch a swap after which both paths still lead to the directories kept for
 * them. A directory above the parent, moved away and replaced by a link to its new place, is one:
 * the read is kept, and its entries are named by their paths under `root`, as for a plain move of
 * that directory. A swap undone between a read and its check (the directory put back) is another:
 * the entries read behind the link can be named by paths under `root`. In both, the names are
 * paths under `root`, and nothing outside the tree is removed, since the `rm` removes a link as
 * itself (on Linux, as above).
 *
 * Without links the walk cannot loop (an entry has one parent, a directory cannot be hard-linked,
 * and mounts nest as a finite tree). A directory under `root` that is gone when the listing
 * reaches it (another process removed it) has nothing left to list, and is skipped.
 *
 * It checks `signal` before each directory it reads and once more at the end, so an abort during
 * the last read is seen too: an abort, or an error while it lists (a directory it cannot read,
 * say), ends the delete before anything is removed. The caller passes no signal once its edit has
 * changed something, so an abort never stops an edit halfway.
 */
async function listTree(root: string, signal: AbortSignal | undefined): Promise<ListedPath[]> {
	const listed: ListedPath[] = [];
	// The directories to read, relative to `root` ("" is `root`), and the identity of each read.
	const directories = [""];
	const ids = new Map<string, DirectoryId>();
	for (let next = 0; next < directories.length; next++) {
		throwIfAborted(signal);
		const relative = directories[next];
		const absolute = path.join(root, relative);
		let entries: Dirent[];
		try {
			const before = await fs.lstat(absolute, { bigint: true });
			if (!before.isDirectory()) continue;
			ids.set(relative, { dev: before.dev, ino: before.ino });
			entries = await fs.readdir(absolute, { withFileTypes: true });
			const parent = parentOf(relative);
			const kept =
				(await isSameDirectory(absolute, ids.get(relative))) &&
				(relative === "" || (await isSameDirectory(path.join(root, parent), ids.get(parent))));
			if (!kept) continue;
		} catch (error) {
			if (next > 0 && isEnoent(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			const child = path.join(relative, entry.name);
			const directory = entry.isDirectory() || isUntyped(entry);
			listed.push({ relative: child, directory });
			if (directory) directories.push(child);
		}
	}
	throwIfAborted(signal);
	return listed;
}

/**
 * After a recursive delete of `root` failed, record as a delete each path its listing found
 * (`listed`, from {@link listTree}) that is gone. The first {@link PARTIAL_DELETE_NAMED} are named,
 * one line counts the rest, and every one is an executed change, so the servers are told of all
 * of them. A path added under `root` after the listing is not in it, so it is never named, even
 * if the delete removed it.
 */
async function recordGoneAfterFailure(
	root: string,
	listed: ListedPath[],
	cwd: string,
	record: (change: ExecutedWorkspaceChange, line?: string) => void,
): Promise<void> {
	const gone: string[] = [];
	// A directory found gone takes its listed contents with it: no need to look at each.
	const goneDirectories = new Set<string>();
	for (const { relative, directory } of listed) {
		if (!goneDirectories.has(path.dirname(relative))) {
			try {
				await fs.lstat(path.join(root, relative));
				continue;
			} catch (error) {
				if (!isEnoent(error)) continue;
			}
		}
		gone.push(relative);
		if (directory) goneDirectories.add(relative);
	}
	const shownRoot = formatPathRelativeToCwd(root, cwd);
	const why = `(the recursive delete of ${shownRoot} stopped partway)`;
	gone.forEach((relative, index) => {
		const absolute = path.join(root, relative);
		let line: string | undefined;
		if (index < PARTIAL_DELETE_NAMED) line = `Deleted ${formatPathRelativeToCwd(absolute, cwd)} ${why}`;
		else if (index === PARTIAL_DELETE_NAMED) {
			line = `Deleted ${gone.length - PARTIAL_DELETE_NAMED} more paths under ${shownRoot} ${why}`;
		}
		record({ kind: "delete", uri: fileToUri(absolute) }, line);
	});
}

/**
 * Apply a workspace edit (collection of file changes).
 * All text-edit batches are overlap-validated before anything is written so a
 * conflict throws without leaving the workspace half-applied.
 *
 * `onExecuted` fires after each filesystem mutation, with the line `applied` gets for it;
 * a path a recursive delete removed past the ones it names has no line of its own (see
 * {@link recordGoneAfterFailure}).
 * When a later op throws, the callback has already reported the executed prefix —
 * callers that must reconcile external state (e.g. LSP overlays) or report what changed
 * rely on this because the returned {@link WorkspaceEditResult} is lost on failure. A
 * recursive delete that throws after removing part of its tree reports each path its
 * listing found that is gone before it throws.
 *
 * Only a recursive delete watches `signal`, while it lists the tree, before it removes
 * anything (see {@link listTree}), and only while the edit has changed nothing: an abort
 * either stops the edit before its first change or lets it run to its end. The other ops
 * do not watch it.
 */
export async function applyWorkspaceEdit(
	edit: WorkspaceEdit,
	cwd: string,
	onExecuted?: (change: ExecutedWorkspaceChange, applied?: string) => void,
	signal?: AbortSignal,
): Promise<WorkspaceEditResult> {
	const applied: string[] = [];
	const executed: ExecutedWorkspaceChange[] = [];
	const record = (change: ExecutedWorkspaceChange, line?: string) => {
		if (line !== undefined) applied.push(line);
		executed.push(change);
		onExecuted?.(change, line);
	};

	if (edit.documentChanges) {
		const ops = planDocumentChanges(edit.documentChanges);
		for (const op of ops) {
			if (op.kind === "text") sortAndValidateTextEdits(op.edits);
		}
		for (const op of ops) {
			if (op.kind === "text") {
				const filePath = uriToFile(op.uri);
				await applyTextEdits(filePath, op.edits);
				record(
					{ kind: "edit", uri: op.uri },
					`Applied ${op.edits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`,
				);
			} else if (op.kind === "create") {
				const filePath = uriToFile(op.uri);
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				try {
					if (op.options?.overwrite) {
						await Bun.write(filePath, "");
					} else {
						const handle = await fs.open(filePath, "wx");
						await handle.close();
					}
				} catch (error) {
					if (!(op.options?.ignoreIfExists && !op.options.overwrite && isEexist(error))) {
						throw error;
					}
					continue;
				}
				record({ kind: "create", uri: op.uri }, `Created ${formatPathRelativeToCwd(filePath, cwd)}`);
			} else if (op.kind === "rename") {
				const oldPath = uriToFile(op.oldUri);
				const newPath = uriToFile(op.newUri);
				await fs.mkdir(path.dirname(newPath), { recursive: true });
				if (oldPath !== newPath) {
					// Displace an overwritten destination into a kernel-reserved sibling
					// temp dir (same filesystem, so the moves stay atomic) instead of
					// deleting it, so a failed rename (EXDEV, permissions) can restore
					// it and leave the workspace exactly as it was.
					let displaced: { dir: string; file: string } | undefined;
					try {
						const targetStat = await fs.lstat(newPath);
						if (!op.options?.overwrite) {
							if (op.options?.ignoreIfExists) continue;
							throw new ToolError(`rename target already exists: ${formatPathRelativeToCwd(newPath, cwd)}`);
						}
						// Only displace the destination when it is a distinct file. On a
						// case-insensitive filesystem a case-only rename resolves both
						// paths to the same inode; moving newPath aside would move the
						// source, so let fs.rename change the case in place instead.
						const sourceStat = await fs.lstat(oldPath);
						if (sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) {
							const holdDir = await fs.mkdtemp(path.join(path.dirname(newPath), ".omp-displaced-"));
							const holdFile = path.join(holdDir, path.basename(newPath));
							try {
								await fs.rename(newPath, holdFile);
							} catch (error) {
								await fs.rm(holdDir, { recursive: true, force: true }).catch(() => {});
								throw error;
							}
							displaced = { dir: holdDir, file: holdFile };
						}
					} catch (error) {
						if (!isEnoent(error)) throw error;
					}
					try {
						await fs.rename(oldPath, newPath);
					} catch (error) {
						if (displaced) {
							try {
								await fs.rename(displaced.file, newPath);
							} catch {
								// Restoration failed: the destination really is gone, so
								// report it to reconciliation as an executed delete.
								record(
									{ kind: "delete", uri: op.newUri },
									`Deleted ${formatPathRelativeToCwd(newPath, cwd)} (a rename onto it failed)`,
								);
							}
							await fs.rm(displaced.dir, { recursive: true, force: true }).catch(() => {});
						}
						throw error;
					}
					if (displaced) {
						await fs.rm(displaced.dir, { recursive: true, force: true }).catch((error: unknown) => {
							logger.debug("LSP rename: failed to remove displaced overwrite target", {
								displaced: displaced?.dir,
								error: error instanceof Error ? error.message : String(error),
							});
						});
					}
				}
				record(
					{ kind: "rename", oldUri: op.oldUri, newUri: op.newUri },
					`Renamed ${formatPathRelativeToCwd(oldPath, cwd)} → ${formatPathRelativeToCwd(newPath, cwd)}`,
				);
			} else {
				const filePath = uriToFile(op.uri);
				// A recursive delete can remove part of a tree and then fail: what it held is
				// listed first, never through a link, so the paths it did remove can be named.
				let listed: ListedPath[] = [];
				// With `ignoreIfNotExists`, only the target itself missing skips the delete.
				let found = false;
				let removing = false;
				try {
					const stat = await fs.lstat(filePath);
					found = true;
					if (stat.isDirectory() && !op.options?.recursive) {
						await fs.rmdir(filePath);
					} else {
						if (op.options?.recursive && stat.isDirectory()) {
							listed = await listTree(filePath, executed.length === 0 ? signal : undefined);
						}
						removing = true;
						await fs.rm(filePath, { recursive: op.options?.recursive ?? false });
					}
				} catch (error) {
					await recordGoneAfterFailure(filePath, listed, cwd, record);
					if (removing && listed.length > 0 && error instanceof Error) {
						const shown = formatPathRelativeToCwd(filePath, cwd);
						error.message += ` (the recursive delete of ${shown} stops at its first failure; a path added under ${shown} while it ran is not named, and may have been removed)`;
					}
					if (!(op.options?.ignoreIfNotExists && !found && isEnoent(error))) throw error;
					continue;
				}
				record({ kind: "delete", uri: op.uri }, `Deleted ${formatPathRelativeToCwd(filePath, cwd)}`);
			}
		}
	} else if (edit.changes) {
		// Legacy changes-map path: validate every file's edits before writing any.
		const changes = edit.changes;
		for (const uri in changes) {
			sortAndValidateTextEdits(changes[uri]);
		}
		for (const uri in changes) {
			const textEdits = changes[uri];
			if (textEdits.length === 0) continue;
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, textEdits);
			record(
				{ kind: "edit", uri },
				`Applied ${textEdits.length} edit(s) to ${formatPathRelativeToCwd(filePath, cwd)}`,
			);
		}
	}

	return { applied, executed };
}
