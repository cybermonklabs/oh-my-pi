import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { readArchiveEntries, writeArchive } from "@oh-my-pi/pi-utils/ar";

const ABORT_NOTE = "Note: the call was aborted after this write had begun; the write was completed.";

let tmpDir: string;

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: tmpDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({}),
		...overrides,
	} as ToolSession;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(part => part.text ?? "").join("\n");
}

/** The call's result, or what it rejected with. */
function settle(call: Promise<unknown>): Promise<unknown> {
	return call.then(
		result => result,
		(rejection: unknown) => rejection,
	);
}

/** Runs every queued microtask (no timer elapses), so the rest of a call's synchronous body has run. */
function drain(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Calls `onWrite` with each path `Bun.write` writes, once the write has landed. */
function watchBunWrite(onWrite: (destination: unknown) => void): void {
	const write = Bun.write;
	spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
		const written: number = await Reflect.apply(write, Bun, args);
		onWrite(args[0]);
		return written;
	}) as never);
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-abort-"));
});

afterEach(async () => {
	mock.restore();
	await removeWithRetries(tmpDir);
});

describe("the write tool and an abort after its write began", () => {
	it("a write on disk that the abort meets after it lands is reported as written, with the abort noted", async () => {
		const target = path.join(tmpDir, "n.md");
		await Bun.write(target, "old\n");
		const controller = new AbortController();
		watchBunWrite(destination => {
			if (destination === target) controller.abort();
		});

		const settled = await settle(
			new WriteTool(createSession()).execute(
				"landed-disk-write",
				{ path: "n.md", content: "new\n" },
				controller.signal,
			),
		);

		// The file first, so a failure shows whether the call wrote.
		expect(await Bun.file(target).text()).toBe("new\n");
		expect(controller.signal.aborted).toBe(true);
		expect(settled).not.toBeInstanceOf(Error);
		const text = resultText(settled as { content: Array<{ type: string; text?: string }> });
		expect(text).toContain("Successfully wrote 4 bytes to n.md");
		expect(text).toContain(ABORT_NOTE);
	});

	it("a write through an ACP client that the abort meets after the client wrote is reported as written", async () => {
		const target = path.join(tmpDir, "n.md");
		await Bun.write(target, "old\n");
		const controller = new AbortController();
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: written, content }) => {
				await Bun.write(written, content);
				controller.abort();
			},
		};

		const settled = await settle(
			new WriteTool(createSession({ getClientBridge: () => bridge })).execute(
				"landed-bridge-write",
				{ path: "n.md", content: "new\n" },
				controller.signal,
			),
		);

		expect(await Bun.file(target).text()).toBe("new\n");
		expect(settled).not.toBeInstanceOf(Error);
		expect(resultText(settled as { content: Array<{ type: string; text?: string }> })).toContain(ABORT_NOTE);
	});

	it("a write the abort meets before it begins ends as aborted and writes nothing", async () => {
		const target = path.join(tmpDir, "n.md");
		const controller = new AbortController();
		// The session's bridge lookup comes after every step that resolves the target and before
		// the write: the abort lands there. For a new file, nothing between it and the write
		// awaits, so the write's progress update would come before this call returns.
		const session = createSession({
			getClientBridge: () => {
				controller.abort();
				return undefined;
			},
		});
		const progress: unknown[] = [];

		const settled = await settle(
			new WriteTool(session).execute(
				"aborted-before-write",
				{ path: "n.md", content: "new\n" },
				controller.signal,
				update => progress.push(update),
			),
		);
		await drain();

		expect(settled).toBeInstanceOf(Error);
		// The call ends at the abort, as before: the standard abort error, not the body's own check.
		expect((settled as Error).message).toStartWith("Aborted:");
		expect(progress).toEqual([]);
		expect(existsSync(target)).toBe(false);
	});

	it("a SQLite row write the abort meets before it begins writes no row", async () => {
		const dbPath = path.join(tmpDir, "data.sqlite");
		const setup = new Database(dbPath);
		setup.run("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)");
		setup.close();
		const controller = new AbortController();
		// The plan-mode lookup is the last step before the row write: the abort lands there.
		const session = createSession({
			getPlanModeState: () => {
				controller.abort();
				return undefined;
			},
		});

		const settled = await settle(
			new WriteTool(session).execute(
				"aborted-before-row",
				{ path: `${dbPath}:users`, content: "{ name: 'Grace' }" },
				controller.signal,
			),
		);
		await drain();

		expect(settled).toBeInstanceOf(Error);
		const db = new Database(dbPath, { readonly: true });
		try {
			expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
		} finally {
			db.close();
		}
	});

	it("an archive member write that the abort meets once its rename lands is reported as written", async () => {
		const archive = path.join(tmpDir, "bundle.tar");
		await writeArchive(archive, "tar", [["m.txt", "old"]]);
		const controller = new AbortController();
		// The member write publishes its new archive with one rename; the abort lands right after it.
		const rename = fs.rename;
		spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (to === archive) controller.abort();
		});

		const settled = await settle(
			new WriteTool(createSession()).execute(
				"landed-archive-member",
				{ path: `${archive}:m.txt`, content: "new" },
				controller.signal,
			),
		);

		const members = await readArchiveEntries({ path: archive, format: "tar" });
		expect(await new Response(members.get("m.txt")).text()).toBe("new");
		expect(controller.signal.aborted).toBe(true);
		expect(settled).not.toBeInstanceOf(Error);
		const text = resultText(settled as { content: Array<{ type: string; text?: string }> });
		expect(text).toContain("Successfully wrote 3 bytes to");
		expect(text).toContain(ABORT_NOTE);
	});
});

