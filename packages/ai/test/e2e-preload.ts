/**
 * The `bun test` preload of `packages/ai`, `packages/coding-agent` and the repository root (each
 * `bunfig.toml`). An `E2E` run loads the developer's own dotenv files (`./e2e-env.ts`) here, before
 * a test file imports provider code, some of which reads its settings when it loads
 * (`PI_NO_STRICT`, `PI_NO_INTERLEAVED_THINKING`, `PI_CODEX_*`). Any other run, `E2E=0` included,
 * imports nothing here, so its modules load in the order its test files give.
 */

/**
 * The values `$flag` counts as set (`parseFlag` in `packages/utils/src/env.ts`), repeated here
 * because importing `@oh-my-pi/pi-utils` would load it; `e2e-api-key.test.ts` checks that the two
 * agree.
 */
export const E2E_FLAG_VALUES: readonly string[] = ["1", "Y", "y", "TRUE", "true", "YES", "yes", "ON", "on"];

/** Whether `value` turns `E2E` on, as `$flag("E2E")` reads it. */
export function isE2E(value: string | undefined): boolean {
	return value !== undefined && E2E_FLAG_VALUES.includes(value);
}

// Dynamic on purpose: a static import would load `@oh-my-pi/pi-utils` in every test process, ahead
// of the test files that set the environment before they import it.
if (isE2E(Bun.env.E2E)) await import("./e2e-env");
