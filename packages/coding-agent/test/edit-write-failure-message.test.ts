import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tmpDir: string;

function createSession({
	enableLsp = false,
	getClientBridge,
}: { enableLsp?: boolean; getClientBridge?: () => ClientBridge | undefined } = {}): ToolSession {
	const getArtifactsDir = () => path.join(tmpDir, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd: tmpDir,
		hasUI: false,
		enableLsp,
		getSessionFile: () => path.join(tmpDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
		getClientBridge,
	} as ToolSession;
}

beforeEach(async () => {
	resetSettingsForTest();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-write-failure-"));
	await Settings.init({ inMemory: true, cwd: tmpDir });
});

afterEach(async () => {
	resetSettingsForTest();
	await removeWithRetries(tmpDir);
});

describe("EditTool's message for a write that fails", () => {
	it("a bridge write that the call's abort stops reports the abort, not an empty error", async () => {
		// The session's bridge lookup aborts the call as the write begins, so the bridge route's last
		// check fails the write before the client is asked to write.
		const target = path.join(tmpDir, "n.md");
		await Bun.write(target, "old\n");
		const controller = new AbortController();
		const bridgeWrites: string[] = [];
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async ({ path: written }) => {
				bridgeWrites.push(written);
			},
		};
		const session = createSession({
			getClientBridge: () => {
				controller.abort();
				return bridge;
			},
		});

		const result = await new EditTool(session, "replace").execute(
			"aborted-bridge-write",
			{ path: "n.md", old_string: "old", new_string: "new" },
			controller.signal,
		);

		// The file first, so a failure shows whether the call wrote.
		expect(await Bun.file(target).text()).toBe("old\n");
		expect(bridgeWrites).toEqual([]);
		expect(result.isError).toBe(true);
		expect(result.details?.errorKind).toBe("write_failed");
		expect(result.content).toEqual([{ type: "text", text: ToolAbortError.MESSAGE }]);
	});

	it("a bridge write that fails with an Error reports that Error's message", async () => {
		const target = path.join(tmpDir, "n.md");
		await Bun.write(target, "old\n");
		const bridge: ClientBridge = {
			capabilities: { writeTextFile: true },
			writeTextFile: async () => {
				throw new Error("the editor refused the write");
			},
		};
		const session = createSession({ getClientBridge: () => bridge });

		const result = await new EditTool(session, "replace").execute("refused-bridge-write", {
			path: "n.md",
			old_string: "old",
			new_string: "new",
		});

		expect(await Bun.file(target).text()).toBe("old\n");
		expect(result.isError).toBe(true);
		expect(result.details?.errorKind).toBe("write_failed");
		expect(result.content).toEqual([{ type: "text", text: "the editor refused the write" }]);
	});
});
