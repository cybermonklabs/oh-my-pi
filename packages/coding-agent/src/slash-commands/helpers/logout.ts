import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { type DisabledCredentialSummary, isRecoverableDisabledCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { logger } from "@oh-my-pi/pi-utils";
import { hasActiveAccount, toAccountIdentity } from "./usage-accounts";
import type { AgentSession } from "../../session/agent-session";
import type { AuthStorage, OAuthAccountIdentity, StoredAuthCredential } from "../../session/auth-storage";

import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";

interface LogoutAccountOptions {
	activeIdentity?: OAuthAccountIdentity;
	activeApiKey?: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function oauthLabel(credential: OAuthAccountIdentity & { enterpriseUrl?: string }, fallback: string): string {
	const base =
		nonEmpty(credential.email) ??
		nonEmpty(credential.accountId) ??
		nonEmpty(credential.projectId) ??
		nonEmpty(credential.enterpriseUrl) ??
		fallback;
	// Two subscriptions (orgs) can share one email — the org is the only
	// user-visible way to tell which row a logout will remove.
	const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
	return org && org !== base ? `${base} (${org})` : base;
}

function oauthDetail(row: StoredAuthCredential, label: string): string {
	const credential = row.credential;
	if (credential.type === "api_key") return `stored API key #${row.id}`;
	const parts: string[] = [];
	const email = nonEmpty(credential.email);
	const accountId = nonEmpty(credential.accountId);
	const projectId = nonEmpty(credential.projectId);
	const enterpriseUrl = nonEmpty(credential.enterpriseUrl);
	if (email && email !== label) parts.push(email);
	if (accountId && accountId !== label) parts.push(`account ${accountId}`);
	if (projectId && projectId !== label) parts.push(`project ${projectId}`);
	if (enterpriseUrl && enterpriseUrl !== label) parts.push(enterpriseUrl);
	parts.push(`oauth #${row.id}`);
	return parts.join(" · ");
}

function oauthMatchesActiveIdentity(
	row: StoredAuthCredential,
	activeIdentity: OAuthAccountIdentity | undefined,
): boolean {
	if (!activeIdentity || row.credential.type !== "oauth") return false;
	const credential = row.credential;
	// The org GATES the base identity rather than replacing it: mismatched org
	// presence or different orgs never match — an org-scoped active session
	// must not preselect the bare-email legacy row, and a bare-email active
	// row must not mark org-scoped siblings active via the shared email. A
	// SHARED org still requires the base-identity match below: two Team seats
	// share one orgId yet own distinct rows. Only an org-only active identity
	// (no base identifiers recovered at all) matches on the org alone.
	if (activeIdentity.orgId !== undefined || credential.orgId !== undefined) {
		if (credential.orgId !== activeIdentity.orgId) return false;
		if (
			activeIdentity.accountId === undefined &&
			activeIdentity.email === undefined &&
			activeIdentity.projectId === undefined
		) {
			return true;
		}
	}
	// When both sides carry an email it decides: Codex Team seats share an
	// account id and Antigravity accounts share one Google project.
	if (activeIdentity.email !== undefined && credential.email !== undefined) {
		return credential.email === activeIdentity.email;
	}
	return (
		(activeIdentity.accountId !== undefined && credential.accountId === activeIdentity.accountId) ||
		(activeIdentity.projectId !== undefined && credential.projectId === activeIdentity.projectId)
	);
}

export function toLogoutAccounts(
	provider: string,
	credentials: StoredAuthCredential[],
	options: LogoutAccountOptions = {},
): LogoutAccount[] {
	return credentials
		.map(row => {
			const label =
				row.credential.type === "oauth"
					? oauthLabel(row.credential, `OAuth credential #${row.id}`)
					: `API key #${row.id}`;
			const active =
				row.credential.type === "oauth"
					? oauthMatchesActiveIdentity(row, options.activeIdentity)
					: options.activeApiKey === true;
			return {
				credentialId: row.id,
				provider,
				label,
				detail: oauthDetail(row, label),
				type: row.credential.type,
				active,
			} satisfies LogoutAccount;
		})
		.sort((left, right) => {
			if (left.active !== right.active) return left.active ? -1 : 1;
			return left.label.localeCompare(right.label) || left.credentialId - right.credentialId;
		});
}

/** A credential store's tombstone listing, for one provider or for every provider. */
export type DisabledCredentialLister = (provider?: string) => Promise<DisabledCredentialSummary[]>;

/**
 * Tombstones of logins a new login would restore ({@link isRecoverableDisabledCredential}).
 * A lookup the store cannot answer — through an auth broker it is a request — logs and
 * yields none, so a listing still offers the logins the store holds either way.
 */
async function recoverableTombstones(
	listDisabled: DisabledCredentialLister,
	provider?: string,
): Promise<DisabledCredentialSummary[]> {
	let tombstones: DisabledCredentialSummary[];
	try {
		tombstones = await listDisabled(provider);
	} catch (error) {
		logger.warn("Disabled credential lookup failed; logout lists the active logins only", {
			provider,
			error: String(error),
		});
		return [];
	}
	return tombstones.filter(summary => isRecoverableDisabledCredential(summary, tombstones));
}

/** Stored accounts `/logout` can remove, including recoverable failure-disabled logins. */
export async function listLogoutAccounts(
	authStorage: AuthStorage,
	loginProvider: string,
	sessionId: string,
): Promise<LogoutAccount[]> {
	const provider = getOAuthCredentialProvider(loginProvider);
	await authStorage.credentials.reload();
	const rows = authStorage.credentials.list(provider);
	const accounts = toLogoutAccounts(provider, rows, {
		activeIdentity: authStorage.oauth.identity(provider, sessionId),
		activeApiKey: authStorage.keys.source(provider)?.kind === "api_key",
	});
	const tombstones = await recoverableTombstones(scope => authStorage.credentials.listDisabled(scope), provider);
	if (tombstones.length === 0) return accounts;
	const active = rows.map(row => toAccountIdentity(provider, row.credential));
	for (const summary of tombstones) {
		// The user logged this account in again: one row to remove, not an active and a disabled one.
		if (hasActiveAccount(summary, active)) continue;
		accounts.push({
			credentialId: summary.id,
			provider,
			label: `${oauthLabel(summary, `OAuth credential #${summary.id}`)} (disabled)`,
			detail: `disabled · oauth #${summary.id}`,
			type: summary.type,
			active: false,
		});
	}
	return accounts;
}

/** Providers with active credentials or recoverable failure-disabled logins to remove. */
export async function listLogoutProviders(authStorage: AuthStorage): Promise<ReadonlySet<string>> {
	await authStorage.credentials.reload();
	return collectLogoutProviders(
		authStorage.credentials.list().map(row => row.provider),
		scope => authStorage.credentials.listDisabled(scope),
	);
}

/**
 * Providers a logout can still remove a login from: those with an active credential, and
 * those whose only logins a failure disabled — removing one of those retires the tombstone
 * that keeps a turn retrying the provider's key. `omp auth-broker logout` offers the same
 * providers, reading its own store.
 */
export async function collectLogoutProviders(
	activeProviders: Iterable<string>,
	listDisabled: DisabledCredentialLister,
): Promise<ReadonlySet<string>> {
	const providers = new Set(activeProviders);
	for (const summary of await recoverableTombstones(listDisabled)) providers.add(summary.provider);
	return providers;
}

/**
 * Removes one stored credential and refreshes the provider's models.
 * `removed: false` means the credential was already gone; `remainingSource`
 * names the auth source that still authenticates the provider, if any.
 */
export async function logoutCredential(
	session: Pick<AgentSession, "modelRegistry" | "sessionId" | "refreshScopedModels">,
	loginProvider: string,
	credentialId: number,
): Promise<{ removed: boolean; remainingSource?: string }> {
	const provider = getOAuthCredentialProvider(loginProvider);
	const modelRegistry = session.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	// Reload so an id stored by another process is found, not reported missing.
	await authStorage.credentials.reload();
	if (!(await authStorage.credentials.removeById(provider, credentialId))) return { removed: false };
	// Provider-scoped online refresh so the removed credential's stale
	// endpoint/deployment models are invalidated deterministically; the
	// default all-provider `online-if-uncached` would reuse the fresh
	// authoritative cache row and keep showing models the credential
	// unlocked (#5780). Other providers are left untouched.
	await modelRegistry.refreshProvider(provider, "online");
	await session.refreshScopedModels();
	return { removed: true, remainingSource: authStorage.keys.describe(provider, session.sessionId) };
}
