import { type PauseWorkStatus, runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { clearApprovalGrants } from "../tools/approval-cache";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { LiveCallStatus, SlashCommandLiveHost, SlashCommandRuntime, SlashCommandSpec } from "./types";

/** A call's provider and, where it has one, its voice (GPT-Live's API gets none from omp). */
function describeLiveSource(provider: string | undefined, voice: string | undefined): string {
	const parts = [provider, voice === undefined ? undefined : `voice ${voice}`].filter(part => part !== undefined);
	return parts.join(", ");
}

/** `/live status` in one line. */
function describeLiveCall(status: LiveCallStatus): string {
	if (status.state === "off") return "No live call is open.";
	const microphone = status.muted ? "muted" : "on";
	return `Live call ${status.state} since ${status.since.toISOString()}: ${describeLiveSource(status.provider, status.voice)}, microphone ${microphone}.`;
}

/**
 * Starts the host's live call and says in one line how the start ended. An abort of `signal` (RPC's
 * `abort`, or the client going away) while the call connects stops it.
 */
async function startLiveCall(
	live: SlashCommandLiveHost,
	signal: AbortSignal | undefined,
): Promise<{ line: string; failed: boolean }> {
	const stop = (): void => {
		void live.stop();
	};
	signal?.addEventListener("abort", stop, { once: true });
	try {
		const { voice } = await live.start();
		const started = live.status();
		const source = describeLiveSource(started.state === "off" ? undefined : started.provider, voice);
		return { line: source ? `Live call open: ${source}.` : "Live call open.", failed: false };
	} catch (error) {
		return { line: `Live call did not start: ${errorMessage(error)}`, failed: true };
	} finally {
		signal?.removeEventListener("abort", stop);
	}
}

/**
 * `/live on|off|status` outside the terminal: drives the host's live call (RPC mode's live bridge) and
 * answers in one line, which a chat bridge posts back. A bare `/live` reports status.
 */
async function handleLiveText(args: string, runtime: SlashCommandRuntime) {
	const live = runtime.live;
	if (!live) {
		return usage("Live voice is not available here: only RPC mode and the interactive terminal run /live.", runtime);
	}
	const verb = args.trim().toLowerCase() || "status";
	const status = live.status();
	switch (verb) {
		case "on": {
			if (status.state !== "off") {
				await runtime.output(`A live call is already ${status.state} (since ${status.since.toISOString()}).`);
				return commandConsumed();
			}
			// The connect can take a minute (the session request, the media channel, the sideband's
			// attempts). An RPC `prompt` runs it in the background, so its input queue stays free for
			// `/live off`, `/live status` and `abort`, and the answer comes when the start ends.
			if (runtime.runCommandInBackground) {
				const signal = runtime.signal;
				runtime.runCommandInBackground(async () => {
					await runtime.output((await startLiveCall(live, signal)).line);
				});
				return commandConsumed();
			}
			const started = await startLiveCall(live, runtime.signal);
			if (started.failed) return usage(started.line, runtime);
			await runtime.output(started.line);
			return commandConsumed();
		}
		case "off":
			if (status.state === "off") {
				await runtime.output("No live call is open.");
				return commandConsumed();
			}
			await live.stop();
			await runtime.output("Live call ended.");
			return commandConsumed();
		case "status":
			await runtime.output(describeLiveCall(status));
			return commandConsumed();
		default:
			return usage("Usage: /live [on|off|status]", runtime);
	}
}

/** Advisors with review work they can still run (not parked, yielded, or quota-paused). */
function advisorUnsettledCount(session: AgentSessionHandle): number {
	return session
		.getAdvisorStatusOverview()
		.advisors.filter(advisor => advisor.backlog > 0 && !advisor.isPaused && !advisor.yielded).length;
}

/**
 * Outstanding work for the `/pause` screen. A subagent counts as a turn only
 * while its session streams and is not parked; its task job is deduplicated
 * against that same live set, so a pre-live or stale `running` ref still
 * counts through its job. Advisors of the root and every live subagent count.
 */
function pauseWorkStatus(root: AgentSession): PauseWorkStatus {
	const registry = AgentRegistry.global();
	const liveSubagents = registry.list().filter(ref => ref.kind === "sub" && registry.isRunning(ref));
	const liveSubagentIds = new Set(liveSubagents.map(ref => ref.id));
	let unsettledTurns = Number(root.isStreaming && !root.agent.isPaused) + advisorUnsettledCount(root);
	for (const ref of liveSubagents) {
		if (!ref.session) continue;
		if (!ref.session.agent.isPaused) unsettledTurns++;
		unsettledTurns += advisorUnsettledCount(ref.session);
	}
	const unfinishedJobs =
		root
			.getAsyncJobTree({ recentLimit: 0 })
			?.running.filter(job => job.type !== "task" || job.agentId === undefined || !liveSubagentIds.has(job.agentId))
			.length ?? 0;
	return { unsettledTurns, unfinishedJobs };
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Realtime voice mode: the terminal's /live opens it; on, off or status where a host runs calls",
		acpInputHint: "on|off|status",
		// ACP runs no live call and answers /live as not available, so it is not offered there.
		acpHidden: true,
		handle: (command, runtime) => handleLiveText(command.args, runtime),
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			const ctx = runtime.ctx;
			await runPauseScreen(ctx, { getWorkStatus: () => pauseWorkStatus(ctx.session) });
		},
	},
	{
		name: "forget-approvals",
		icon: "trash",
		description: "Forget every file and folder approval Ask and remember has recorded",
		handle: async (_command, runtime) => {
			clearApprovalGrants(runtime.settings.getAgentDir());
			await runtime.output("Remembered approvals forgotten; the next read or write asks again.");
			return commandConsumed();
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
