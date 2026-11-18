/**
 * `process.env` as this process's JavaScript first saw it: the environment the process was
 * started with, and whatever Bun's own `.env` loading added before any JavaScript ran, before omp
 * changed anything (a profile, an addon cache, its own `.env` files). The CLI entry imports this
 * module first, so the snapshot is taken before any other omp module runs; elsewhere it is taken
 * when `@oh-my-pi/pi-utils/env` first loads.
 */
export const startupEnv: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
);
