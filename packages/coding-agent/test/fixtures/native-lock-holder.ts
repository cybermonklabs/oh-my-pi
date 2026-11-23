/**
 * Holds the native file lock at `argv[2]` (a lock path, as `FileLock.tryAcquire`
 * takes it) until the process is killed, after writing `argv[3]` once it holds it.
 */
import { FileLock } from "@oh-my-pi/pi-natives";

const lockPath = Bun.argv[2];
const readyPath = Bun.argv[3];
if (!lockPath || !readyPath) throw new Error("native-lock-holder requires a lock path and a readiness path");

const lock = FileLock.tryAcquire(lockPath);
if (!lock.acquired) throw new Error(`native-lock-holder could not take ${lockPath}`);
await Bun.write(readyPath, "ready");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
