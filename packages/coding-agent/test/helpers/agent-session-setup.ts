import { Database } from "bun:sqlite";
import { vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools";

/**
 * Shared factory for building a minimal mock `AssistantMessage`
 * used by AgentSession test suites.
 */
export function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Build isolated auth state without opening a filesystem-backed SQLite database.
 * AgentSession unit tests that only need a runtime API key should not pay for
 * database creation, journaling, and deletion on every case.
 */
export function createInMemoryAuthStorage(): AuthStorage {
	return new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
}

/**
 * Make `todo` the session's active tool. Todo stop reminders only fire while
 * the todo tool is active, so reminder tests on tool-less sessions need this.
 */
export function activateTodoTool(session: AgentSession, cwd: string): void {
	session.agent.setTools([
		new TodoTool({
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: session.settings,
		}),
	]);
}

/** A session whose settings load a `--config` overlay file. */
export interface OverlaySession {
	session: AgentSession;
	settings: Settings;
	/** Path of the overlay file. */
	overlay: string;
}

/**
 * A call of the session a settings reload may start, which {@link reloadOverlay} waits for: a rebuild, or the hold of a
 * change no rebuild takes.
 */
export type OverlayRebuild =
	| "refreshBaseSystemPrompt"
	| "reconcileBuiltinTools"
	| "refreshSkillsAndCommands"
	| "holdToolDeclarationChange";

/** How {@link reloadOverlay} waits for the calls a reload starts. */
export interface ReloadOverlayOptions {
	/**
	 * Wait one turn of the event loop, with no delay, before collecting the calls, instead of one microtask: a listener
	 * that awaits before its call (the auto-QA one awaits the workspace roots) reaches it within that turn, and exposes
	 * no promise to await.
	 */
	eventLoopTurn?: boolean;
}

/**
 * Rewrites the overlay file with `content` and reloads it as the config watcher does, then waits for each call of the
 * session's `rebuilds` the change starts.
 */
export async function reloadOverlay(
	{ session, settings, overlay }: OverlaySession,
	content: string,
	rebuilds: readonly OverlayRebuild[] = [
		"refreshBaseSystemPrompt",
		"reconcileBuiltinTools",
		"refreshSkillsAndCommands",
	],
	{ eventLoopTurn = false }: ReloadOverlayOptions = {},
): Promise<void> {
	const spies = rebuilds.map(rebuild => vi.spyOn(session, rebuild));
	await Bun.write(overlay, content);
	await settings.reloadFromDisk();
	// The settings listeners run in the microtask the reload queued for them.
	if (eventLoopTurn) await Bun.sleep(0);
	else await Promise.resolve();
	await Promise.all(spies.flatMap(spy => spy.mock.results.map(result => result.value)));
	for (const spy of spies) spy.mockRestore();
}