describe("the write tool and an abort around a conflict:// write", () => {
	const TWO_WAY = [
		"line 1",
		"<<<<<<< HEAD",
		"oldApi(x)",
		"=======",
		"newApi(x)",
		">>>>>>> feature/x",
		"line N",
		"",
	].join("\n");

	async function conflictTools(session: ToolSession) {
		const tools = await createTools(session, ["read", "write"]);
		const read = tools.find(tool => tool.name === "read");
		const write = tools.find(tool => tool.name === "write");
		if (!read || !write) throw new Error("missing read or write tool");
		return { read, write };
	}

	/** Settles once each `conflict://` handler run of the router has ended, counting the runs. */
	function watchHandlerRuns(): { runs: () => number; settled: () => Promise<unknown> } {
		const router = InternalUrlRouter.instance();
		const write = router.write.bind(router);
		const running: Promise<unknown>[] = [];
		spyOn(router, "write").mockImplementation((...args: Parameters<typeof router.write>) => {
			const run = write(...args);
			running.push(run.catch(() => {}));
			return run;
		});
		return { runs: () => running.length, settled: () => Promise.all(running) };
	}

	it("a conflict:// write that the abort meets after its handler checked the file writes nothing", async () => {
		const filePath = path.join(tmpDir, "foo.ts");
		await Bun.write(filePath, TWO_WAY);
		const controller = new AbortController();
		const session = createSession();
		const { read, write } = await conflictTools(session);
		await read.execute("read-foo", { path: "foo.ts" });
		const handler = watchHandlerRuns();
		// The handler's own check that the file exists comes before it reads and splices it.
		const exists = fs.exists;
		spyOn(fs, "exists").mockImplementation(async target => {
			const found = await exists(target);
			if (target === filePath) controller.abort();
			return found;
		});

		const settled = await settle(
			write.execute("aborted-conflict", { path: "conflict://1", content: "newApi(x);\n" }, controller.signal),
		);
		await handler.settled();

		expect(handler.runs()).toBe(1);
		expect(settled).toBeInstanceOf(Error);
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("a conflict:// write that the abort meets at the plan-mode check never reaches its handler", async () => {
		const filePath = path.join(tmpDir, "foo.ts");
		await Bun.write(filePath, TWO_WAY);
		const controller = new AbortController();
		const session = createSession({
			getPlanModeState: () => {
				controller.abort();
				return undefined;
			},
		});
		const { read, write } = await conflictTools(session);
		await read.execute("read-foo", { path: "foo.ts" });
		const handler = watchHandlerRuns();
		const progressed = Promise.withResolvers<void>();

		const settled = await settle(
			write.execute(
				"aborted-conflict-plan",
				{ path: "conflict://1", content: "newApi(x);\n" },
				controller.signal,
				() => progressed.resolve(),
			),
		);
		// The progress update comes right before the handler would be called, in the same turn.
		await progressed.promise;
		await handler.settled();

		expect(handler.runs()).toBe(0);
		expect(settled).toBeInstanceOf(Error);
		expect(await Bun.file(filePath).text()).toBe(TWO_WAY);
	});

	it("a conflict://* write that the abort meets after its first file is reported, naming the file not written", async () => {
		const first = path.join(tmpDir, "a.ts");
		const second = path.join(tmpDir, "b.ts");
		await Bun.write(first, TWO_WAY);
		await Bun.write(second, TWO_WAY);
		const controller = new AbortController();
		const session = createSession();
		const { read, write } = await conflictTools(session);
		await read.execute("read-a", { path: "a.ts" });
		await read.execute("read-b", { path: "b.ts" });
		// The second file's existence check comes after the first file is written.
		const exists = fs.exists;
		spyOn(fs, "exists").mockImplementation(async target => {
			const found = await exists(target);
			if (target === second) controller.abort();
			return found;
		});

		const settled = await settle(
			write.execute("aborted-conflict-all", { path: "conflict://*", content: "@theirs" }, controller.signal),
		);

		expect(await Bun.file(first).text()).toBe("line 1\nnewApi(x)\nline N\n");
		expect(await Bun.file(second).text()).toBe(TWO_WAY);
		expect(settled).not.toBeInstanceOf(Error);
		const text = resultText(settled as { content: Array<{ type: string; text?: string }> });
		expect(text).toContain("a.ts: 1 conflict");
		expect(text).toContain("b.ts: 1 conflict (not written: the call was aborted)");
		expect(text).toContain(ABORT_NOTE);
	});
});
