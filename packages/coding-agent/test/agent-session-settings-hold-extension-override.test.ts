/**
 * An extension may register a tool under a built-in's name and replace it. An edit of `disabledExtensions` (or
 * `extensions`) while a session runs suspends that extension and brings the built-in back: its definition and the
 * system prompt's listing change. On a prompt a model that binds thinking to it has answered under, that is a settings
 * change like any other: the tool keeps the definition the last request declared and the prompt keeps its bytes until
 * the held rebuild, and the hidden settings notice names the edit. A resumed process that still sends the
 * transcript's stored prompt keeps it through the edit too.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage, editExtensionSources, setClock } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	toolCallAnswer,
	toolResultOf,
	withoutCacheControl,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** {@link LONG_ENTRIES} with the extension below disabled. */
const GUARD_DISABLED = `${LONG_ENTRIES}disabledExtensions:\n  - extension-module:guard\n`;

/** What the extension's `read` declares, which the built-in's does not. */
const GUARD_DESCRIPTION = "Reads a file through the guard.";

/**
 * A project extension that replaces the built-in `read` with its own, and adds `guard_audit`, a tool of its own
 * that leaves the registry when the extension is suspended.
 */
const GUARD_EXTENSION = `export default function (pi) {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "read",
		label: "Guarded read",
		description: ${JSON.stringify(GUARD_DESCRIPTION)},
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "guarded" }] }),
	});
	pi.registerTool({
		name: "guard_audit",
		label: "Guard audit",
		description: "Lists what the guard refused.",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "nothing refused" }] }),
	});
}
`;

const MINUTE_MS = 60_000;

