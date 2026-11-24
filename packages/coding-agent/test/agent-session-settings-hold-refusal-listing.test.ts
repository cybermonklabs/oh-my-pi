/**
 * A tool a held settings change disables is refused until the rebuild, and both the hidden settings notice and the
 * reason a refused call gets say where the model still finds it: a tool the request declares stays in its tool list;
 * an `xd://` device is never in the tool list, but in the device listing the request carries (the system prompt's
 * catalog and the mount notices); a device neither lists (the kept restored prompt never listed it, and its mount
 * notice waits for the next prompt) is listed nowhere, so neither message may say it stays listed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
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
} from "./helpers/anthropic-gateway";

/** A `--config` overlay a configuration sync rewrites under a running session: one-hour cache entries. */
const LONG_ENTRIES = "providers:\n  cacheRetention: long\n";

/** {@link LONG_ENTRIES} with the extension below disabled. */
const GUARD_DISABLED = `${LONG_ENTRIES}disabledExtensions:\n  - extension-module:guard\n`;

/** A project extension with one tool of its own. */
const GUARD_EXTENSION = `export default function (pi) {
	const { Type } = pi.typebox;
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

/** The heading of the hidden notice of a change in the `xd://` devices. */
const DEVICE_NOTICE = "xd:// device inventory changed.";

/** The settings notice's line for disabled tools a request still lists. */
const STAYS_LISTED = "they stay listed until the rebuild";

/** An MCP tool, which a session mounts as an `xd://` device. */
function mcpTool(name: string): CustomTool {
	return {
		name,
		label: `nucleus/${name}`,
		description: "Searches nucleus.",
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: "nucleus",
		mcpToolName: name,
		async execute() {
			return { content: [{ type: "text", text: "found" }] };
		},
	} as CustomTool;
}

interface ProcessOptions {
	/** The tools the session declares by name; the extension's tool is an `xd://` device unless named. */
	toolNames: string[];
	/** The request answered with a call of the extension's tool, through its device when it is one. */
	callAt?: number;
	/** The extension's tool is a device: the call writes it. */
	viaDevice?: boolean;
}

