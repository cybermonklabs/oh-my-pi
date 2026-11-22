/** Voices Codex-backed realtime sessions accept, offered as `live.voice` suggestions. */
export const LIVE_VOICE_OPTIONS = [
	{ value: "arbor", label: "Arbor" },
	{ value: "breeze", label: "Breeze" },
	{ value: "cove", label: "Cove" },
	{ value: "ember", label: "Ember" },
	{ value: "juniper", label: "Juniper" },
	{ value: "maple", label: "Maple" },
	{ value: "sol", label: "Sol" },
	{ value: "spruce", label: "Spruce" },
	{ value: "vale", label: "Vale" },
] as const;

/** Voice used on Codex when no live voice preference is configured. */
export const DEFAULT_LIVE_VOICE = "sol";

/** OpenAI's default GPT-Live voice, used on the openai provider when no voice is configured. */
export const DEFAULT_OPENAI_LIVE_VOICE = "marin";
