/**
 * Two forks fail when the session store refuses their writes, because each must write a transfer
 * notice: resuming a session that moved away, and unpacking a session whose local copy diverged. The
 * caller is told the resume or the unpack failed, so no later write that lands on the store may create
 * the fork afterwards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	forkIfMovedAway,
	markSessionMoved,
	packSession,
	unpackSession,
} from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { installFullDisk } from "./helpers/refusing-session-stores";
import { makeAssistantMessage } from "./session-manager/helpers";

async function sessionWithOneTurn(cwd: string, text: string): Promise<string> {
	const session = SessionManager.create(cwd);
	session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	const file = session.getSessionFile();
	if (!file) throw new Error("session has no file");
	await session.close();
	return file;
}

async function appendTurn(sessionFile: string, text: string): Promise<void> {
	const session = await SessionManager.open(sessionFile);
	session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	session.appendMessage(makeAssistantMessage());
	await session.flush();
	await session.close();
}

/** A write by another session that lands on the file store, and its close. */
async function anotherSessionWrites(dir: string): Promise<void> {
	const other = SessionManager.create(dir, path.join(dir, "other-sessions"));
	other.appendMessage(makeAssistantMessage());
	await other.close();
}

describe("a fork that fails because the store refuses its writes", () => {
	let root: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-transfer-refused-"));
		setAgentDir(path.join(root, "agent"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("resuming a session that moved away rejects, and no later write creates the fork", async () => {
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const file = await sessionWithOneTurn(cwd, "hello");
		await markSessionMoved(file, "cloud");
		const sessionDir = path.dirname(file);
		const before = new Set(fs.readdirSync(sessionDir));
		// The store refuses every new file in the session directory: the fork's writes.
		const disk = installFullDisk(fpath => path.dirname(fpath) === sessionDir && fpath !== file);

		const manager = await SessionManager.open(file);
		await expect(forkIfMovedAway(manager)).rejects.toThrow("ENOSPC");
		expect(disk.refused).toBeGreaterThan(0);

		disk.full = false;
		await anotherSessionWrites(root);
		expect(fs.readdirSync(sessionDir).filter(name => !before.has(name))).toEqual([]);
	});

	it("unpacking a session whose local copy diverged rejects, and no later write creates the fork", async () => {
		const laptopCwd = path.join(root, "laptop", "project");
		const cloudCwd = path.join(root, "cloud", "project");
		fs.mkdirSync(laptopCwd, { recursive: true });
		fs.mkdirSync(cloudCwd, { recursive: true });
		const laptopAgent = path.join(root, "laptop-agent");
		setAgentDir(laptopAgent);
		const laptopFile = await sessionWithOneTurn(laptopCwd, "first");
		await packSession(laptopFile, path.join(root, "out.tar"));
		setAgentDir(path.join(root, "cloud-agent"));
		const unpacked = await unpackSession(path.join(root, "out.tar"), { cwd: cloudCwd });
		await appendTurn(unpacked.sessionFile, "cloud work");
		await packSession(unpacked.sessionFile, path.join(root, "back.tar"));
		setAgentDir(laptopAgent);
		// The laptop copy diverges from the archive.
		await appendTurn(laptopFile, "laptop work");
		const sessionDir = path.dirname(laptopFile);
		const before = new Set(fs.readdirSync(sessionDir));
		const disk = installFullDisk(fpath => path.dirname(fpath) === sessionDir && fpath !== laptopFile);

		await expect(unpackSession(path.join(root, "back.tar"), { cwd: laptopCwd })).rejects.toThrow("ENOSPC");
		expect(disk.refused).toBeGreaterThan(0);

		disk.full = false;
		await anotherSessionWrites(root);
		expect(fs.readdirSync(sessionDir).filter(name => !before.has(name))).toEqual([]);
	});
});
