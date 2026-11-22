/**
 * A launch that ends through `postmortem.exitAfterCleanup` runs postmortem's exit pass for real, also under a test
 * that mocks `process.exit`: the pass is over before the mocked exit throws. `bun test` runs every test file in one
 * process, and once that pass has run, every `postmortem.register` runs its callback at once, so in the rest of the
 * file and in every later file a session's exit recorder or an exit-only close fires the moment it is registered. A
 * test that drives a launch to an exit stops it at `exitAfterCleanup`, and checks after each test that no exit pass
 * has run.
 */
import { postmortem } from "@oh-my-pi/pi-utils";

/**
 * The caller of the last check in this test process that found no exit pass. Module state is shared by every test
 * file of one `bun test` run, as postmortem's own state is.
 */
let lastClean: string | undefined;

/**
 * Fails when postmortem's exit pass has run in this test process: a registration made now runs at once. The pass is
 * process-wide, so it may have run in another file; the message names the window it ran in, from the last check that
 * found none to this one. `caller` names the calling test file (`import.meta.file`).
 */
export function expectNoExitPass(caller: string): void {
	let ranAtOnce = false;
	postmortem.register("test:no-exit-pass", () => {
		ranAtOnce = true;
	})();
	if (!ranAtOnce) {
		lastClean = caller;
		return;
	}
	const window =
		lastClean === undefined
			? `before this check in ${caller}: in this file or in a test file that ran before it`
			: `after the last check that found none, in ${lastClean}, and before this check in ${caller}`;
	throw new Error(
		`postmortem's exit pass has already run in this test process, so every postmortem.register now runs its ` +
			`callback at once. A test ran a launch to an exit through postmortem.exitAfterCleanup (or postmortem.quit) ` +
			`without stopping it there; that test ran ${window}.`,
	);
}
