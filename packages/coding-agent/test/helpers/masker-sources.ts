import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";

/** The marker of the first entry of a project secrets.yml. */
export const YML_MARKER = "[REDACTED:secrets.yml:project#1]";

/** A secrets.yml whose one entry is the plain value `value`. */
export function plainYml(value: string): string {
	return ["- type: plain", `  content: ${value}`].join("\n");
}

/**
 * Makes the next read of each of `paths` throw `EIO`, a failure that leaves the file's stat as it
 * is: the `readFileSync` of a secrets.yml, the `openSync` of a `_FILE`. Returns the paths whose read
 * has not failed yet. The spies last until the test restores its mocks.
 */
export function failNextReads(paths: readonly string[]): ReadonlySet<string> {
	const pending = new Set(paths);
	const ioError = (): Error => Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
	const realReadFileSync = fs.readFileSync;
	const realOpenSync = fs.openSync;
	spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
		if (typeof file === "string" && pending.delete(file)) throw ioError();
		return (realReadFileSync as (target: fs.PathOrFileDescriptor, opts?: unknown) => string | Buffer)(file, options);
	}) as typeof fs.readFileSync);
	spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
		if (typeof file === "string" && pending.delete(file)) throw ioError();
		return realOpenSync(file, flags, mode);
	});
	return pending;
}

/**
 * Silences `logger.warn` until the test restores its mocks, and returns a reader of the details of
 * each warning so far that says the masker could not read a source.
 */
export function sourceReadWarnings(): () => unknown[] {
	const warn = spyOn(logger, "warn").mockImplementation(() => {});
	return () =>
		warn.mock.calls.filter(call => call[0] === "Session store masking could not read a source").map(call => call[1]);
}
