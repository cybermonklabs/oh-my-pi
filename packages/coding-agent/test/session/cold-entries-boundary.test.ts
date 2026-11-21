/**
 * Where the cut leaves an entry: a patch record goes to the store wherever it
 * lies, the new model's context after a switch to another provider reads no
 * cold message, a fit check that only measures another model's context moves
 * no cut, and the request an `experimental-context-rollover` compaction's
 * context recovers from before its kept entries stays whole.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ColdEntryStore, isColdEntry } from "@oh-my-pi/pi-coding-agent/session/cold-entries";
import { isColdMessage } from "@oh-my-pi/pi-coding-agent/session/cold-message";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/** Larger than any value an entry before the cut keeps in memory. */
const BODY = "x".repeat(4096);
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
/** The custom type of a patch record. */
const ENTRY_PATCH_TYPE = "entry_patch";

function bundled(provider: "openai" | "anthropic", modelId: string): Model {
	const model = getBundledModel(provider, modelId);
	if (!model) throw new Error(`Expected bundled ${provider}/${modelId}`);
	return model;
}

const gpt = bundled("openai", "gpt-5.4");
const claude = bundled("anthropic", "claude-sonnet-4-5");

function assistant(text: string, model: Model = claude): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function message(id: string, parentId: string | null, body: object): object {
	return { type: "message", id, parentId, timestamp: TIMESTAMP, message: body };
}

function compaction(id: string, parentId: string, firstKeptEntryId: string, extra?: object): object {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: TIMESTAMP,
		summary: `${id} ${BODY}`,
		firstKeptEntryId,
		tokensBefore: 1000,
		...extra,
	};
}

/**
 * GPT turns behind a local compaction `c1` (keeping `u1`), then an OpenAI
 * remote compaction `c2` (keeping `a2`) that only GPT replays: GPT's cut is
 * `a2`, and another provider's context starts at `c1`'s kept `u1`.
 */
function remoteCompactedSession(): object[] {
	return [
		message("u0", null, user(`u0 ${BODY}`)),
		message("a0", "u0", assistant(`a0 ${BODY}`, gpt)),
		message("u1", "a0", user(`u1 ${BODY}`)),
		compaction("c1", "u1", "u1"),
		message("a1", "c1", assistant(`a1 ${BODY}`, gpt)),
		message("u2", "a1", user(`u2 ${BODY}`)),
		message("a2", "u2", assistant(`a2 ${BODY}`, gpt)),
		compaction("c2", "a2", "a2", {
			method: "remote",
			preserveData: {
				openaiRemoteCompaction: {
					provider: gpt.provider,
					replacementHistory: [
						{ type: "message", role: "user", content: [{ type: "input_text", text: "retained request" }] },
					],
				},
			},
		}),
		message("u3", "c2", user("after the remote compaction")),
		message("a3", "u3", assistant("reply", gpt)),
	];
}

