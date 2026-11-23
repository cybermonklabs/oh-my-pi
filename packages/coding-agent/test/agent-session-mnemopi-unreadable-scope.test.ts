/**
 * A session constructed over a transcript that recorded a Mnemopi recall reads the scope the live backend's recall
 * reads, to take the transcript's recall as the conversation's own only when it was recorded for that scope. Under
 * per-project scoping the scope names the project bank's database, whose directory Mnemopi creates beside the
 * configured database. Where it cannot be created (the configured database's directory is a file), the scope cannot be
 * read: the session must still be constructed (`omp render` constructs one over the file it draws, as at the release),
 * and the recall is not taken as the conversation's.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { persistRecall } from "@oh-my-pi/pi-coding-agent/memory-backend/recall-entry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const MEMORY = "The deploy host is alpha-7.";

describe("a session constructed over a Mnemopi transcript whose recall scope cannot be read", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("is constructed and does not take the transcript's recall as the conversation's", async () => {
		const dir = TempDir.createSync("@pi-mnemopi-unreadable-scope-");
		cleanups.push(() => dir.remove());
		// The configured database's directory is a file: the project bank's directory cannot be created beside it.
		await Bun.write(dir.join("blocked"), "");
		const overlay = dir.join("memory.yml");
		await Bun.write(
			overlay,
			`memory:
  backend: mnemopi
mnemopi:
  dbPath: ${dir.join("blocked", "mnemopi.db")}
  scoping: per-project
  noEmbeddings: true
  llmMode: none
`,
		);

		const writer = SessionManager.create(dir.path(), dir.join("sessions"));
		writer.appendMessage({ role: "user", content: "check the release", timestamp: Date.now() - 1_000 });
		persistRecall(writer, JSON.stringify(["mnemopi", []]), { text: MEMORY, memories: [] });
		writer.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "the release is ready" }],
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
			timestamp: Date.now(),
		});
		await writer.flush();
		const sessionFile = writer.getSessionFile();
		await writer.close();
		if (!sessionFile) throw new Error("Expected a persisted session");

		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const sessionManager = await SessionManager.open(sessionFile);
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model;
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: [], tools: [], messages: [] } }),
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		cleanups.push(() => session.dispose());

		expect(session.memoryRecall).toBeUndefined();
	}, 60_000);
});
