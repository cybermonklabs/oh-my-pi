/**
 * The mark a cold session entry's message carries (`convertToColdEntry` in
 * `cold-entries.ts`): a hidden slot naming the entry whose record in the store
 * holds the message's bodies. Kept apart from `cold-entries.ts` so that the
 * message conversion (`messages.ts`) can tell a cold message without importing
 * the store, which imports the conversion's own importers.
 */
export const COLD_OWNER = Symbol("omp.coldOwner");

/** The hidden slot of a cold entry's message. */
export interface ColdMessageSlots {
	[COLD_OWNER]?: object;
}

/** Whether `message` is a cold entry's message, whose bodies are read back from the store on access. */
export function isColdMessage(message: object): boolean {
	const slots: ColdMessageSlots = message;
	return slots[COLD_OWNER] !== undefined;
}
