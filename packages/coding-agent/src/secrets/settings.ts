/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { effect, register } from "../config/registry";
import { setSessionStoreMasking } from "./session-store-mask";

// ────────────────────────────────────────────────────────────────────────
// Providers
// ────────────────────────────────────────────────────────────────────────

// Secret handling
export const cfgSecretsEnabled = register({
	id: "secrets.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Hide Secrets",
		description: "Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers",
	},
});
// Process-wide fallback for requests outside a session; a session's own requests redact per its
// settings (`withCredentialRedaction` in `sdk.ts`), whichever instance holds the effects.
effect(cfgSecretsEnabled, configureCredentialRedaction);

export const cfgSecretsMaskSessionStore = register({
	id: "secrets.maskSessionStore",
	type: "boolean",
	default: false,
	ui: {
		tab: "providers",
		group: "Privacy",
		label: "Mask Secrets in Stored Sessions",
		description:
			"Replace known secret values (secret-named environment variables, files named by *_FILE variables, secrets.yml) with a marker before a session entry is written to the session store",
	},
});
effect(cfgSecretsMaskSessionStore, setSessionStoreMasking);
