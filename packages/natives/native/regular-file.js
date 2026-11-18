import * as fs from "node:fs";

/**
 * Read a file that is expected to be a regular file, without ever blocking on one that is not.
 *
 * Every read the addon loader and pi-utils make, at a start, of a file a user or another
 * process can put in place (a workspace checkout's sources and its `BUILD.bazel` files, the
 * checkout id in its git directory, an addon's sources record, a relaunch file) goes through
 * here. A plain read of a FIFO with no writer waits forever, and so would every omp start
 * that reads one.
 *
 * - `lstat` must show a regular file; anything else is never opened, and is reported by its
 *   kind.
 * - The `open` neither follows a link nor waits (`O_RDONLY | O_NONBLOCK | O_NOFOLLOW`), so a
 *   file swapped for a link or a FIFO after the `lstat` cannot block it. Any error from that
 *   `open` (`ELOOP` for a link, `ENXIO` for a socket, `EACCES`, a file gone) is a change of
 *   kind, never thrown: the file is looked at again and reported by what stands there now.
 * - `fstat` on the descriptor must show a regular file before anything is read.
 */

/** @type {Pick<typeof fs, "lstatSync" | "openSync" | "fstatSync" | "readSync" | "readFileSync" | "closeSync">} */
let io = fs;

/**
 * Replace the file calls this module makes (`undefined` restores them), so a test can change a
 * file between the `lstat` and the `open`.
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
 * What stands at `file` when it cannot be read as a regular file: its kind now, `missing` when
 * it is gone, or `unreadable` for a regular file that cannot be opened (no permission).
 * @param {string} file
 * @returns {{ kind: Exclude<import("./regular-file").FileKind, "file"> | "unreadable" }}
 */
function kindNow(file) {
	try {
		const stat = io.lstatSync(file, { throwIfNoEntry: false });
		if (!stat) return { kind: "missing" };
		const kind = kindOf(stat);
		return { kind: kind === "file" ? "unreadable" : kind };
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
	if (kind !== "file") return { kind };
	const { O_RDONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
	let fd;
	try {
		fd = io.openSync(file, O_RDONLY | (O_NONBLOCK ?? 0) | (O_NOFOLLOW ?? 0));
	} catch {
		return kindNow(file);
	}
	try {
		const now = kindOf(io.fstatSync(fd));
		if (now !== "file") return { kind: now };
		if (options.length === undefined) return { kind: "file", content: io.readFileSync(fd) };
		const content = Buffer.alloc(options.length);
		let read = 0;
		while (read < content.length) {
			const n = io.readSync(fd, content, read, content.length - read, read);
			if (n === 0) break;
			read += n;
		}
		return { kind: "file", content: content.subarray(0, read) };
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
