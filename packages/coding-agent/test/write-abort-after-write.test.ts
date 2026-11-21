import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

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
});
