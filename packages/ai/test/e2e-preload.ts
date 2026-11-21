/**
 * The `bun test` preload of `packages/ai`, `packages/coding-agent` and the repository root (each
 * `bunfig.toml`). An `E2E` run loads the developer's own dotenv files (`./e2e-env.ts`) here, before
 * a test file imports provider code, some of which reads its settings when it loads
 * (`PI_NO_STRICT`, `PI_NO_INTERLEAVED_THINKING`, `PI_CODEX_*`). Any other run imports nothing here,
 * so its modules load in the order its test files give.
 */
// Dynamic on purpose: a static import would load `@oh-my-pi/pi-utils` in every test process, ahead
// of the test files that set the environment before they import it.
if (Bun.env.E2E) await import("./e2e-env");

export {};
