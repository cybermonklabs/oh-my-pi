import { vi } from "bun:test";
import * as natives from "@oh-my-pi/pi-natives";

/**
 * Runs `swap` after the real `glob` returns a listing whose options `listed` accepts,
 * before the caller reads any listed file: the seam where a test swaps a listed entry
 * for a symlink. `ran` is set once the swap ran. Undo with `vi.restoreAllMocks()`.
 */
export function swapAfterListing(
	swap: () => void | Promise<void>,
	listed: (options: natives.GlobOptions) => boolean = () => true,
): { ran: boolean } {
	const state = { ran: false };
	const realGlob = natives.glob;
	vi.spyOn(natives, "glob").mockImplementation(async (options, onMatch) => {
		const result = await realGlob(options, onMatch);
		if (listed(options)) {
			await swap();
			state.ran = true;
		}
		return result;
	});
	return state;
}
