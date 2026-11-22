/**
 * A settings edit that suspends an extension under a bound prompt takes each of its tools off the registry one step at
 * a time, and each step is held: the tool stays declared and its calls are refused until the held rebuild. A later
 * step moves only its own tool: it neither brings back a tool an earlier step disabled nor drops one the hold already
 * brings with the rebuild (`learn`, after memory was switched on under the same hold).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	editExtensionSources,
	RELOAD_CALLS,
	reloadOverlay,
	setClock,
} from "./helpers/agent-session-setup";
import {
	answer,
	copiesIn,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** {@link LONG_ENTRIES} with auto-learn on and memory off. */
const MEMORY_OFF = `${LONG_ENTRIES}autolearn:\n  enabled: true\nmemory:\n  backend: off\n`;

/** {@link MEMORY_OFF} under the local memory backend, which offers the `learn` tool. */
const LOCAL_MEMORY = `${LONG_ENTRIES}autolearn:\n  enabled: true\nmemory:\n  backend: local\n`;

/** The overlay entry that disables the extension below. */
const GUARD_DISABLED = "disabledExtensions:\n  - extension-module:guard\n";

/** A project extension that registers its own tools, `names`, in that order. */
function guardExtension(names: readonly string[]): string {
	const tools = names
		.map(
			name => `	pi.registerTool({
		name: ${JSON.stringify(name)},
		label: ${JSON.stringify(name)},
		description: ${JSON.stringify(`The guard's ${name}.`)},
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	});`,
		)
		.join("\n");
	return `export default function (pi) {\n\tconst { Type } = pi.typebox;\n${tools}\n}\n`;
}

/** The line of a settings notice that names the tools whose calls it refuses. */
function refusedLine(text: string): string {
	return text.split("\n").find(line => line.includes("calls to them are refused")) ?? "";
}

const MINUTE_MS = 60_000;

describe("held tool-set steps of one settings change", () => {
	const cleanups: (() => void)[] = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * One session with the project's extensions discovered and its settings loaded from an overlay starting as
	 * `initial`: runs `steps` with an `edit` that rewrites the overlay and waits for the extension reconcile, then exits.
	 * Returns the requests and the tools enabled when `steps` ended.
	 */
	async function runSession(
		dir: TempDir,
		initial: string,
		steps: (
			session: AgentSession,
			edit: (content: string) => Promise<void>,
			overlay: string,
			settings: Settings,
		) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; enabled: string[] }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, initial);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(restore);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(dir),
			disableExtensionDiscovery: false,
			sessionManager: SessionManager.create(dir.path(), dir.join("sessions")),
			authStorage,
			modelRegistry,
			settings,
			model,
			toolNames: ["read"],
			contextFiles: [],
			skills: [],
		});
		const edit = (content: string): Promise<void> => editExtensionSources({ session, settings, overlay }, content);
		try {
			await session.settleMemoryBackend();
			await steps(session, edit, overlay, settings);
			return { requests, enabled: session.getEnabledToolNames() };
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}

	/** A test directory with the gateway's models and the project extension that registers `names`. */
	async function projectWithGuard(names: readonly string[]): Promise<TempDir> {
		const dir = TempDir.createSync("@pi-settings-hold-tool-steps-");
		cleanups.push(() => dir.removeSync());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(path.join(getProjectAgentDir(dir.path()), "extensions", "guard.ts"), guardExtension(names));
		return dir;
	}

	it.each([[["guard_audit", "guard_report"]], [["guard_report", "guard_audit"]]])(
		"refuses every tool of a suspended extension registered as %p",
		async names => {
			const dir = await projectWithGuard(names);
			const { requests } = await runSession(dir, LONG_ENTRIES, async (session, edit) => {
				setClock(0);
				await session.prompt("first");
				await edit(`${LONG_ENTRIES}${GUARD_DISABLED}`);
				setClock(MINUTE_MS);
				await session.prompt("after the edit");
			});

			const [first, second] = requests;
			if (!first || !second) throw new Error("Expected two requests");
			// Precondition: the first request told the model of both tools.
			for (const name of names) expect(copiesIn(first, name)).toBeGreaterThan(0);
			const refused = refusedLine(textOf(second.messages.slice(first.messages.length)));
			for (const name of names) expect(refused).toContain(`\`${name}\``);
		},
		60_000,
	);

	it("keeps `learn` coming with the rebuild through an extension suspended under the same hold", async () => {
		const dir = await projectWithGuard(["guard_audit"]);
		const { requests, enabled } = await runSession(dir, MEMORY_OFF, async (session, edit, overlay, settings) => {
			setClock(0);
			await session.prompt("first");
			await reloadOverlay({ session, settings, overlay }, LOCAL_MEMORY, RELOAD_CALLS);
			await session.settleMemoryBackend();
			setClock(MINUTE_MS);
			await session.prompt("after the switch on");
			await edit(`${LOCAL_MEMORY}${GUARD_DISABLED}`);
			setClock(2 * MINUTE_MS);
			await session.prompt("after the suspend");
			setClock(7 * MINUTE_MS);
			await session.prompt("after the rebuild");
		});

		const [first, onTold, suspendTold, rebuilt] = requests;
		if (!first || !onTold || !suspendTold || !rebuilt) throw new Error("Expected four requests");
		// Preconditions: the switch on was held and told; the suspend was held and told.
		expect(textOf(onTold.messages.slice(first.messages.length))).toContain("available after the rebuild: `learn`");
		const toldAtSuspend = textOf(suspendTold.messages.slice(onTold.messages.length));
		expect(refusedLine(toldAtSuspend)).toContain("`guard_audit`");
		// The suspend moved only the extension's tool: `learn` still comes with the rebuild, and does.
		expect(toldAtSuspend).not.toContain("No longer enabled");
		expect(rebuilt.tools?.map(tool => tool.name)).toContain("learn");
		expect(enabled).toContain("learn");
	}, 60_000);

	it("no longer brings with the rebuild a tool whose extension was resumed and suspended again under the hold", async () => {
		const dir = await projectWithGuard(["guard_audit"]);
		const { requests, enabled } = await runSession(dir, LONG_ENTRIES, async (session, edit) => {
			setClock(0);
			await session.prompt("first");
			// A first hold suspends the extension, and its rebuild takes the tool off.
			await edit(`${LONG_ENTRIES}${GUARD_DISABLED}`);
			setClock(MINUTE_MS);
			await session.prompt("after the suspend");
			setClock(6 * MINUTE_MS);
			await session.prompt("after the first rebuild");
			// A second hold resumes it, so the tool would come with that hold's rebuild, then suspends it again.
			await edit(LONG_ENTRIES);
			setClock(7 * MINUTE_MS);
			await session.prompt("after the resume");
			await edit(`${LONG_ENTRIES}${GUARD_DISABLED}`);
			setClock(8 * MINUTE_MS);
			await session.prompt("after the second suspend");
			setClock(13 * MINUTE_MS);
			await session.prompt("after the second rebuild");
		});

		const [, , rebuiltOnce, resumeTold, suspendTold, rebuiltTwice] = requests;
		if (!rebuiltOnce || !resumeTold || !suspendTold || !rebuiltTwice) throw new Error("Expected six requests");
		// Preconditions: the first rebuild took the tool off; the resume was held, and told the tool comes back.
		expect(copiesIn(rebuiltOnce.system, "guard_audit")).toBe(0);
		expect(textOf(resumeTold.messages.slice(rebuiltOnce.messages.length))).toContain(
			"available after the rebuild: `guard_audit`",
		);
		// The second suspend takes it back: the notice says so, and the rebuild does not bring it.
		expect(textOf(suspendTold.messages.slice(resumeTold.messages.length))).toContain(
			"not available after the rebuild: `guard_audit`",
		);
		expect(copiesIn(rebuiltTwice.system, "guard_audit")).toBe(0);
		expect(enabled).not.toContain("guard_audit");
	}, 60_000);
});
