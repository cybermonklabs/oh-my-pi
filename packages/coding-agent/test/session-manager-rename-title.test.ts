import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

function userTurn(content: string) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function createSession(tempDir: TempDir): Promise<string> {
	const creator = SessionManager.create(tempDir.path(), tempDir.path(), new FileSessionStorage());
	await creator.ensureOnDisk();
	creator.appendMessage(userTurn("before"));
	const sessionFile = creator.getSessionFile();
	if (!sessionFile) throw new Error("Expected session file");
	await creator.close();
	return sessionFile;
}

function sessionFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

async function reopen(sessionFile: string, tempDir: TempDir): Promise<SessionManager> {
	return SessionManager.open(sessionFile, tempDir.path(), new FileSessionStorage(), {
		suppressBreadcrumb: true,
	});
}

const SESSION_MANAGER_MODULE = path.join(import.meta.dir, "../src/session/session-manager.ts");

/**
 * Another live omp process: it opens the session, writes (claiming the
 * cross-process ownership lease), signals readiness, and holds the lease
 * until killed. Managers in one process share a lease per session, so only a
 * real second process contends.
 */
async function spawnHolder(
	tempDir: TempDir,
	sessionFile: string,
): Promise<{ holder: Bun.Subprocess<"pipe", "pipe", "pipe">; ready: Promise<void> }> {
	const script = tempDir.join("holder.ts");
	await Bun.write(
		script,
		[
			`import { SessionManager } from ${JSON.stringify(SESSION_MANAGER_MODULE)};`,
			"const manager = await SessionManager.open(process.argv[2], undefined, undefined, { suppressBreadcrumb: true });",
			'manager.appendMessage({ role: "user", content: "holder turn", timestamp: Date.now() });',
			"await manager.flush();",
			'process.stdout.write("ready\\n");',
			"for await (const _ of console) {}",
			"await manager.close();",
		].join("\n"),
	);
	const holder = Bun.spawn([process.execPath, script, sessionFile], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const ready = (async () => {
		const reader = holder.stdout.getReader();
		let buffered = "";
		try {
			while (!buffered.includes("ready")) {
				const { done, value } = await reader.read();
				if (done) {
					const stderr = await new Response(holder.stderr).text();
					throw new Error(`Holder exited before signaling readiness: ${stderr}`);
				}
				buffered += new TextDecoder().decode(value);
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return { holder, ready };
}

describe("SessionManager.renameSessionTitle", () => {
	it("sticks across a fresh open and appends a title_change entry", async () => {
		using tempDir = TempDir.createSync("@omp-rename-session-title-");
		const sessionFile = await createSession(tempDir);

		expect(await SessionManager.renameSessionTitle(sessionFile, "Renamed")).toBe("Renamed");

		const manager = await reopen(sessionFile, tempDir);
		try {
			expect(manager.getSessionName()).toBe("Renamed");
			const titles = manager.getEntries().filter(entry => entry.type === "title_change");
			expect(titles).toHaveLength(1);
			expect(titles[0]).toMatchObject({ title: "Renamed", source: "user" });
		} finally {
			await manager.close();
		}
		// Renamed in place: no sibling file.
		expect(sessionFiles(tempDir.path())).toHaveLength(1);
	});

	it("returns the title as stored, not the input", async () => {
		using tempDir = TempDir.createSync("@omp-rename-session-title-canonical-");
		const sessionFile = await createSession(tempDir);

		// The session collapses runs of whitespace, so the caller must learn
		// the stored title rather than assume its input was kept verbatim.
		expect(await SessionManager.renameSessionTitle(sessionFile, "Foo  Bar")).toBe("Foo Bar");

		const manager = await reopen(sessionFile, tempDir);
		try {
			expect(manager.getSessionName()).toBe("Foo Bar");
		} finally {
			await manager.close();
		}
	});

	it("a second manager holding the file blocks the rename", async () => {
		using tempDir = TempDir.createSync("@omp-rename-session-title-held-");
		const sessionFile = await createSession(tempDir);

		const { holder, ready } = await spawnHolder(tempDir, sessionFile);
		try {
			await ready;
			expect(await SessionManager.renameSessionTitle(sessionFile, "Blocked")).toBeNull();
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
		}

		// No sibling rename: the file still holds the holder's transcript with no title.
		expect(sessionFiles(tempDir.path())).toHaveLength(1);
		const reread = await reopen(sessionFile, tempDir);
		try {
			expect(reread.getSessionName()).toBeUndefined();
			expect(reread.getEntries().filter(entry => entry.type === "title_change")).toHaveLength(0);
			expect(
				reread
					.getEntries()
					.flatMap(entry =>
						entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
					),
			).toEqual(["before", "holder turn"]);
		} finally {
			await reread.close();
		}
	}, 30_000);
});

describe("SessionManager.appendCustomEntriesToFile", () => {
	const RECORDS = [
		{ customType: "task_spawn", data: { id: "notes-1", discarded: true } },
		{ customType: "task_spawn", data: { id: "notes-2", discarded: true } },
	];
	const customData = (manager: SessionManager) =>
		manager.getEntries().flatMap(entry => (entry.type === "custom" ? [entry.data] : []));

	/** A session with two entries, in `dir`; returns its file, its id and its last entry's id. */
	async function twoEntrySession(dir: string, storage: SessionStorage = new FileSessionStorage()) {
		const creator = SessionManager.create(dir, dir, storage);
		await creator.ensureOnDisk();
		creator.appendMessage(userTurn("first"));
		creator.appendMessage(userTurn("last"));
		const file = creator.getSessionFile();
		const id = creator.getSessionId();
		const lastId = creator.getLeafId();
		await creator.close();
		if (!file || !lastId) throw new Error("Expected a session on disk");
		return { file, id, lastId };
	}

	it("appends the entries to a session no manager here holds, after its last entry", async () => {
		using tempDir = TempDir.createSync("@omp-append-custom-entries-");
		const { file, id, lastId } = await twoEntrySession(tempDir.path());

		expect(await SessionManager.appendCustomEntriesToFile(id, file, RECORDS)).toBe("appended");

		const manager = await reopen(file, tempDir);
		try {
			expect(customData(manager)).toEqual(RECORDS.map(record => record.data));
			const custom = manager.getEntries().filter(entry => entry.type === "custom");
			expect(custom.map(entry => entry.parentId)).toEqual([lastId, custom[0]?.id]);
		} finally {
			await manager.close();
		}
		expect(sessionFiles(tempDir.path())).toHaveLength(1);
	});

	it("writes nothing while another live process holds the session", async () => {
		using tempDir = TempDir.createSync("@omp-append-custom-entries-held-");
		const { file, id } = await twoEntrySession(tempDir.path());

		const { holder, ready } = await spawnHolder(tempDir, file);
		try {
			await ready;
			expect(await SessionManager.appendCustomEntriesToFile(id, file, RECORDS)).toBe("refused");
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
		}

		expect(sessionFiles(tempDir.path())).toHaveLength(1);
		const reread = await reopen(file, tempDir);
		try {
			expect(customData(reread)).toEqual([]);
		} finally {
			await reread.close();
		}
	}, 30_000);

	it("writes nothing into a file that now holds another session, with or without a lease", async () => {
		// The lease refuses a header naming another id; a storage with no lease is held to the loaded session's id.
		using tempDir = TempDir.createSync("@omp-append-custom-entries-other-");
		const own = await twoEntrySession(tempDir.path());
		const other = await twoEntrySession(tempDir.path());
		const noLease = new FileSessionStorage();
		Object.defineProperty(noLease, "claimSession", { value: undefined });

		expect(await SessionManager.appendCustomEntriesToFile(own.id, other.file, RECORDS)).toBe("refused");
		expect(await SessionManager.appendCustomEntriesToFile(own.id, other.file, RECORDS, noLease)).toBe("refused");

		const reread = await reopen(other.file, tempDir);
		try {
			expect(customData(reread)).toEqual([]);
		} finally {
			await reread.close();
		}
	});

	it("writes nothing when the session holds none of the entries the caller names", async () => {
		using tempDir = TempDir.createSync("@omp-append-custom-entries-holding-");
		const { file, id, lastId } = await twoEntrySession(tempDir.path());

		expect(
			await SessionManager.appendCustomEntriesToFile(id, file, RECORDS, undefined, { holding: ["not-in-it"] }),
		).toBe("no-records");
		const reread = await reopen(file, tempDir);
		try {
			expect(customData(reread)).toEqual([]);
		} finally {
			await reread.close();
		}
		expect(
			await SessionManager.appendCustomEntriesToFile(id, file, RECORDS, undefined, {
				holding: ["not-in-it", lastId],
			}),
		).toBe("appended");
	});

	it("rejects, and makes no session, when the file is gone by the time it is opened", async () => {
		// The file goes after the lease is claimed (which reads its header) and before the open, which then throws
		// (`throwIfMissing`) instead of making a session at the path.
		using tempDir = TempDir.createSync("@omp-append-custom-entries-gone-");
		const { file, id } = await twoEntrySession(tempDir.path());
		class GoneAtOpenStorage extends FileSessionStorage {
			#removed = false;
			override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
				const release = super.claimSession(sessionId, sessionPath);
				if (!this.#removed) {
					this.#removed = true;
					fs.rmSync(sessionPath, { force: true });
				}
				return release;
			}
		}

		await expect(
			SessionManager.appendCustomEntriesToFile(id, file, RECORDS, new GoneAtOpenStorage()),
		).rejects.toThrow(/ENOENT/);
		expect(sessionFiles(tempDir.path())).toEqual([]);
	});

	it("writes through the session's own storage, not the disk", async () => {
		// A host keeping its sessions in another store (SQL, Redis) gets the entries there.
		using tempDir = TempDir.createSync("@omp-append-custom-entries-store-");
		const storage = new MemorySessionStorage();
		const { file, id } = await twoEntrySession(tempDir.path(), storage);
		const owner = SessionManager.create(tempDir.path(), tempDir.path(), storage);

		expect(await owner.appendCustomEntriesToSession(id, file, RECORDS)).toBe("appended");

		const reread = await SessionManager.open(file, tempDir.path(), storage, { suppressBreadcrumb: true });
		try {
			expect(customData(reread)).toEqual(RECORDS.map(record => record.data));
		} finally {
			await reread.close();
			await owner.close();
		}
		expect(sessionFiles(tempDir.path())).toEqual([]);
	});

	it("makes a load of the file wait for an append still running, so the next entry follows the appended ones", async () => {
		// If this regresses, a session that goes back to the file at once (a quick `/resume` back) loads it before the
		// entries are in, and its next entry follows the old last entry: the appended ones are left on a side branch.
		using tempDir = TempDir.createSync("@omp-append-custom-entries-race-");
		const { file, id } = await twoEntrySession(tempDir.path());
		using otherDir = TempDir.createSync("@omp-append-custom-entries-race-other-");
		const other = await twoEntrySession(otherDir.path());
		class SlowReadStorage extends FileSessionStorage {
			override async readText(sessionPath: string): Promise<string> {
				await Bun.sleep(300);
				return super.readText(sessionPath);
			}
		}
		const live = await SessionManager.open(other.file, otherDir.path(), new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});

		const appending = SessionManager.appendCustomEntriesToFile(id, file, RECORDS, new SlowReadStorage());
		await live.setSessionFile(file);
		live.appendCustomEntry("after-resume", {});
		await live.flush();
		await live.close();
		expect(await appending).toBe("appended");

		const reread = await reopen(file, tempDir);
		try {
			const branch = reread.getBranch();
			expect(branch.at(-1)).toMatchObject({ type: "custom", customType: "after-resume" });
			expect(branch.filter(entry => entry.type === "custom" && entry.customType === "task_spawn")).toHaveLength(2);
		} finally {
			await reread.close();
		}
	});
});
