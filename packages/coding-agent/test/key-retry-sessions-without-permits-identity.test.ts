/**
 * A custom `SessionsApi` may lack `permitsIdentity`. A turn's key retry then cannot tell which disabled logins the
 * account pool of a restricted session holds: it waits for none of them in that session, and says so once in a
 * warning, while an unrestricted session still waits for one.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	AuthStorage,
	type AuthStorageBackend,
	resolveCredentialIdentityKey,
	type SessionsApi,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `local` behind a sessions API that an SDK host wrote before `permitsIdentity` existed. */
function withSessionsWithoutPermitsIdentity(local: AuthStorage): AuthStorage {
	const sessions: SessionsApi = {
		pin: (provider, sessionId, credentialId, options) =>
			local.sessions.pin(provider, sessionId, credentialId, options),
		inherit: (source, target, include) => local.sessions.inherit(source, target, include),
		restrict: (provider, sessionId, identityKeys) => local.sessions.restrict(provider, sessionId, identityKeys),
		unrestrict: (provider, sessionId, lease) => local.sessions.unrestrict(provider, sessionId, lease),
		permits: (provider, sessionId, credentialId) => local.sessions.permits(provider, sessionId, credentialId),
		release: (provider, sessionId) => local.sessions.release(provider, sessionId),
	};
	const backend: AuthStorageBackend = {
		get credentials() {
			return local.credentials;
		},
		get keys() {
			return local.keys;
		},
		get oauth() {
			return local.oauth;
		},
		sessions,
		get usage() {
			return local.usage;
		},
		get health() {
			return local.health;
		},
		get limits() {
			return local.limits;
		},
		get resets() {
			return local.resets;
		},
		get blocks() {
			return local.blocks;
		},
		setAccountPolicies: config => local.setAccountPolicies(config),
		replaceStore: (store, options) => local.replaceStore(store, options),
		close: () => local.close(),
	};
	return new AuthStorage(backend);
}

/**
 * A registry over that sessions API and a store whose only anthropic login, account A, a refresh failure disabled.
 * Session `pooled` is restricted to an account pool of account A; session `free` is not restricted.
 */
async function openRegistry() {
	const temp = await TempDir.create("@key-retry-sessions-without-permits-identity-");
	cleanups.push(() => temp.remove());
	const local = new AuthStorage(await SqliteAuthCredentialStore.open(temp.join("auth.db")));
	cleanups.push(() => local.close());
	const login = {
		type: "oauth" as const,
		access: "access-a",
		refresh: "refresh-a",
		expires: Date.now() + 60_000,
		email: "a@example.test",
	};
	await local.credentials.set("anthropic", [login]);
	await local.credentials.disable(local.credentials.list("anthropic")[0]!.id, "oauth refresh failed: invalid_grant");
	const authStorage = withSessionsWithoutPermitsIdentity(local);
	const accountA = resolveCredentialIdentityKey("anthropic", login);
	if (!accountA) throw new Error("Expected account A's identity key");
	authStorage.sessions.restrict("anthropic", "pooled", [accountA]);
	return new ModelRegistry(authStorage, temp.join("models.yml"));
}

/** Silences `logger.warn`; the function it returns reads the warnings that a pool's disabled logins are unreadable. */
function captureUnreadablePoolWarnings() {
	const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
	return () => warn.mock.calls.filter(([message]) => String(message).includes("permitsIdentity"));
}

describe("a turn's key retry over a SessionsApi without permitsIdentity", () => {
	it("does not wait for a disabled login in a session restricted to an account pool, and warns once", async () => {
		// If this regresses, the key lookup of a pooled session on such a host throws instead of ending the turn on
		// its missing key, or waits for a login it cannot place in the session's pool without saying why.
		const unreadablePoolWarnings = captureUnreadablePoolWarnings();
		const registry = await openRegistry();

		expect(await registry.missingKeyMayRecover("anthropic", "pooled")).toBe(false);
		expect(await registry.missingKeyMayRecover("anthropic", "pooled")).toBe(false);
		expect(unreadablePoolWarnings()).toEqual([[expect.any(String), { provider: "anthropic", sessionId: "pooled" }]]);
	});

	it("still waits for the disabled login in an unrestricted session", async () => {
		// If this regresses, every session of such a host ends its turn on a key that a new login brings back.
		const unreadablePoolWarnings = captureUnreadablePoolWarnings();
		const registry = await openRegistry();

		expect(await registry.missingKeyMayRecover("anthropic", "free")).toBe(true);
		expect(unreadablePoolWarnings()).toEqual([]);
	});
});
