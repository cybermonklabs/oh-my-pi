/**
 * Ways to keep the local spool a full session rewrite streams through from
 * being used, and the store's warnings about it, for tests of what the
 * rewrite does then.
 */
import { vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/** The warnings among `calls` (a `logger.warn` spy's) that are about the spool. */
export function spoolWarnings(calls: ReadonlyArray<readonly unknown[]>): ReadonlyArray<readonly unknown[]> {
	return calls.filter(([message]) => String(message).includes("spool"));
}

/**
 * Fill the disk under `dir` for the spool: the first `writeFileSync` to each
 * descriptor `openSync` opened on a file under `dir` (the spool fills its
 * file with `writeFileSync`) lands half its bytes and fails with ENOSPC, as a
 * write to a disk that fills does. The spool closes its descriptor once a
 * write fails, so that write is its last on it. Counts the writes it failed.
 * `vi.restoreAllMocks()` undoes it.
 */
export function fillDiskUnder(dir: string): { refused: () => number } {
	const openSync = fs.openSync;
	const writeFileSync = fs.writeFileSync;
	const spoolFds = new Set<number>();
	let refused = 0;
	vi.spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...rest: unknown[]): number => {
		const fd: number = Reflect.apply(openSync, fs, [file, ...rest]);
		if (String(file).startsWith(`${dir}${path.sep}`)) spoolFds.add(fd);
		return fd;
	}) as typeof fs.openSync);
	vi.spyOn(fs, "writeFileSync").mockImplementation(((
		file: fs.PathOrFileDescriptor,
		data: string | NodeJS.ArrayBufferView,
		...rest: unknown[]
	): void => {
		if (typeof file !== "number" || !spoolFds.has(file)) {
			Reflect.apply(writeFileSync, fs, [file, data, ...rest]);
			return;
		}
		// A later open may reuse the number of the descriptor the spool closes.
		spoolFds.delete(file);
		refused++;
		const bytes =
			typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		writeFileSync(file, bytes.subarray(0, bytes.byteLength >> 1));
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
			code: "ENOSPC",
			errno: -28,
			syscall: "write",
		});
	}) as typeof fs.writeFileSync);
	return { refused: () => refused };
}
