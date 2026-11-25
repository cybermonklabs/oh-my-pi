/**
 * F2 live-steal repro (holds for HOLD finding 2 on 48642f8432).
 *
 * A live acquirer descheduled between lock create and holder record leaves
 * exactly this filesystem state: a contentless lock file older than the
 * orphan budget. Fixed code additionally holds a process-owned OS gate from
 * before create until after release, which the kernel reclaims even on
 * SIGKILL, and refuses the steal path while another holder owns it.
 *
 * This test takes the descheduled acquirer's place: it holds the OS gate,
 * plants the aged contentless lock, and publishes as a second writer. Broken
 * code cannot see the gate, so it steals the "orphan" and publishes around
 * the live holder. Fixed code fails closed at the gate before touching the
 * lockfile, and the holder's own publish lands cleanly once released.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import { FileSessionStorage, SessionLockError } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { startNativeLockHolder } from "../helpers/native-lock-holder";

/** Mirrors the OS-gate sidecar derived in `#withPublishLock`. */
function osGatePath(lockPath: string): string {
	return `${lockPath}.os`;
}

describe("publish lock OS gate", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-publish-gate-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("refuses to steal while a live holder owns the gate", () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "session.jsonl");
		storage.writeTextSync(sessionPath, "original\n");
		const lockPath = path.join(tempDir, ".session.jsonl.lock");
		// The descheduled holder owns the gate and left a contentless file
		// older than any live acquisition could be.
		const gate = NativeFileLock.tryAcquire(osGatePath(lockPath));
		expect(gate.acquired).toBe(true);
		try {
			fs.writeFileSync(lockPath, "");
			const aged = new Date(Date.now() - 60_000);
			fs.utimesSync(lockPath, aged, aged);
			let threw: unknown;
			try {
				storage.writeTextSync(sessionPath, "B-content\n");
			} catch (err) {
				threw = err;
			}
			if (!(threw instanceof SessionLockError)) {
				const body = fs.readFileSync(sessionPath, "utf8");
				throw new Error(
					`second writer published around a live gate holder (threw=${threw}, body=${JSON.stringify(body)})`,
				);
			}
			expect(fs.readFileSync(sessionPath, "utf8")).toBe("original\n");
		} finally {
			gate.release();
		}
		// The holder resumes after its deschedule and publishes cleanly.
		storage.writeTextSync(sessionPath, "A-content\n");
		expect(fs.readFileSync(sessionPath, "utf8")).toBe("A-content\n");
	});

	it("holds an append while another writer owns the gate", async () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "session.jsonl");
		storage.writeTextSync(sessionPath, "original\n");
		const writer = storage.openWriter(sessionPath);
		const appendSync = writer.appendSync?.bind(writer);
		if (!appendSync) throw new Error("File writer must expose appendSync");
		// Appends no longer claim the lockfile, so the gate is the only thing
		// keeping them out of another process's check-then-rename. A holder
		// mid-publish must make the append fail closed rather than land in the
		// file its rename is about to replace.
		const gate = NativeFileLock.tryAcquire(osGatePath(path.join(tempDir, ".session.jsonl.lock")));
		expect(gate.acquired).toBe(true);
		try {
			expect(() => appendSync("lost\n")).toThrow(SessionLockError);
		} finally {
			gate.release();
		}
		// The failed append poisons the writer; close surfaces it.
		await expect(writer.close()).rejects.toBeInstanceOf(SessionLockError);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe("original\n");
	});

	// If this regresses, a session write that waits on the gate another omp process holds makes a
	// native claim on every poll, each blocking the thread about 50 ms on Linux, where a probe answers
	// at once.
	it.skipIf(process.platform !== "linux")(
		"waits on a gate another process holds by probing it, with one claim at the end of the wait",
		async () => {
			const storage = new FileSessionStorage();
			const sessionPath = path.join(tempDir, "session.jsonl");
			storage.writeTextSync(sessionPath, "original\n");
			const gatePath = osGatePath(path.join(tempDir, ".session.jsonl.lock"));
			const holder = await startNativeLockHolder(gatePath, path.join(tempDir, "holder-ready"));
			try {
				const claim = vi.spyOn(NativeFileLock, "tryAcquire");
				expect(() => storage.writeTextSync(sessionPath, "B-content\n")).toThrow(SessionLockError);
				expect(claim.mock.calls.filter(([claimed]) => claimed === gatePath)).toHaveLength(1);
			} finally {
				holder.kill();
				await holder.exited;
			}
			expect(fs.readFileSync(sessionPath, "utf8")).toBe("original\n");
		},
		10_000,
	);
});
