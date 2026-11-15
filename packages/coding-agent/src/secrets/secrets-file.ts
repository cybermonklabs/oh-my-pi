import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import type { SecretEntry } from "./obfuscator";
import { sanitizeSecretFriendlyName } from "./placeholder";
import { compileSecretRegex } from "./regex";
import { regexHasUnresolvableShortMatchFallback } from "./replacement";

/** A valid secrets.yml entry and its 1-based position in the file's YAML array. */
export interface PositionedSecretEntry {
	entry: SecretEntry;
	position: number;
}

type RawSecretEntry = Omit<SecretEntry, "friendlyName"> & { friendlyName?: unknown };

/** The project-local secrets.yml of `cwd`. */
export function projectSecretsFilePath(cwd: string): string {
	return path.join(cwd, ".omp", "secrets.yml");
}

/** The global secrets.yml under `agentDir`. */
export function globalSecretsFilePath(agentDir: string): string {
	return path.join(agentDir, "secrets.yml");
}

/** Read one secrets.yml; a missing file, a file that is not a YAML array, and invalid entries yield nothing. */
export async function loadSecretsFile(filePath: string): Promise<SecretEntry[]> {
	try {
		return parseSecretsFile(await Bun.file(filePath).text(), filePath).map(({ entry }) => entry);
	} catch (err) {
		return secretsFileFailure(err, filePath);
	}
}

/** Synchronous {@link loadSecretsFile} that keeps each entry's position. */
export function loadSecretsFileSync(filePath: string): PositionedSecretEntry[] {
	try {
		return parseSecretsFile(fs.readFileSync(filePath, "utf8"), filePath);
	} catch (err) {
		return secretsFileFailure(err, filePath);
	}
}

function secretsFileFailure(err: unknown, filePath: string): [] {
	if (!isEnoent(err)) logger.warn("Failed to load secrets.yml", { path: filePath, error: String(err) });
	return [];
}

function parseSecretsFile(text: string, filePath: string): PositionedSecretEntry[] {
	const raw = YAML.parse(text);
	if (!Array.isArray(raw)) {
		logger.warn("secrets.yml must be a YAML array", { path: filePath });
		return [];
	}
	const entries: PositionedSecretEntry[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (!validateEntry(entry, filePath, i)) continue;
		const friendlyName = loadFriendlyName(entry, filePath, i);
		entries.push({
			entry: {
				type: entry.type,
				content: entry.content,
				mode: entry.mode ?? "obfuscate",
				replacement: entry.replacement,
				flags: entry.flags,
				friendlyName,
			},
			position: i + 1,
		});
	}
	return entries;
}

// Validates the friendlyName but returns it UNSANITIZED: `SecretObfuscator`'s
// own `#createPlaceholder` sanitizes it again and, critically, needs the raw
// string for `#friendlyNameCollidesWithSecret`'s regex-collision check — a
// case-sensitive/punctuated regex pattern (e.g. `tok_[a-z0-9]+`) only matches
// the label as it was actually written, not an already-uppercased,
// separator-stripped rendering of it. Pre-sanitizing here would silently
// defeat that check for every `secrets.yml`-loaded entry.
function loadFriendlyName(entry: RawSecretEntry, filePath: string, index: number): string | undefined {
	if (entry.friendlyName === undefined) return undefined;
	if (typeof entry.friendlyName !== "string") {
		logger.warn(`secrets.yml[${index}]: friendlyName must be a string`, { path: filePath });
		return undefined;
	}
	if (sanitizeSecretFriendlyName(entry.friendlyName) === undefined) {
		logger.warn(`secrets.yml[${index}]: friendlyName must contain at least one letter or digit`, { path: filePath });
		return undefined;
	}
	return entry.friendlyName;
}

function validateEntry(entry: unknown, filePath: string, index: number): entry is RawSecretEntry {
	if (entry === null || typeof entry !== "object") {
		logger.warn(`secrets.yml[${index}]: entry must be an object`, { path: filePath });
		return false;
	}
	const e = entry as Record<string, unknown>;
	if (e.type !== "plain" && e.type !== "regex") {
		logger.warn(`secrets.yml[${index}]: type must be "plain" or "regex"`, { path: filePath });
		return false;
	}
	if (typeof e.content !== "string" || e.content.length === 0) {
		logger.warn(`secrets.yml[${index}]: content must be a non-empty string`, { path: filePath });
		return false;
	}
	if (e.mode !== undefined && e.mode !== "obfuscate" && e.mode !== "replace") {
		logger.warn(`secrets.yml[${index}]: mode must be "obfuscate" or "replace"`, { path: filePath });
		return false;
	}
	if (e.replacement !== undefined && typeof e.replacement !== "string") {
		logger.warn(`secrets.yml[${index}]: replacement must be a string`, { path: filePath });
		return false;
	}
	if (e.flags !== undefined && typeof e.flags !== "string") {
		logger.warn(`secrets.yml[${index}]: flags must be a string`, { path: filePath });
		return false;
	}
	if (e.type === "regex") {
		let regex: RegExp;
		try {
			regex = compileSecretRegex(e.content as string, e.flags as string | undefined);
		} catch (error) {
			logger.warn(`secrets.yml[${index}]: invalid regex pattern`, {
				path: filePath,
				pattern: e.content,
				error: String(error),
			});
			return false;
		}
		const mode = (e.mode as "obfuscate" | "replace" | undefined) ?? "obfuscate";
		if (mode === "replace" && e.replacement === undefined && regexHasUnresolvableShortMatchFallback(regex)) {
			logger.warn(
				`secrets.yml[${index}]: regex matches every 1-2 character candidate with no custom replacement, so a match can never be redacted distinctly from itself`,
				{ path: filePath, pattern: e.content },
			);
			return false;
		}
	}
	return true;
}
