import { $flag } from "@oh-my-pi/pi-utils";
import type { Model } from "../types";

/** Whether Claude Code's `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` applies to this model's provider. */
export function experimentalBetasDisabled(model: Model<"anthropic-messages">): boolean {
	return model.compat.honorsClaudeCodeBetaKillSwitch === true && $flag("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS");
}

/**
 * Honor Claude Code's `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` kill switch on
 * providers whose compat opts in (`honors-claude-code-beta-kill-switch`).
 * Gateways behind `ANTHROPIC_BASE_URL` often reject pre-release body fields,
 * so the switch withholds what Claude Code's gateway contract lists — context
 * management, beta tool fields (`strict`, `defer_loading`,
 * `eager_input_streaming`), tool search (mid-conversation tool changes),
 * structured-output format, task budgets — plus `thinking.block_binding` and
 * server compaction (whose legacy replay needs a `context_management` edit),
 * together with their betas. Effort, adaptive thinking, interleaved thinking
 * and extended context stay, as in Claude Code. Applied through compat so every
 * request builder and retry rung sees one decision, and a caller that mirrors
 * the request (the agent's tool fingerprint) reads the same compat; the
 * provider's body and beta sanitizers cover the rest where bodies and betas are
 * finalized.
 */
export function withoutDisabledExperimentalBetas(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	if (!experimentalBetasDisabled(model)) return model;
	return {
		...model,
		compat: {
			...model.compat,
			supportsContextManagement: false,
			supportsThinkingBindingControls: false,
			supportsServerCompaction: false,
			supportsMessageThreads: false,
			disableStrictTools: true,
			supportsEagerToolInputStreaming: false,
			supportsMidConversationToolChanges: false,
		},
	};
}
