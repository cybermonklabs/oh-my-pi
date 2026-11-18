/**
 * `process.env` as this process's JavaScript first saw it: the environment the process was
 * started with, and whatever Bun's own `.env` loading added before any JavaScript ran, before omp
 * changed anything (a profile, an addon cache, its own `.env` files). The CLI entry imports this
 * module first, so the snapshot is taken before any other omp module runs; elsewhere it is taken
 * when `@oh-my-pi/pi-utils/env` first loads. It is taken once per process (per thread): kept on
 * `globalThis`, which a `bun --hot` reload or a second copy of this module keeps, so a later
 * evaluation, after omp changed `process.env`, returns the first snapshot.
 */
const STARTUP_ENV_KEY = Symbol.for("@oh-my-pi/pi-utils/startup-env");

const store = globalThis as typeof globalThis & { [STARTUP_ENV_KEY]?: Readonly<Record<string, string>> };

export const startupEnv: Readonly<Record<string, string>> = (store[STARTUP_ENV_KEY] ??= Object.freeze(
	Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
));