describe("where the reasons for a held tool refusal say the tool stays listed", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * One process on the session file (a new session without one), with the project's extensions discovered and its
	 * settings loaded from an overlay starting as `initial`: runs `steps` with an `edit` that rewrites the overlay and
	 * waits for the extension reconcile, then exits.
	 */
	async function runProcess(
		dir: TempDir,
		initial: string,
		sessionFile: string | undefined,
		options: ProcessOptions,
		steps: (session: AgentSession, edit: (content: string) => Promise<void>) => Promise<void>,
	): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, initial);
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const { requests, restore } = mockGatewayFetch(turn => {
			if (turn !== options.callAt) return answer(turn, { cacheWriteTokens: 100 });
			return options.viaDevice
				? toolCallAnswer(turn, "write", { path: "xd://guard_audit", content: "{}" }, { cacheWriteTokens: 100 })
				: toolCallAnswer(turn, "guard_audit", {}, { cacheWriteTokens: 100 });
		});
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
			toolNames: options.toolNames,
			contextFiles: [],
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
			restore();
		}
	}

	/**
	 * A process suspended the extension, the held rebuild took its device off the prompt, then it resumed the extension
	 * and the notice told the model the device comes with the rebuild; it exits before that rebuild. Returns the
	 * session file and that process's requests.
	 */
	async function suspendAndResume(dir: TempDir): Promise<{ requests: MessagesRequest[]; sessionFile: string }> {
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(path.join(getProjectAgentDir(dir.path()), "extensions", "guard.ts"), GUARD_EXTENSION);
		setClock(0);
		return runProcess(dir, LONG_ENTRIES, undefined, { toolNames: ["read", "write"] }, async (session, edit) => {
			await session.prompt("first");
			await edit(GUARD_DISABLED);
			setClock(MINUTE_MS);
			await session.prompt("after the suspend");
			setClock(6 * MINUTE_MS);
			await session.prompt("after the rebuild");
			await edit(LONG_ENTRIES);
			setClock(7 * MINUTE_MS);
			await session.prompt("after the resume");
		});
	}

	it("keeps a disabled tool the request declares in its tool list", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-refusal-listing-");
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		await Bun.write(path.join(getProjectAgentDir(dir.path()), "extensions", "guard.ts"), GUARD_EXTENSION);
		setClock(0);
		const { requests } = await runProcess(
			dir,
			LONG_ENTRIES,
			undefined,
			{ toolNames: ["read", "guard_audit"], callAt: 2 },
			async (session, edit) => {
				await session.prompt("first");
				await edit(GUARD_DISABLED);
				setClock(MINUTE_MS);
				await session.prompt("call the audit");
			},
		);

		const [first, suspendTold, withResult] = requests;
		if (!first || !suspendTold || !withResult) throw new Error("Expected three requests");
		// Precondition: the held suspend keeps the tool declared.
		expect(suspendTold.tools?.map(tool => tool.name)).toContain("guard_audit");
		const told = textOf(suspendTold.messages.slice(first.messages.length));
		expect(told).toContain(`${STAYS_LISTED}, and calls to them are refused from now on: \`guard_audit\``);
		const refusal = textOf(toolResultOf(withResult, "toolu_2")?.content);
		expect(refusal).toContain("`guard_audit` is disabled by a settings change");
		expect(refusal).toContain("Its definition stays in your tool list until the prompt is rebuilt");
	}, 60_000);

	it("keeps a disabled device the request's mount notice lists in the device listing, not the tool list", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-refusal-listing-");
		const live = await suspendAndResume(dir);
		// The pod restarts with the extension enabled; a configuration sync then suspends it again.
		setClock(8 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			LONG_ENTRIES,
			live.sessionFile,
			{ toolNames: ["read", "write"], callAt: 1, viaDevice: true },
			async (session, edit) => {
				await edit(GUARD_DISABLED);
				setClock(9 * MINUTE_MS);
				await session.prompt("call the audit");
			},
		);

		const resumeTold = live.requests.at(-1);
		const [suspendTold, withResult] = resumed.requests;
		if (!resumeTold || !suspendTold || !withResult) throw new Error("Expected the two processes' requests");
		const told = textOf(suspendTold.messages.slice(resumeTold.messages.length));
		// Precondition: the request lists the device in its mount notice, and declares no tool of that name.
		expect(told).toContain(DEVICE_NOTICE);
		expect(told).toContain("xd://guard_audit");
		expect(suspendTold.tools?.map(tool => tool.name)).not.toContain("guard_audit");
		expect(told).toContain(`${STAYS_LISTED}, and calls to them are refused from now on: \`guard_audit\``);
		const refusal = textOf(toolResultOf(withResult, "toolu_1")?.content);
		expect(refusal).toContain("`guard_audit` is disabled by a settings change");
		expect(refusal).not.toContain("tool list");
		expect(refusal).toContain("It stays in your `xd://` device listing until the prompt is rebuilt");
	}, 60_000);

	it("says a disabled device the request does not list stays nowhere", async () => {
		using dir = TempDir.createSync("@pi-settings-hold-refusal-listing-");
		const live = await suspendAndResume(dir);
		setClock(8 * MINUTE_MS);
		const resumed = await runProcess(
			dir,
			LONG_ENTRIES,
			live.sessionFile,
			{ toolNames: ["read", "write"], callAt: 1, viaDevice: true },
			async (session, edit) => {
				await edit(GUARD_DISABLED);
				setClock(9 * MINUTE_MS);
				// An MCP server mounts a device while the prompt is prepared, after its mount notice was estimated: that
				// notice waits for the next prompt, so this one lists the extension's device nowhere.
				vi.spyOn(SessionMaintenance.prototype, "runPrePromptCompactionIfNeeded").mockImplementationOnce(
					async () => {
						await session.refreshMCPTools([mcpTool("mcp__nucleus_search")]);
					},
				);
				await session.prompt("call the audit");
			},
		);

		const resumeTold = live.requests.at(-1);
		const [suspendTold, withResult] = resumed.requests;
		if (!resumeTold || !suspendTold || !withResult) throw new Error("Expected the two processes' requests");
		const told = textOf(suspendTold.messages.slice(resumeTold.messages.length));
		// Preconditions: neither the kept prompt nor a mount notice lists the device, and no tool of its name is declared.
		expect(told).not.toContain(DEVICE_NOTICE);
		expect(textOf(suspendTold.system)).not.toContain("guard_audit");
		expect(suspendTold.tools?.map(tool => tool.name)).not.toContain("guard_audit");
		expect(textOf(withResult.messages)).not.toContain(DEVICE_NOTICE);

		expect(told).toContain("calls to them are refused from now on: `guard_audit`");
		expect(told).not.toContain(STAYS_LISTED);
		const refusal = textOf(toolResultOf(withResult, "toolu_1")?.content);
		expect(refusal).toContain("`guard_audit` is disabled by a settings change");
		expect(refusal).not.toContain("tool list");
		expect(refusal).not.toContain("device listing");
	}, 60_000);
});
