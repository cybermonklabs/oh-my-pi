/**
 * Test helper for resolving API keys from ~/.omp/agent/testauth.db
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to testauth.db.
 *
 * E2E tests are disabled by default. Set E2E=1 environment variable to enable.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthCredentials, OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { $flag, getAgentDir, getConfigRootDir, isEnoent, parseEnvFile } from "@oh-my-pi/pi-utils";

/**
 * E2E tests require explicit opt-in via E2E=1 environment variable.
 * This prevents accidental API calls when keys happen to be in the environment.
 */
const E2E_ENABLED = $flag("E2E");

/**
 * The developer's own dotenv files, in the loader's order (`docs/environment-variables.md`): the
 * agent dir's `.env`, then the config root's, then `~/.env`, the first to set a name winning. A test
 * process does not load them (`packages/utils/src/env.ts`); an E2E run reads its keys from them here.
 */
let developerDotenv: Record<string, string> | undefined;

/**
 * Get an API key, but only if E2E tests are enabled: from the environment, else from the developer's
 * dotenv files, where omp itself would find it. A key found in a file is also set in `Bun.env`, as
 * omp's loader would set it, so the provider code under test reads the same key.
 * Use this in skipIf conditions: `describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))(...)`
 */
export function e2eApiKey(envVar: string): string | undefined {
	if (!E2E_ENABLED) return undefined;
	if (Bun.env[envVar]) return Bun.env[envVar];
	const files: Record<string, string> = (developerDotenv ??= Object.assign(
		{},
		...[os.homedir(), getConfigRootDir(), getAgentDir()].map(dir => parseEnvFile(path.join(dir, ".env"))),
	));
	const value = files[envVar];
	if (value) Bun.env[envVar] = value;
	return value || undefined;
}

const AUTH_PATH = path.join(getAgentDir(), "testauth.db");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

async function loadAuthStorage(): Promise<AuthStorage> {
	try {
		const content = await Bun.file(AUTH_PATH).text();
		return JSON.parse(content);
	} catch (err) {
		if (isEnoent(err)) return {};
		throw err;
	}
}

async function saveAuthStorage(storage: AuthStorage): Promise<void> {
	await Bun.write(AUTH_PATH, JSON.stringify(storage, null, 2));
	await fs.chmod(AUTH_PATH, 0o600);
}

/**
 * Resolve API key for a provider from ~/.omp/agent/testauth.db
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 * For google-gemini-cli and google-antigravity, returns JSON-encoded { token, projectId }
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	if (!E2E_ENABLED) return undefined;

	const storage = await loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		// Build OAuthCredentials record for getOAuthApiKey
		const oauthCredentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(storage)) {
			if (value.type === "oauth") {
				const { type: _, ...creds } = value;
				oauthCredentials[key] = creds;
			}
		}

		const result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
		if (!result) return undefined;

		// Save refreshed credentials back to testauth.db
		storage[provider] = { type: "oauth", ...result.newCredentials };
		await saveAuthStorage(storage);

		return result.apiKey;
	}

	return undefined;
}
