import * as fs from "node:fs";
import * as path from "node:path";

/** Whether this process can list its open descriptors (`/proc/self/fd`); the helpers below read it. */
export const HAS_PROC_FD = fs.existsSync("/proc/self/fd");

/** Descriptors of this process open on a file under `dir`. */
export function descriptorsUnder(dir: string): string[] {
	const found: string[] = [];
	for (const fd of fs.readdirSync("/proc/self/fd")) {
		try {
			const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
			if (target.startsWith(`${dir}${path.sep}`)) found.push(target);
		} catch {
			// Closed between the listing and the read.
		}
	}
	return found;
}

/** Whether descriptor `fd` of this process is open on a file under `dir`. */
export function isUnder(fd: number, dir: string): boolean {
	try {
		return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${dir}${path.sep}`);
	} catch {
		return false;
	}
}
