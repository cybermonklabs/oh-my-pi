import * as fs from "node:fs";

/**
 * Read a file that is expected to be a regular file, without ever blocking on one that is not.
 *
 * Every read the addon loader makes, at a start, of a file a user or another process can put
 * in place (a workspace checkout's sources and its `BUILD.bazel` files, the checkout id in its
 * git directory, an addon's sources record) goes through here. A plain read of a FIFO with no
 * writer waits forever, and so would every omp start that reads one.
 *
 * - `lstat` must show a regular file; anything else is never opened, and is reported by its
 *   kind.
 * - The `open` neither follows a link nor waits (`O_RDONLY | O_NONBLOCK | O_NOFOLLOW`), so a
 *   file swapped for a link or a FIFO after the `lstat` cannot block it. An `open` that fails
 *   is never thrown: the file is looked at again and reported by what stands there now. A file
 *   swapped for a link (`ELOOP`), a socket (`ENXIO`) or nothing is that kind, or `missing`; one
 *   that is a regular file again by then is `changed`. A regular file that `open` refused for
 *   another reason (`EACCES`, no descriptor left) is `unreadable`, with the error.
 * - `fstat` on the descriptor must show a regular file before anything is read.
 *
 * Every result but `missing`, `changed` and `unreadable` carries the stat that named it (the
 * descriptor's for a file it read), so a caller can tell which state of the file its answer
 * describes.
 */

/** @type {Pick<typeof fs, "lstatSync" | "openSync" | "fstatSync" | "readSync" | "readFileSync" | "closeSync" | "readlinkSync">} */
let io = fs;

/**
 * Replace the file calls this module makes (`undefined` restores them), so a test can change a
 * file between the `lstat` and the `open`. The replacement reaches this module instance only.
 * @param {Partial<typeof io> | undefined} replacement
 */
export function __setRegularFileIoForTests(replacement) {
	io = replacement ? { ...fs, ...replacement } : fs;
}

/**
 * The kind of a file by its `lstat` or `fstat`, as {@link readRegularFile} reports it.
 * @param {fs.Stats} stat
 * @returns {import("./regular-file").FileKind}
 */
function kindOf(stat) {
	if (stat.isFile()) return "file";
	if (stat.isSymbolicLink()) return "symlink";
	if (stat.isFIFO()) return "fifo";
	if (stat.isSocket()) return "socket";
	if (stat.isCharacterDevice()) return "character-device";
	if (stat.isBlockDevice()) return "block-device";
	if (stat.isDirectory()) return "directory";
	return "other";
}

/**
 * `open` errors that show the path held no regular file when it was opened: a link (`ELOOP`,
 * under `O_NOFOLLOW`), a socket or a device with no driver (`ENXIO`), nothing (`ENOENT`,
 * `ENOTDIR`). Any other refusal of a regular file (`EACCES`, `EMFILE`, `EIO`) is the file's own.
 */
const KIND_CHANGE_ERRORS = new Set(["ELOOP", "ENXIO", "ENOENT", "ENOTDIR"]);

/**
 * What stands at `file` when it cannot be read as a regular file: its kind now, with the `lstat`
 * that found it, `missing` when it is gone, `changed` for a regular file again whose `open` met
 * another kind, or `unreadable`, with the `open` error, for a regular file that cannot be opened
 * (no permission, no descriptor left).
 * @param {string} file
 * @param {unknown} error the `open` error
 * @returns {Exclude<import("./regular-file").RegularFileRead, { kind: "file" }>}
 */
function kindNow(file, error) {
	try {
		const stat = io.lstatSync(file, { throwIfNoEntry: false });
		if (!stat) return { kind: "missing" };
		const kind = kindOf(stat);
		if (kind !== "file") return { kind, stat };
		const code = /** @type {{ code?: unknown } | null} */ (error)?.code;
		const changedKind = typeof code === "string" && KIND_CHANGE_ERRORS.has(code);
		return changedKind ? { kind: "changed" } : { kind: "unreadable", error };
	} catch {
		return { kind: "missing" };
	}
}

/**
 * Read `file` if it is a regular file: all of it, or with `length` at most its first `length`
 * bytes. Never blocks, and throws only on a read error after a regular file was opened.
 * @param {string} file
 * @param {{ length?: number }} [options]
 * @returns {import("./regular-file").RegularFileRead}
 */
export function readRegularFile(file, options = {}) {
	let stat;
	try {
		stat = io.lstatSync(file, { throwIfNoEntry: false });
	} catch {
		return { kind: "missing" };
	}
	if (!stat) return { kind: "missing" };
	const kind = kindOf(stat);
	if (kind !== "file") return { kind, stat };
	const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
	let fd;
	try {
		fd = io.openSync(file, O_RDONLY | (O_NONBLOCK ?? 0) | (O_NOFOLLOW ?? 0));
	} catch (error) {
		return kindNow(file, error);
	}
	try {
		const opened = io.fstatSync(fd);
		const now = kindOf(opened);
		if (now !== "file") return { kind: now, stat: opened };
		if (options.length === undefined) return { kind: "file", content: io.readFileSync(fd), stat: opened };
		const content = Buffer.alloc(options.length);
		let read = 0;
		while (read < content.length) {
			const n = io.readSync(fd, content, read, content.length - read, read);
			if (n === 0) break;
			read += n;
		}
		return { kind: "file", content: content.subarray(0, read), stat: opened };
	} finally {
		io.closeSync(fd);
	}
}

/**
 * The text of `file` if it is a regular file, else undefined (see {@link readRegularFile}).
 * @param {string} file
 * @returns {string | undefined}
 */
export function readRegularFileText(file) {
	const read = readRegularFile(file);
	return read.kind === "file" ? read.content.toString("utf8") : undefined;
}

/**
 * The `lstat` of `file`, or undefined when nothing stands there. It goes through the same
 * calls as {@link readRegularFile}, so a test that replaces them
 * (`__setRegularFileIoForTests`) also sees every `lstat` a caller makes this way.
 * @param {string} file
 * @returns {fs.Stats | undefined}
 */
export function lstatPath(file) {
	return io.lstatSync(file, { throwIfNoEntry: false });
}

/**
 * The target of the link at `file`, found a link by its `lstat`: its text; `changed` when what
 * stands there is no longer a link (`EINVAL`) or is gone (`ENOENT`, `ENOTDIR`); or `unreadable`,
 * with the error, for a link whose target cannot be read (an I/O error).
 * @param {string} file
 * @returns {{ kind: "symlink"; target: string } | { kind: "changed" } | { kind: "unreadable"; error: unknown }}
 */
export function readLinkTarget(file) {
	try {
		return { kind: "symlink", target: io.readlinkSync(file, "utf8") };
	} catch (error) {
		const code = /** @type {{ code?: unknown } | null} */ (error)?.code;
		const changedKind = code === "EINVAL" || code === "ENOENT" || code === "ENOTDIR";
		return changedKind ? { kind: "changed" } : { kind: "unreadable", error };
	}
}
