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
 * A regular file's bytes, or what stood there instead: its kind, `missing`, `changed` (a
 * regular file again, whose `open` met another kind: a link, a socket or nothing), or
 * `unreadable` (a regular file that could not be opened, with the `open` error). `stat` is what
 * named the answer: the descriptor's `fstat` for a file read, else the `lstat` that found the
 * kind.
 */
export type RegularFileRead =
	| { kind: "file"; content: Buffer; stat: fs.Stats }
	| { kind: Exclude<FileKind, "file">; stat: fs.Stats }
	| { kind: "unreadable"; error: unknown }
	| { kind: "changed" }
	| { kind: "missing" };

/**
 * Read `file`, all of it, if it is a regular file, never blocking on one that is not: `lstat`,
 * then a non-blocking `open` that follows no link, then `fstat`. An `open` error is never
 * thrown: it is reported as what stands there now, or as `unreadable` when that is still a
 * regular file.
 */
export function readRegularFile(file: string): RegularFileRead;

/** The text of `file` if it is a regular file, else undefined. */
export function readRegularFileText(file: string): string | undefined;

/**
 * The `lstat` of `file`, or undefined when nothing stands there, through the reader's calls, so
 * a test that replaces them sees it.
 */
export function lstatPath(file: string): fs.Stats | undefined;

/**
 * The target of the link at `file`: its text; `changed` when what stands there is no longer a
 * link or is gone; or `unreadable`, with the error, when the target cannot be read.
 */
export function readLinkTarget(
	file: string,
): { kind: "symlink"; target: string } | { kind: "changed" } | { kind: "unreadable"; error: unknown };

/**
 * Replace the file calls the reader makes (`undefined` restores them), for tests. It reaches
 * this module instance only.
 */
export function __setRegularFileIoForTests(
	replacement:
		| Partial<
				Pick<typeof fs, "lstatSync" | "openSync" | "fstatSync" | "readFileSync" | "closeSync" | "readlinkSync">
		  >
		| undefined,
): void;
