import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** The fixture process that holds a native lock until it is killed. */
const LOCK_HOLDER = path.join(import.meta.dir, "..", "fixtures", "native-lock-holder.ts");
/** Time between two checks for the readiness file, which another process writes: no event tells this one. */
const READY_POLL_MS = 20;

/**
 * Start a process that holds the native lock at `lockPath` until it is killed,
 * and wait until it holds it: the process writes `readyPath` once it does.
 */
export async function startNativeLockHolder(
	lockPath: string,
	readyPath: string,
): Promise<Bun.Subprocess<"ignore", "ignore", "pipe">> {
	const holder = Bun.spawn([process.execPath, LOCK_HOLDER, lockPath, readyPath], {
		cwd: path.resolve(import.meta.dir, "..", ".."),
		env: { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "" },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	for (;;) {
		try {
			await fs.access(readyPath);
			return holder;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (holder.exitCode !== null) {
				throw new Error(
					`lock holder exited before readiness (${holder.exitCode}): ${await new Response(holder.stderr).text()}`,
				);
			}
		}
		await Bun.sleep(READY_POLL_MS);
	}
}
