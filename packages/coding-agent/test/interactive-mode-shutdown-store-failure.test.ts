import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import * as natives from "@oh-my-pi/pi-natives";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

// Regression coverage for #12238: when the session store keeps failing, the
// close-time write fails and dispose() rejects. shutdown() used to swallow the
// error, reset its own latch, and return without ever exiting — so the process
// stayed alive and every further Ctrl+C repeated the identical failure. The
// escape hatch is a second Ctrl+C that exits without writing the session log,
// and it must be reachable with a SINGLE press after the error message (the
// double-tap gate would otherwise demand two rapid presses).
//
// The failure comes from the REAL persistence path, not a mocked error: a
// file-backed SessionManager materializes a genuine session file, then its
// directory is replaced by a regular file, so every real write fails, and an
// entry the store never took makes the real dispose()/close() reject into
// shutdown(). (A file another writer appended to no longer fails: the session
// moves to a sibling file, covered by the SessionManager freshness tests.)
describe("InteractiveMode shutdown when the session store keeps failing (#12238)", () => {
	const BLOCKER = "not a directory\n";
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: TempDir;
	let sessionDir: string;
	let quitSpy: Mock<typeof postmortem.quit>;
	let quitCalled: PromiseWithResolvers<void>;
	let exitSpy: Mock<typeof postmortem.exitProcess>;
	let showErrorSpy: Mock<typeof InteractiveMode.prototype.showError>;
	let disposeSpy: Mock<typeof session.dispose>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-shutdown-store-failure-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		// File-backed (not inMemory): the failure under test comes from the real
		// storage backend's write path.
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.terminal.drainInput = async () => {};

		// A real conversation crosses the lazy gate and materializes the session
		// file on disk.
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "yo" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			api: "anthropic-messages",
			timestamp: Date.now(),
		});
		await sessionManager.ensureOnDisk();
		const materializedFile = sessionManager.getSessionFile();
		if (!materializedFile) throw new Error("expected a materialized session file");
		// Replace the session directory with a regular file: every later write
		// (temp file, publish lock, append) fails for real, on every platform.
		sessionDir = path.dirname(materializedFile);
		await fs.rm(sessionDir, { recursive: true, force: true });
		await Bun.write(sessionDir, BLOCKER);

		// Any real full-body rewrite (compaction, branch, entry discard, title
		// repair) now fails, and the manager latches the failure. A latched
		// failure that cost no entry does not fail a close, so the test also
		// makes the write the close must report: an entry the store refuses. It
		// does not lean on the session-exit entry dispose() appends, which a
		// postmortem exit pass that already ran in this process (another test
		// file's) records at once, when the session is built.
		await sessionManager.rewriteEntries().catch(() => undefined);
		sessionManager.appendMessage({ role: "user", content: "the store refuses this", timestamp: Date.now() });
		await sessionManager.flush().catch(() => undefined);

		quitCalled = Promise.withResolvers<void>();
		quitSpy = vi.spyOn(postmortem, "quit").mockImplementation(async () => {
			quitCalled.resolve();
		});
		exitSpy = vi.spyOn(postmortem, "exitProcess").mockImplementation(() => undefined as never);
		showErrorSpy = vi.spyOn(mode, "showError").mockImplementation(() => {});
		// Observe only: the real dispose implementation runs.
		disposeSpy = vi.spyOn(session, "dispose");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		authStorage.close();
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("surfaces the store failure on the first attempt without force-exiting", async () => {
		await mode.shutdown();

		expect(disposeSpy).toHaveBeenCalledTimes(1);
		const disposeResult = disposeSpy.mock.results[0]?.value as Promise<void>;
		const disposeError = await disposeResult.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(disposeError).toBeInstanceOf(Error);
		const message = showErrorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
		expect(message).toContain("Could not close session");
		// The surfaced detail is the store's own failure, end to end.
		expect(message).toContain((disposeError as Error).message);
		// Must not force-exit yet: the user gets one chance to see the error.
		expect(quitSpy).not.toHaveBeenCalled();
		// The latch is cleared so a second Ctrl+C can re-enter shutdown().
		expect(mode.isShuttingDown).toBe(false);
		expect(mode.teardownFailed).toBe(true);
		expect(await Bun.file(sessionDir).text()).toBe(BLOCKER);
	});

	it("exits without writing the session log on the second attempt", async () => {
		await mode.shutdown();
		await mode.shutdown();

		// The second Ctrl+C is the escape hatch: it quits rather than re-running
		// the teardown that already failed once (dispose stays memoized at 1 call).
		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		// "Without writing the session log": the failed store is left as it was.
		expect(await Bun.file(sessionDir).text()).toBe(BLOCKER);
	});

	it("a single Ctrl+C keypress after the failure reaches the escape hatch", async () => {
		await mode.shutdown(); // arms the escape hatch and shows the message
		quitSpy.mockClear();

		// The user-facing path: one Ctrl+C, long after the original gesture, so the
		// 500ms double-tap gate would normally just clear the editor. With a failed
		// teardown armed it must route straight into shutdown()'s force-quit.
		mode.lastSigintTime = 0; // a single, non-double-tapped press
		mode.handleCtrlC();
		await quitCalled.promise;

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1); // never re-runs the doomed teardown
		expect(await Bun.file(sessionDir).text()).toBe(BLOCKER);
	});

	it("a failed restart arms the same single-Ctrl+C escape hatch", async () => {
		// Stop at the process replacement boundary. A restart whose teardown did not fail relaunches the CLI in
		// this process's place (execReplace) or as a child on its stdio (Bun.spawn), which ends or takes over the
		// test run; here it fails this test instead.
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => undefined as never);
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as never);
		const cleanup = vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		const drain = vi.spyOn(postmortem, "drainStdout").mockResolvedValue();

		await mode.restart();
		// The failed teardown returns before any of the relaunch.
		expect(exec).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(cleanup).not.toHaveBeenCalled();
		expect(drain).not.toHaveBeenCalled();
		expect(mode.teardownFailed).toBe(true);
		quitSpy.mockClear();

		mode.lastSigintTime = 0;
		mode.handleCtrlC();
		await quitCalled.promise;

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(await Bun.file(sessionDir).text()).toBe(BLOCKER);
	});

	it("bypasses a guarded process.exit after cleanup", async () => {
		await mode.shutdown();
		quitSpy.mockRejectedValueOnce(new Error("process.exit is guarded"));

		await mode.shutdown();

		expect(quitSpy).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledTimes(1);
		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});
});
