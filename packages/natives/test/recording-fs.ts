import * as fs from "node:fs";

/**
 * `node:fs` with the calls that write an addon into the cache recorded by path, for the
 * loader's `__setAddonFileIoForTests`; every call goes through to the real file system. A
 * temporary file's name reads `<temp>`.
 */
export function recordingFs() {
	const calls: string[] = [];
	const paths = new Map<number, string>();
	const label = (file: fs.PathOrFileDescriptor) =>
		(typeof file === "number" ? (paths.get(file) ?? `fd ${file}`) : String(file)).replace(
			/\S*\.tmp\.\d+\.[0-9a-f-]{36}$/,
			"<temp>",
		);
	const io = {
		...fs,
		openSync(file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number {
			const fd = fs.openSync(file, flags, mode);
			paths.set(fd, String(file));
			calls.push(`open ${label(fd)}`);
			return fd;
		},
		writeFileSync(
			file: fs.PathOrFileDescriptor,
			data: string | NodeJS.ArrayBufferView,
			options?: fs.WriteFileOptions,
		) {
			calls.push(`write ${label(file)}`);
			fs.writeFileSync(file, data, options);
		},
		fsyncSync(fd: number) {
			calls.push(`fsync ${label(fd)}`);
			fs.fsyncSync(fd);
		},
		closeSync(fd: number) {
			calls.push(`close ${label(fd)}`);
			paths.delete(fd);
			fs.closeSync(fd);
		},
		renameSync(from: fs.PathLike, to: fs.PathLike) {
			calls.push(`rename ${label(String(from))} -> ${label(String(to))}`);
			fs.renameSync(from, to);
		},
	};
	return { io, calls };
}

/** The calls {@link recordingFs} records for one durable write of `target`. */
export function durableWriteCalls(target: string, dir: string): string[] {
	return [
		"open <temp>",
		"write <temp>",
		"fsync <temp>",
		"close <temp>",
		`rename <temp> -> ${target}`,
		// A directory cannot be opened on Windows; elsewhere its sync makes the rename durable.
		...(process.platform === "win32" ? [] : [`open ${dir}`, `fsync ${dir}`, `close ${dir}`]),
	];
}
