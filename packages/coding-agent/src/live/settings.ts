/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { DEFAULT_LIVE_VOICE, LIVE_VOICE_OPTIONS, LIVE_VOICE_VALUES } from "./voices";

export const cfgLiveProvider = register({
	id: "live.provider",
	type: "enum",
	values: ["codex", "openai"] as const,
	default: "codex",
	env: "OMP_LIVE_PROVIDER",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Provider",
		description:
			"Where realtime voice calls go: Codex on the ChatGPT subscription, or GPT-Live on OpenAI's API, billed to the openai provider's key",
		options: [
			{ value: "codex", label: "Codex", description: "ChatGPT (Codex) subscription" },
			{ value: "openai", label: "OpenAI API", description: "GPT-Live with the openai provider's base URL and key" },
		],
	},
});

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "enum",
	values: LIVE_VOICE_VALUES,
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice",
		description: "Voice used by Codex-backed realtime voice sessions",
		options: LIVE_VOICE_OPTIONS,
	},
});

/**
 * The voice a live session sends: an explicit choice, else the `live.voice` setting, else the default.
 * None on GPT-Live's API (`live.provider: openai`), which gets no voice from omp and uses its own.
 */
export function resolveLiveVoice(scope: ScopeLike, voice?: string): string | undefined {
	if (cfgLiveProvider.get(scope) === "openai") return undefined;
	return voice?.trim() || cfgLiveVoice.get(scope) || DEFAULT_LIVE_VOICE;
}