describe("an extension-sources edit that brings back the built-in an extension replaced", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with the project's extensions discovered, its
	 * settings loaded from an overlay with {@link LONG_ENTRIES} and `agentsMd` as its context file: runs `steps`, then
	 * exits. The gateway answers each request with `reply` of its number. Returns the requests and the session file.
	 */
	async function runProcess(
		dir: TempDir,
		agentsMd: string,
		sessionFile: string | undefined,
		steps: (session: AgentSession, edit: (overlay: string) => Promise<void>) => Promise<void>,
		reply: (turn: number) => Response = turn => answer(turn, { cacheWriteTokens: 100 }),
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, LONG_ENTRIES);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(reply);
		cleanups.push(restore);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const sessionManager = sessionFile
			? await SessionManager.open(sessionFile)
			: SessionManager.create(dir.path(), dir.join("sessions"));
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			disableExtensionDiscovery: false,
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [{ path: dir.join("AGENTS.md"), content: agentsMd }],
			skills: [],
		});
		const edit = (content: string): Promise<void> => editExtensionSources({ session, settings, overlay }, content);
		try {
			await steps(session, edit);
			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session");
			return { requests, sessionFile: file };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	/** A test directory with the gateway's models and the project extension that replaces `read`. */
	async function projectWithGuard(): Promise<TempDir> {
		const dir = TempDir.createSync("@pi-settings-hold-extension-override-");
		cleanups.push(() => dir.removeSync());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(path.join(getProjectAgentDir(dir.path()), "extensions", "guard.ts"), GUARD_EXTENSION);
		return dir;
	}

	it("keeps the tool's definition and the prompt until the held rebuild, names the edit, and runs the built-in", async () => {
		const dir = await projectWithGuard();
		await Bun.write(dir.join("notes.txt"), "Deploys go out from host alpha-7.\n");
		// The second request's reply calls `read` on the notes; every other reply is text.
		const reply = (turn: number): Response =>
			turn === 2
				? toolCallAnswer(turn, "read", { path: "notes.txt", i: "Reading the notes" }, { cacheWriteTokens: 100 })
				: answer(turn, { cacheWriteTokens: 100 });
		const { requests } = await runProcess(
			dir,
			"Build with make.",
			undefined,
			async (session, edit) => {
				setClock(0);
				await session.prompt("first");
				await edit(GUARD_DISABLED);
				setClock(MINUTE_MS);
				await session.prompt("a minute after the edit");
				setClock(6 * MINUTE_MS);
				await session.prompt("six minutes after the edit");
			},
			reply,
		);

		const [first, second, afterCall, fourth] = requests;
		if (!first || !second || !afterCall || !fourth) throw new Error("Expected four requests");
		// Precondition: the extension's `read` replaced the built-in, and its own tool is active.
		expect(withoutCacheControl(first.tools)).toContain(GUARD_DESCRIPTION);
		expect(first.tools?.map(tool => tool.name)).toContain("guard_audit");
		// A changed definition or listing rewrites the whole cached prompt.
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		const told = textOf(second.messages.slice(first.messages.length));
		expect(told).toContain("`disabledExtensions`");
		expect(told).toContain("calls to them are refused from now on: `guard_audit`");
		// The suspended extension's code no longer runs: the call reaches the built-in `read`.
		const result = textOf(toolResultOf(afterCall, "toolu_2"));
		expect(result).toContain("alpha-7");
		expect(result).not.toContain("guarded");
		expect(withoutCacheControl(afterCall.tools)).toBe(withoutCacheControl(first.tools));
		// The held rebuild brings the built-in back five minutes after the edit, and the prompt no longer lists the
		// extension's tools (the provider keeps declaring a tool taken off the roster).
		expect(withoutCacheControl(fourth.tools)).not.toContain(GUARD_DESCRIPTION);
		expect(withoutCacheControl(fourth.system)).toContain("- Read: `read`");
		expect(withoutCacheControl(fourth.system)).not.toContain("Guard audit");
	}, 60_000);

	it("keeps the tools and the prompt through an edit set back before the held rebuild, and says the tool runs again", async () => {
		const dir = await projectWithGuard();
		const { requests } = await runProcess(dir, "Build with make.", undefined, async (session, edit) => {
			setClock(0);
			await session.prompt("first");
			await edit(GUARD_DISABLED);
			setClock(MINUTE_MS);
			await session.prompt("after the edit");
			// The extension comes back: its `read` replaces the built-in again, and its own tool returns.
			await edit(LONG_ENTRIES);
			setClock(2 * MINUTE_MS);
			await session.prompt("after the edit was set back");
		});

		const [first, second, third] = requests;
		if (!first || !second || !third) throw new Error("Expected three requests");
		expect(withoutCacheControl(third.tools)).toBe(withoutCacheControl(first.tools));
		expect(withoutCacheControl(third.system)).toBe(withoutCacheControl(first.system));
		const told = textOf(third.messages.slice(second.messages.length));
		expect(told).toContain("`disabledExtensions`");
		expect(told).toContain("calls to them run again from now on: `guard_audit`");
	}, 60_000);

	it("keeps a resumed transcript's stored prompt and the tool's definition through the edit", async () => {
		const dir = await projectWithGuard();
		const live = await runProcess(dir, "Build with make.", undefined, async session => {
			await session.prompt("first");
		});
		// The context file changed while no process ran: the resumed process keeps the transcript's stored prompt.
		const resumed = await runProcess(dir, "Build with ninja.", live.sessionFile, async (session, edit) => {
			await edit(GUARD_DISABLED);
			await session.prompt("second");
		});

		const [first] = live.requests;
		const [second] = resumed.requests;
		if (!first || !second) throw new Error("Expected the two processes' requests");
		expect(withoutCacheControl(first.tools)).toContain(GUARD_DESCRIPTION);
		expect(withoutCacheControl(second.system)).toBe(withoutCacheControl(first.system));
		expect(withoutCacheControl(second.tools)).toBe(withoutCacheControl(first.tools));
		expect(textOf(second.messages.slice(first.messages.length))).toContain("`disabledExtensions`");
	}, 60_000);
});
