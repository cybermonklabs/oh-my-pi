import { vi } from "bun:test";
import * as path from "node:path";

/** This account's directory of older entry bodies under `tmp`: `omp-cold-<uid>`. */
export function coldDirIn(tmp: string): string {
	return path.join(tmp, `omp-cold-${process.getuid?.()}`);
}

/**
 * Make `process.getuid` give no account id until `vi.restoreAllMocks()`, as on
 * Windows, which has no `getuid`: the code reads it as `process.getuid?.()`,
 * so a spy that answers `undefined` takes the same path.
 */
export function withoutAccountId(): void {
	// `getuid` is typed to answer a number; the platform this stands for answers none.
	vi.spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
}
