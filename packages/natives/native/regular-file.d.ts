import type * as fs from "node:fs";

/** What a path holds, by its `lstat` or `fstat`. */
export type FileKind =
	| "file"
	| "symlink"
	| "fifo"
	| "socket"
	| "character-device"
	| "block-device"
	| "directory"
	| "other";

/**
 * A regular file's bytes, or what stood there instead: its kind, `missing`, or `unreadable` (a
 * regular file that could not be opened).
 */
export type RegularFileRead =
	| { kind: "file"; content: Buffer }
	| { kind: Exclude<FileKind, "file"> | "missing" | "unreadable" };

/**
 * Read `file` if it is a regular file (all of it, or at most its first `length` bytes), never
 * blocking on one that is not: `lstat`, then a non-blocking `open` that follows no link, then
 * `fstat`. Any `open` error is reported as what stands there now, never thrown.
 */
export function readRegularFile(file: string, options?: { length?: number }): RegularFileRead;

/** The text of `file` if it is a regular file, else undefined. */
export function readRegularFileText(file: string): string | undefined;

/** Replace the file calls the reader makes (`undefined` restores them), for tests. */
export function __setRegularFileIoForTests(
	replacement:
		| Partial<Pick<typeof fs, "lstatSync" | "openSync" | "fstatSync" | "readSync" | "readFileSync" | "closeSync">>
		| undefined,
): void;
