/**
 * Regression (#17945): the process-global agent registry keeps an earlier
 * session's subagents after `/new` or a session switch, but the Agent Hub
 * roster only lists the current session's tree.
 */
import { SQL } from "bun";
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { copySessionArtifacts } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type SessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { type AgentHubRemote, AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

describe("Agent Hub session scope", () => {
	let dir: string;
	const hubs: AgentHubOverlayComponent[] = [];
	const clients: SQL[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(async () => {
		for (const hub of hubs.splice(0)) hub.dispose();
		AgentRegistry.resetGlobalForTests();
		for (const client of clients.splice(0)) await client.end();
		if (dir) await fs.rm(dir, { recursive: true, force: true });
	});

	/** Session-header JSONL line; a fork copy keeps it, a separately created transcript gets its own. */
	const header = (id: string) =>
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-03T00:00:00.000Z", cwd: "/" })}\n`;

	/**
	 * Render a hub opened on the new session while the registry still holds the old one's tree.
	 * `copied`: idle/aborted refs' transcripts were forked into the new root. `collision`: the new
	 * root holds separately created transcripts under the same agent ids. `storage`: the session's
	 * storage holding every transcript, none of them a file; default: files on disk.
	 */
	async function renderHub(
		options: { remote?: AgentHubRemote; old?: "copied" | "collision"; storage?: SessionStorage } = {},
	): Promise<string> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hub-scope-"));
		const { storage } = options;
		const store = storage ?? new FileSessionStorage();
		const oldRoot = path.join(dir, "old.jsonl");
		const newRoot = path.join(dir, "new.jsonl");
		await store.writeText(oldRoot, "");
		await store.writeText(newRoot, "");
		const registry = new AgentRegistry();
		registry.register({
			id: "OldParked",
			displayName: "OldParked",
			kind: "sub",
			session: null,
			status: "parked",
			sessionFile: path.join(dir, "old", "OldParked.jsonl"),
		});
		registry.register({
			id: "OldNested",
			displayName: "OldNested",
			kind: "sub",
			parentId: "OldParked",
			session: null,
			status: "parked",
			sessionFile: path.join(dir, "old", "OldParked", "OldNested.jsonl"),
		});
		registry.register({
			id: "NewLive",
			displayName: "NewLive",
			kind: "sub",
			session: {} as AgentSession,
			sessionFile: path.join(dir, "new", "NewLive.jsonl"),
		});
		registry.register({ id: "Memory", displayName: "Memory", kind: "sub", session: {} as AgentSession });
		if (options.old) {
			registry.register({
				id: "OldIdle",
				displayName: "OldIdle",
				kind: "sub",
				parentId: "OldParked",
				session: {} as AgentSession,
				status: "idle",
				sessionFile: path.join(dir, "old", "OldParked", "OldIdle.jsonl"),
			});
			registry.register({
				id: "OldAborted",
				displayName: "OldAborted",
				kind: "sub",
				session: null,
				status: "aborted",
				sessionFile: path.join(dir, "old", "OldAborted.jsonl"),
			});
			const files = ["OldParked.jsonl", "OldParked/OldIdle.jsonl", "OldAborted.jsonl"];
			for (const file of files) await store.writeText(path.join(dir, "old", file), header(`old-${file}`));
			if (options.old === "copied") await copySessionArtifacts(oldRoot, newRoot, storage);
			else for (const file of files) await store.writeText(path.join(dir, "new", file), header(`new-${file}`));
		}
		const hub = new AgentHubOverlayComponent({
			...createAgentHubRuntime({
				settings: Settings.isolated(),
				registry,
				remote: options.remote,
				sessionFile: newRoot,
				storage,
			}),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			irc: new IrcBus(registry),
			remote: options.remote,
			sessionFile: newRoot,
		});
		hubs.push(hub);
		await hub.persistedSubagentsReady;
		return Bun.stripANSI(hub.render(120).join("\n"));
	}

	it("hides subagents persisted under a previous session's root", async () => {
		const text = await renderHub();
		expect(text).toContain("NewLive");
		expect(text).toContain("Memory");
		expect(text).not.toContain("OldParked");
		expect(text).not.toContain("OldNested");
	});

	it("keeps the host's full roster for a collab guest", async () => {
		const remote: AgentHubRemote = {
			chat: () => {},
			kill: () => {},
			revive: () => {},
			readTranscript: async () => null,
		};
		const text = await renderHub({ remote });
		for (const id of ["NewLive", "Memory", "OldParked", "OldNested"]) expect(text).toContain(id);
	});

	it("keeps idle and aborted refs when a fork copied their nested and direct transcripts", async () => {
		const text = await renderHub({ old: "copied" });
		expect(text).toContain("OldIdle");
		expect(text).toContain("OldAborted");
		expect(text).toContain("OldParked");
		expect(text).not.toContain("OldNested");
	});

	it("keeps idle and aborted refs a fork copied when only the session's storage holds the transcripts", async () => {
		// Under `session.storage: sql` the transcripts are rows. The fork-copy check must read both header
		// ids through that storage: read from the default (file) storage, it finds no transcript, reports
		// no copy, and the hub hides the idle and aborted agents the fork carried over.
		const client = new SQL("sqlite::memory:");
		clients.push(client);
		const text = await renderHub({ old: "copied", storage: await SqlSessionStorage.create({ client }) });
		for (const root of ["old", "new"]) {
			for (const file of ["OldParked/OldIdle.jsonl", "OldAborted.jsonl"]) {
				expect(await Bun.file(path.join(dir, root, file)).exists()).toBe(false);
			}
		}
		expect(text).toContain("OldIdle");
		expect(text).toContain("OldAborted");
	});

	it("hides idle and aborted refs whose id merely collides with the current session's transcripts", async () => {
		const text = await renderHub({ old: "collision" });
		expect(text).not.toContain("OldIdle");
		expect(text).not.toContain("OldAborted");
	});
});
