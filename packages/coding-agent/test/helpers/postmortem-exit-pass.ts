/**
 * A launch that ends through `postmortem.exitAfterCleanup` runs postmortem's exit pass for real, also under a test
 * that mocks `process.exit`: the pass is over before the mocked exit throws. `bun test` runs every test file in one
 * process, and once that pass has run, every `postmortem.register` runs its callback at once, so in the rest of the
 * file and in every later file a session's exit recorder or an exit-only close fires the moment it is registered. A
 * test that drives a launch to an exit stops it at `exitAfterCleanup`, and checks after each test that no exit pass
 * has run.
 */
import { expect } from "bun:test";
import { postmortem } from "@oh-my-pi/pi-utils";

/** Fails when postmortem's exit pass has run in this test process: a registration made now runs at once. */
export function expectNoExitPass(): void {
	let ranAtOnce = false;
	postmortem.register("test:no-exit-pass", () => {
		ranAtOnce = true;
	})();
	expect(ranAtOnce).toBe(false);
}
