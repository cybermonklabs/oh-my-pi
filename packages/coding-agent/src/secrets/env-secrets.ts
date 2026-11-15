/** Minimum env var value length to consider as a secret. */
export const MIN_ENV_VALUE_LENGTH = 8;

/** Env var name patterns that indicate secret values. */
const SECRET_ENV_PATTERNS = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

/** Variables that hold configuration rather than secrets, though `GIT_CONFIG_KEY_<n>` and `SSH_ASKPASS` match the name rule. */
const NON_SECRET_ENV_NAMES = /^(?:GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|SSH_ASKPASS)$/;

/** Extracts the password group from a connection URL that carries a user and password before its host. */
const CONNECTION_URL_PASSWORD_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/:@?#\s]*:([^/?#\s]+)@/i;

/** A secret-looking environment value and the variable that holds it. */
export interface EnvSecretValue {
	name: string;
	value: string;
}

/**
 * The password of a connection-URL value and its percent-decoded form, each
 * only when at least {@link MIN_ENV_VALUE_LENGTH} characters long.
 */
export function connectionUrlPasswords(value: string): string[] {
	const match = CONNECTION_URL_PASSWORD_RE.exec(value);
	if (!match) return [];
	const password = match[1];
	const passwords: string[] = [];
	if (password.length >= MIN_ENV_VALUE_LENGTH) passwords.push(password);
	try {
		const decoded = decodeURIComponent(password);
		if (decoded !== password && decoded.length >= MIN_ENV_VALUE_LENGTH) passwords.push(decoded);
	} catch {
		// Malformed percent-encoding — only the raw password applies.
	}
	return passwords;
}

/** Collect environment values that look like secrets, deduplicated by value (the first variable wins). */
export function collectEnvSecretValues(env: Readonly<Record<string, string | undefined>>): EnvSecretValue[] {
	const values: EnvSecretValue[] = [];
	const seen = new Set<string>();
	const add = (name: string, value: string): void => {
		if (seen.has(value)) return;
		seen.add(value);
		values.push({ name, value });
	};
	const candidates = Object.entries(env).filter(([name]) => !NON_SECRET_ENV_NAMES.test(name));
	for (const [name, value] of candidates) {
		if (value && value.length >= MIN_ENV_VALUE_LENGTH && SECRET_ENV_PATTERNS.test(name)) add(name, value);
	}
	// Second pass: extract passwords embedded in connection-URL values,
	// regardless of the variable name.
	for (const [name, value] of candidates) {
		if (!value) continue;
		for (const password of connectionUrlPasswords(value)) add(name, password);
	}
	return values;
}
