/**
 * A close that fails before its end still closes the store of older entry bodies: when the
 * close-time cleanup of a draft-only session throws (its marker cannot be unlinked, for a reason
 * other than a missing file), the store's descriptor and disk under `os.tmpdir()` are freed at the
 * close, not left open until a collection.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const HAS_PROC_FD = fs.existsSync("/proc/self/fd");
/** The file a session writes beside a draft that made its file, and removes when real entries follow. */
const DRAFT_ONLY_MARKER = ".draft-only-session";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function user(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
}

/** File storage on which removing a draft-only marker fails with EACCES, as on a read-only artifacts directory. */
class MarkerUnlinkFails extends FileSessionStorage {
	markerUnlinkFailures = 0;

	override unlink(file: string): Promise<void> {
		if (path.basename(file) !== DRAFT_ONLY_MARKER) return super.unlink(file);
		this.markerUnlinkFailures++;
		return Promise.reject(
			Object.assign(new Error(`EACCES: permission denied, unlink '${file}'`), { code: "EACCES" }),
		);
	}
}

/** Descriptors of this process open on a file under `dir`. */
function descriptorsUnder(dir: string): string[] {
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

describe("the store of older entries when a close fails", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.skipIf(!HAS_PROC_FD)("closes the store when the close-time cleanup of a draft-only session throws", async () => {
		// If this regresses, a session whose close fails on its draft-only marker (a read-only or
		// foreign-owned artifacts directory) keeps its older entry bodies' file open under
		// os.tmpdir() until a collection, and a host that opens many sessions runs out of
		// descriptors or disk.
		using dir = TempDir.createSync("@omp-cold-close-failure-");
		using tmp = TempDir.createSync("@omp-cold-close-failure-tmp-");
		vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
		const storage = new MarkerUnlinkFails();
		const manager = SessionManager.create(path.join(dir.path(), "project"), dir.join("sessions"), storage, {
			suppressBreadcrumb: true,
		});
		// A draft typed before the first prompt makes the session file and its draft-only marker;
		// the prompt clears the draft, and the turns that follow make the session one to keep.
		await manager.saveDraft("draft before the first prompt");
		await manager.saveDraft("");
		manager.appendMessage(user(`u1 ${BODY}`));
		manager.appendMessage(assistant(`a1 ${BODY}`));
		const keep = manager.appendMessage(user("keep"));
		manager.appendCompaction(`summary ${BODY}`, undefined, keep, 1000);
		manager.appendMessage(assistant("after"));
		manager.buildSessionContext();
		const open = { coldEntries: manager.coldStoreStats().coldEntries, descriptors: descriptorsUnder(tmp.path()) };

		// The close's cleanup removes the marker of a session with real entries, which fails here.
		await manager.close().catch(() => undefined);

		expect({
			coldBeforeClose: open.coldEntries > 0,
			storeOpenBeforeClose: open.descriptors.length > 0,
			markerUnlinkFailures: storage.markerUnlinkFailures,
			descriptorsAfterClose: descriptorsUnder(tmp.path()),
		}).toEqual({
			coldBeforeClose: true,
			storeOpenBeforeClose: true,
			markerUnlinkFailures: 1,
			descriptorsAfterClose: [],
		});
	});
});
