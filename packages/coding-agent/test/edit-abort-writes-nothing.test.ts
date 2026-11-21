import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tmpDir: string;

function createSession(): ToolSession {
	const getArtifactsDir = () => path.join(tmpDir, "artifacts");
	const getSessionId = () => "session-a";
	return {
		cwd: tmpDir,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => path.join(tmpDir, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir,
		getSessionId,
		localProtocolOptions: { getArtifactsDir, getSessionId },
		settings: Settings.isolated({ "edit.enforceSeenLines": false }),
	} as ToolSession;
}

/**
 * A file-written `held://` scheme whose `locate` answers only once `release()` is called, so an
 * edit of `held://n.md` is inside its native apply, waiting on the host, until then.
 */
function registerHeldScheme(backing: string) {
	const located = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const handler: ProtocolHandler = {
		scheme: "held",
		spec: {
			backing: "file",
			selectors: "lines",
			immutable: false,
			write: { via: "file", payload: "text", scope: "workspace", tier: () => "write" },
		},
		resolve: async url => ({ url: url.href, content: await Bun.file(backing).text(), contentType: "text/plain" }),
		locate: async () => {
			located.resolve();
			await released.promise;
			return backing;
		},
	};
	InternalUrlRouter.instance().register(handler);
	return { located: located.promise, release: () => released.resolve() };
}

beforeEach(async () => {
	resetSettingsForTest();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-edit-abort-"));
	await Settings.init({ inMemory: true, cwd: tmpDir });
});

afterEach(async () => {
	InternalUrlRouter.instance().unregister("held");
	resetSettingsForTest();
	await removeWithRetries(tmpDir);
});

describe("EditTool and its call's abort signal", () => {
	it("an edit aborted while its native apply waits writes nothing and ends as aborted", async () => {
		const backing = path.join(tmpDir, "n.md");
		await Bun.write(backing, "old\n");
		const held = registerHeldScheme(backing);
		const controller = new AbortController();
		const call = new EditTool(createSession(), "replace").execute(
			"aborted",
			{ path: "held://n.md", old_string: "old", new_string: "new" },
			controller.signal,
		);
		await held.located;
		controller.abort();
		held.release();

		const error = await call.then(
			() => undefined,
			(rejection: unknown) => rejection,
		);
		// The file first, so a failure shows whether the aborted call wrote.
		expect(await Bun.file(backing).text()).toBe("old\n");
		expect(error).toBeInstanceOf(ToolAbortError);
		expect((error as ToolAbortError).message).toBe("Edit cancelled before it wrote anything; no file was changed.");
	});

	it("the same edit, not aborted, writes", async () => {
		const backing = path.join(tmpDir, "n.md");
		await Bun.write(backing, "old\n");
		const held = registerHeldScheme(backing);
		const controller = new AbortController();
		const call = new EditTool(createSession(), "replace").execute(
			"not-aborted",
			{ path: "held://n.md", old_string: "old", new_string: "new" },
			controller.signal,
		);
		await held.located;
		held.release();

		const result = await call;
		expect(result.isError).not.toBe(true);
		expect(await Bun.file(backing).text()).toBe("new\n");
	});
});