/** Write `entries` after a header; the session id is the directory's name. */
async function writeSession(dir: string, entries: object[]): Promise<string> {
	const file = path.join(dir, "session.jsonl");
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: path.basename(dir),
		timestamp: TIMESTAMP,
		cwd: dir,
	};
	await Bun.write(file, [header, ...entries].map(entry => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

function open(file: string): Promise<SessionManager> {
	return SessionManager.open(file, undefined, new FileSessionStorage(), { suppressBreadcrumb: true });
}

function entryOf(manager: SessionManager, id: string) {
	const found = manager.getEntry(id);
	if (!found) throw new Error(`missing entry ${id}`);
	return found;
}

/** The cold messages a built context holds, each as its position and role. */
function coldMessages(messages: readonly { role: string }[]): string[] {
	return messages.flatMap((found, index) => (isColdMessage(found) ? [`${index}:${found.role}`] : []));
}

describe("what the cut leaves whole", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	// An elide pass followed by a compaction must not keep every patched body in memory through the record.
	it("sends a patch record that lies after the cut to the store, live and after a resume", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const rest = "r".repeat(16_000);
		const lines: object[] = [message("u0", null, user("start"))];
		const patches: object[] = [];
		let parentId = "u0";
		for (let index = 0; index < 12; index++) {
			lines.push(message(`a${index}`, parentId, assistant(`a${index} ${rest} ${rest}`)));
			patches.push({
				entryId: `a${index}`,
				message: { content: [{ type: "text", text: `a${index} [elided] ${rest}` }], elidedOutputTokens: 5 },
			});
			parentId = `a${index}`;
		}
		const data = { patches };
		lines.push({
			type: "custom",
			id: "p1",
			parentId,
			timestamp: TIMESTAMP,
			customType: ENTRY_PATCH_TYPE,
			data,
		});
		const file = await writeSession(dir.path(), lines);

		const manager = await open(file);
		// The compaction keeps the entry just before the record, so the record lies after the cut.
		manager.appendCompaction(`summary ${BODY}`, undefined, "a11", 1000);
		manager.appendMessage(assistant(`after ${BODY}`));
		manager.buildSessionContext();
		expect(isColdEntry(entryOf(manager, "p1"))).toBe(true);
		expect(isColdEntry(entryOf(manager, "a11"))).toBe(false);
		await manager.flush();
		await manager.close();

		const resumed = await open(file);
		cleanups.push(() => resumed.close());
		const record = entryOf(resumed, "p1");
		expect(isColdEntry(record)).toBe(true);
		expect(record.type === "custom" ? JSON.parse(JSON.stringify(record.data)) : undefined).toEqual(data);
	});

	// After /model to another provider, every request would read and parse those records again.
	it("leaves no cold message in the context of a model switched to after an OpenAI remote compaction", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const file = await writeSession(dir.path(), remoteCompactedSession());
		const manager = await open(file);
		cleanups.push(() => manager.close());
		expect(coldMessages(manager.buildSessionContext({ model: gpt }).messages)).toEqual([]);

		// The switch rebuilds the context for the new model before it records the model change.
		const switched = manager.buildSessionContext({ model: claude }).messages;
		expect(switched.map(found => found.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(coldMessages(switched)).toEqual([]);

		manager.appendModelChange(`${claude.provider}/${claude.id}`);
		manager.buildSessionContext({ transcript: true });
		expect(coldMessages(manager.buildSessionContext({ model: claude }).messages)).toEqual([]);
	});

	// A fallback fit check on a session that stays on its model must not bring the history behind the remote compaction back into memory.
	it("keeps the entries before the active model's cut cold after a fit check measures a model that reads an earlier compaction", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const manager = await open(await writeSession(dir.path(), remoteCompactedSession()));
		cleanups.push(() => manager.close());
		manager.buildSessionContext({ model: gpt });
		const behindRemote = ["u1", "c1", "a1", "u2"];
		expect(behindRemote.filter(id => !isColdEntry(entryOf(manager, id)))).toEqual([]);

		const authStorage = await AuthStorage.create(":memory:");
		cleanups.push(async () => authStorage.close());
		const agent = new Agent({
			initialState: {
				model: gpt,
				systemPrompt: ["Test"],
				tools: [],
				messages: manager.buildSessionContext({ model: gpt }).messages,
			},
			convertToLlm,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
		});
		cleanups.push(async () => session.dispose());
		// The session's own maintenance builds the candidate's context through the same session method.
		const host = {
			agent,
			settings,
			model: () => gpt,
			messages: () => agent.state.messages,
			nonMessageTokenSource: () => ({}),
			sessionManager: manager,
			buildDisplaySessionContext: (model?: Model, options?: { measureOnly?: boolean }) =>
				session.buildDisplaySessionContext(model, options),
			getContextUsage: () => undefined,
		} as unknown as SessionMaintenanceHost;
		const hydrationsBefore = manager.coldStoreStats().hydrations;

		expect(new SessionMaintenance(host).contextFitsModel(claude)).toBe(true);
		expect(behindRemote.filter(id => !isColdEntry(entryOf(manager, id)))).toEqual([]);
		expect(manager.coldStoreStats().hydrations).toBe(hydrationsBefore);
		expect(coldMessages(manager.buildSessionContext({ model: gpt }).messages)).toEqual([]);
	});

	// A /resume or /move that fails and rolls back keeps the agent's context; its next rebuild or
	// prune pass must not leave that context's older messages to be read back on every request.
	it("keeps whole the entries a model's context holds after a rollback restores the session's state", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const manager = await open(await writeSession(dir.path(), remoteCompactedSession()));
		cleanups.push(() => manager.close());
		// Claude cannot replay GPT's remote compaction `c2`: its context starts at `c1`'s kept `u1`.
		const behindRemote = ["u1", "c1", "a1", "u2"];
		expect(coldMessages(manager.buildSessionContext({ model: claude }).messages)).toEqual([]);
		expect(behindRemote.filter(id => isColdEntry(entryOf(manager, id)))).toEqual([]);

		manager.restoreState(manager.captureState());
		manager.buildSessionContext();
		expect(behindRemote.filter(id => isColdEntry(entryOf(manager, id)))).toEqual([]);
		manager.recoolEntries();
		expect(behindRemote.filter(id => isColdEntry(entryOf(manager, id)))).toEqual([]);
	});

	// After a switch to another provider whose first rebuild hit a transient read failure, every
	// later request would read the older messages of the new model's context back from the store.
	it("makes the new model's entries whole at the next build after a build that failed to read one", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const manager = await open(await writeSession(dir.path(), remoteCompactedSession()));
		cleanups.push(() => manager.close());
		manager.buildSessionContext({ model: gpt });
		const behindRemote = ["u1", "c1", "a1", "u2"];
		expect(behindRemote.filter(id => !isColdEntry(entryOf(manager, id)))).toEqual([]);

		vi.spyOn(ColdEntryStore.prototype, "parse").mockImplementationOnce(() => {
			throw new Error("EIO: i/o error, read");
		});
		expect(() => manager.buildSessionContext({ model: claude })).toThrow("EIO");
		vi.restoreAllMocks();

		expect(coldMessages(manager.buildSessionContext({ model: claude }).messages)).toEqual([]);
		expect(behindRemote.filter(id => isColdEntry(entryOf(manager, id)))).toEqual([]);
	});

	// A notes-backed rollover re-reads that request on every turn while it is cold.
	it("keeps whole the request a context-rollover compaction recovers from before its kept entries, live and after a resume", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const file = await writeSession(dir.path(), [
			message("u0", null, user(`u0 the request ${BODY}`)),
			message("a0", "u0", assistant(`a0 ${BODY}`)),
			message("a1", "a0", assistant(`a1 ${BODY}`)),
		]);
		const rollover = { details: { kind: "experimental-context-rollover" } };
		const expectedRoles = ["compactionSummary", "user", "assistant", "assistant"] as const;

		const manager = await open(file);
		manager.appendCompaction(`summary ${BODY}`, undefined, "a1", 1000, rollover);
		manager.appendMessage(assistant(`a2 ${BODY}`));
		const live = manager.buildSessionContext().messages;
		expect(live.map(found => found.role)).toEqual([...expectedRoles]);
		expect(coldMessages(live)).toEqual([]);
		expect(isColdEntry(entryOf(manager, "a0"))).toBe(true);
		await manager.flush();
		await manager.close();

		const resumed = await open(file);
		cleanups.push(() => resumed.close());
		const context = resumed.buildSessionContext().messages;
		expect(context.map(found => found.role)).toEqual([...expectedRoles]);
		expect(coldMessages(context)).toEqual([]);
		expect(isColdEntry(entryOf(resumed, "a0"))).toBe(true);
	});

	// The walk that finds a rollover's request passes over the turn's async-result deliveries and peer
	// IRC messages; reading their records back on every context build costs a parse each per turn.
	it("finds a context-rollover compaction's request past cold custom messages without reading them", async () => {
		using dir = TempDir.createSync("@omp-cold-boundary-");
		const customMessage = (id: string, parentId: string | null, customType: string, details: object) => ({
			type: "custom_message",
			id,
			parentId,
			timestamp: TIMESTAMP,
			customType,
			content: `${id} ${BODY}`,
			display: true,
			details,
			attribution: "agent",
		});
		// The parent's IRC message is the request; ten deliveries and peer messages follow it, more than the
		// record cache keeps.
		const entries: object[] = [
			customMessage("p0", null, "irc:incoming", { from: "0-Main", message: `p0 ${BODY}`, fromParent: true }),
		];
		let parentId = "p0";
		for (let index = 0; index < 10; index++) {
			const id = `x${index}`;
			entries.push(
				index % 2 === 0
					? customMessage(id, parentId, "async-result", { job: id, output: `${id} ${BODY}` })
					: customMessage(id, parentId, "irc:incoming", { from: "0-Peer", message: `${id} ${BODY}` }),
			);
			parentId = id;
		}
		entries.push(
			message("k0", parentId, assistant(`k0 ${BODY}`)),
			compaction("c1", "k0", "k0", { details: { kind: "experimental-context-rollover" } }),
			message("a1", "c1", assistant(`a1 ${BODY}`)),
		);
		const manager = await open(await writeSession(dir.path(), entries));
		cleanups.push(() => manager.close());
		expect(isColdEntry(entryOf(manager, "x0"))).toBe(true);
		expect(isColdEntry(entryOf(manager, "x1"))).toBe(true);
		const readsBefore = manager.coldStoreStats().materializations;

		for (let build = 0; build < 3; build++) {
			const context = manager.buildSessionContext().messages;
			expect(context.map(found => found.role)).toEqual(["compactionSummary", "custom", "assistant", "assistant"]);
			expect(JSON.stringify(context[1])).toContain("p0 ");
		}
		expect(manager.coldStoreStats().materializations).toBe(readsBefore);
	});
});
