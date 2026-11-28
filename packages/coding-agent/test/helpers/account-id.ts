import { vi } from "bun:test";

/**
 * Make `process.getuid` give no account id until `vi.restoreAllMocks()`, as on
 * Windows, which has no `getuid`: the code reads it as `process.getuid?.()`,
 * so a spy that answers `undefined` takes the same path.
 */
export function withoutAccountId(): void {
	// `getuid` is typed to answer a number; the platform this stands for answers none.
	vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
}
