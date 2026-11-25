import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomEntry, SessionEntry } from "./session-entries";
import contextNotesPrompt from "../prompts/system/context-notes.md" with { type: "text" };

export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
export const MAX_CONTEXT_NOTES_BYTES = 16_384;

export interface ContextNotesEntry {
	version: 1;
	text: string;
}

export interface ContextNotesRevision {
	text: string;
	entryId: string;
}

function isContextNotesEntry(entry: SessionEntry): entry is CustomEntry<unknown> {
	return entry.type === "custom" && entry.customType === CONTEXT_NOTES_ENTRY_TYPE;
}

function isContextNotesData(data: unknown): data is ContextNotesEntry {
	if (data === null || typeof data !== "object") return false;
	const candidate = data as Record<string, unknown>;
	const keys = Object.keys(candidate);
	return (
		keys.length === 2 &&
		keys.includes("version") &&
		keys.includes("text") &&
		candidate.version === 1 &&
		typeof candidate.text === "string" &&
		Buffer.byteLength(candidate.text, "utf8") <= MAX_CONTEXT_NOTES_BYTES
	);
}

/**
 * Returns the latest valid notebook revision visible after the active context-reset boundary.
 * Invalid historical custom entries are ignored so a malformed journal record cannot mask an
 * earlier valid notebook revision.
 */
export function getContextNotes(entries: readonly SessionEntry[]): ContextNotesRevision | undefined {
	const revision = contextNotesEntriesRead(entries).at(-1);
	if (!revision || !isContextNotesData(revision.data)) return undefined;
	return { text: revision.data.text, entryId: revision.id };
}

/**
 * The notebook entries {@link getContextNotes} reads, newest first: each from
 * the newest after the context-reset boundary back to the valid revision it
 * returns. Every context build reads them, so they stay whole when older
 * entries go to the cold store; the revisions older than these are read by
 * nothing.
 */
export function contextNotesEntriesRead(entries: readonly SessionEntry[]): CustomEntry<unknown>[] {
	const read: CustomEntry<unknown>[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "reset_boundary") break;
		if (!isContextNotesEntry(entry)) continue;
		read.push(entry);
		if (isContextNotesData(entry.data)) break;
	}
	return read;
}

/**
 * Renders the context injection for the latest visible non-empty notebook revision.
 * An absent or explicitly cleared notebook returns an empty string so callers add no context.
 */
export function renderContextNotes(entries: readonly SessionEntry[]): string {
	const notes = getContextNotes(entries);
	if (!notes || notes.text.length === 0) return "";
	return prompt.render(contextNotesPrompt, { notes: notes.text }).trim();
}
