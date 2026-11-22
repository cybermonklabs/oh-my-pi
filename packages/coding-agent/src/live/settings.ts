/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register, type ScopeLike } from "../config/registry";
import { DEFAULT_LIVE_VOICE, DEFAULT_OPENAI_LIVE_VOICE, LIVE_VOICE_OPTIONS } from "./voices";

export const LIVE_PROVIDER_VALUES = ["codex", "openai"] as const;

export const cfgLiveProvider = register({
	id: "live.provider",
	type: "enum",
	values: LIVE_PROVIDER_VALUES,
	default: "codex",
	env: "OMP_LIVE_PROVIDER",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Provider",
		description:
			"Where live voice calls go: Codex with the ChatGPT sign-in, or GPT-Live's public API at the openai provider of models.yml (its baseUrl and key)",
		options: [
			{ value: "codex", label: "Codex", description: "ChatGPT (Codex) sign-in" },
			{ value: "openai", label: "OpenAI", description: "GPT-Live through the openai provider in models.yml" },
		],
	},
});

export const cfgLiveModel = register({
	id: "live.model",
	type: "string",
	default: "gpt-live-1.1",
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Model",
		description: "GPT-Live model of live voice calls on the openai provider (live.provider: openai)",
	},
});

export const cfgLiveVoice = register({
	id: "live.voice",
	type: "string",
	default: DEFAULT_LIVE_VOICE,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Voice",
		description:
			"Voice of realtime voice sessions; unset uses sol on Codex and marin on the openai provider, which (like a custom live endpoint) takes other names (set in config)",
		options: LIVE_VOICE_OPTIONS,
	},
});

function validateLiveEndpoint(raw: unknown): void {
	if (typeof raw !== "string" || !raw.trim()) return;
	let protocol: string;
	try {
		protocol = new URL(raw.trim()).protocol;
	} catch {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(`live.endpoint must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}
}

export const cfgLiveEndpoint = register({
	id: "live.endpoint",
	type: "string",
	default: undefined,
	validate: validateLiveEndpoint,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Endpoint",
		description:
			"Base URL of an OpenAI Realtime WebRTC-compatible server (e.g. http://127.0.0.1:8080/v1) used for live voice instead of Codex; empty uses Codex",
	},
});

export const cfgLiveApiKey = register({
	id: "live.apiKey",
	type: "string",
	default: undefined,
	credential: true,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Endpoint API Key",
		description: "Bearer key sent only to the live endpoint: a literal, an environment variable name, or !command",
	},
});

export const cfgLivePulseServer = register({
	id: "live.pulseServer",
	type: "string",
	default: undefined,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live PulseAudio Server",
		description:
			"PulseAudio server for the live call's microphone and speaker (e.g. tcp:127.0.0.1:4713), with buffers sized for a network round trip; when set, a call never falls back to ALSA",
	},
});

export const cfgLiveInstructionsFile = register({
	id: "live.instructionsFile",
	type: "string",
	default: undefined,
	ui: {
		tab: "providers",
		group: "Services",
		label: "Live Instructions File",
		description: "File whose text is appended to the voice model's instructions at the start of each live call",
	},
});

/**
 * The voice a live session uses: an explicit choice, else the `live.voice` setting where one is
 * configured, else the provider's default (`sol` on Codex, `marin` on the openai provider).
 */
export function resolveLiveVoice(scope: ScopeLike, voice?: string): string {
	const explicit = voice?.trim() || (cfgLiveVoice.isConfigured(scope) ? cfgLiveVoice.get(scope).trim() : "");
	if (explicit) return explicit;
	return cfgLiveProvider.get(scope) === "openai" ? DEFAULT_OPENAI_LIVE_VOICE : DEFAULT_LIVE_VOICE;
}
