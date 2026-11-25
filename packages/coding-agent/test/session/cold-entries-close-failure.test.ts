/**
 * A close that fails before its end still closes the store of older entry bodies: when the
 * close-time cleanup of a draft-only session throws (its marker cannot be unlinked, for a reason
 * other than a missing file), the store's descriptor and disk under `os.tmpdir()` are freed at the
 * close, not left open until a collection. A close the store refused keeps the store open while the
 * transcript it holds, or the entries its owner keeps, still read older bodies from it, and closes it
 * when those entries are released, not at a collection.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SQL } from "bun";
import { descriptorsUnder, HAS_PROC_FD } from "../helpers/open-descriptors";
import { RefusingSqlClient } from "../helpers/refusing-session-stores";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
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

/** Older entries of `manager` turned cold: two turns, then a compaction that keeps only the last. */
function coolOlderEntries(manager: SessionManager): void {
	manager.appendMessage(user(`u1 ${BODY}`));
	manager.appendMessage(assistant(`a1 ${BODY}`));
	const keep = manager.appendMessage(user("keep"));
	manager.appendCompaction(`summary ${BODY}`, undefined, keep, 1000);
	manager.appendMessage(assistant("after"));
	manager.buildSessionContext();
}

/**
 * A session on a SQL store with older entries cold, whose close the store refused (read-only), so the
 * close rejects and the transcript is held for a later send.
 */
async function heldWithColdEntries(
	tmp: TempDir,
	seal?: { keepEntries?: boolean },
): Promise<{ client: RefusingSqlClient; storage: SqlSessionStorage; manager: SessionManager; coldEntries: number }> {
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp.path());
	const client = new RefusingSqlClient(new SQL("sqlite::memory:"));
	const storage = await SqlSessionStorage.create({ client });
	const manager = await SessionManager.open(path.resolve("/sessions/parent/Held.jsonl"), undefined, storage, {
		initialCwd: "/cwd",
	});
	coolOlderEntries(manager);
	await storage.drain();
	const coldEntries = manager.coldStoreStats().coldEntries;
	client.refusal = "read-only";
	manager.appendMessage(assistant("refused answer"));
	await storage.drain().catch(() => undefined);
	if (seal) manager.seal(seal);
	await expect(manager.close()).rejects.toThrow();
	return { client, storage, manager, coldEntries };
}

/** Descriptors open on stores of older entry bodies under `tmp`: `openPrivateTempFile`'s `omp-cold-<uid>`. */
function coldStoreDescriptors(tmp: TempDir): string[] {
	return descriptorsUnder(path.join(tmp.path(), `omp-cold-${process.getuid?.()}`));
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

	it.skipIf(!HAS_PROC_FD)(
		"closes the store when the entries a refused close holds are released, as an unpack that failed does",
		async () => {
			// If this regresses, every session a failed unpack or fork drops after its close was refused
			// (session-transfer's placeSession) keeps its older entry bodies' file open under os.tmpdir()
			// until a collection.
			using tmp = TempDir.createSync("@omp-cold-held-close-tmp-");
			const { client, manager, coldEntries } = await heldWithColdEntries(tmp);
			const held = { holds: manager.holdsTranscript(), storeOpen: coldStoreDescriptors(tmp).length > 0 };

			manager.releaseRetainedEntries();

			expect({
				cold: coldEntries > 0,
				held,
				holdsAfterRelease: manager.holdsTranscript(),
				descriptorsAfterRelease: coldStoreDescriptors(tmp),
			}).toEqual({
				cold: true,
				held: { holds: true, storeOpen: true },
				holdsAfterRelease: false,
				descriptorsAfterRelease: [],
			});
			await client.end();
		},
	);

	it.skipIf(!HAS_PROC_FD)(
		"keeps the store for entries kept after a refused close's send lands, and closes it when they are released",
		async () => {
			// If this regresses, an owner that kept the entries after a failed close (the interactive mode)
			// and then releases them keeps their older bodies' file open under os.tmpdir() until a collection;
			// or, closing too early, a read of an older kept entry throws.
			using tmp = TempDir.createSync("@omp-cold-kept-close-tmp-");
			const { client, storage, manager } = await heldWithColdEntries(tmp, { keepEntries: true });

			client.refusal = undefined;
			const parent = SessionManager.create("/cwd", path.resolve("/sessions/main"), storage);
			parent.appendMessage(assistant("the parent's write lands"));
			await parent.close();
			const kept = {
				holds: manager.holdsTranscript(),
				olderBodyRead: JSON.stringify(manager.getEntries()).includes(`a1 ${BODY}`),
				storeOpen: coldStoreDescriptors(tmp).length > 0,
			};

			manager.releaseRetainedEntries();

			expect({ kept, descriptorsAfterRelease: coldStoreDescriptors(tmp) }).toEqual({
				kept: { holds: false, olderBodyRead: true, storeOpen: true },
				descriptorsAfterRelease: [],
			});
			await client.end();
		},
	);
});
