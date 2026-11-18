import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";
import { nextTask } from "./helpers";

const PROVIDER = "unit-oauth-rotating";
const TOKEN_URL = "https://auth.example.test/token";
const WHOAMI_URL = "https://api.example.test/whoami";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Wait until `caller` sleeps on the fake clock, waiting on a lease another owner holds: it has
 * armed a timer beyond the `timersBefore` already armed. Fails when the caller settles instead.
 */
async function untilWaitingOnLease(caller: Promise<unknown>, timersBefore: number): Promise<void> {
	let settled = false;
	const settle = () => {
		settled = true;
	};
	void caller.then(settle, settle);
	while (vi.getTimerCount() <= timersBefore) {
		if (settled) throw new Error("The caller settled before it waited on the held lease");
		await nextTask();
	}
}

// Every test here hands the refresher a budget that the product measures with `Date.now()` and
// `setTimeout` from the call. They run it on a fake clock that moves only when the test moves it:
// on the real clock a loaded host spends the budget before the step under test is reached.

describe("OAuth refresh budget", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-refresh-budget-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	});

	afterEach(async () => {
		if (vi.isFakeTimers()) {
			// A failed test can leave a refresh waiting on the fake clock. Fire what is pending so it
			// settles: a refresh that never settles holds the process at exit for its shutdown drain.
			vi.runOnlyPendingTimers();
			vi.useRealTimers();
		}
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	test("persists a refresh token the provider rotated when post-exchange work outlasts the budget", async () => {
		if (!store) throw new Error("test setup failed");
		vi.useFakeTimers();
		const budgetMs = 50;
		const authStorage = new AuthStorage(store, {});

		// Token endpoint that rotates the refresh token on every grant, so the
		// previous one is dead server-side as soon as the grant answers.
		const validRefreshTokens = new Set(["r0"]);
		let rotations = 0;
		// Post-exchange work (e.g. an org lookup) stays pending until the caller has given up.
		const whoamiRequested = Promise.withResolvers<void>();
		const whoamiGate = Promise.withResolvers<void>();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
					const url = String(input);
					if (url === TOKEN_URL) {
						const presented = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
						if (!validRefreshTokens.delete(presented)) return json({ error: "invalid_grant" }, 400);
						const next = `r${++rotations}`;
						validRefreshTokens.add(next);
						return json({ access_token: `access-${next}`, refresh_token: next, expires_in: 3600 });
					}
					if (url === WHOAMI_URL) {
						whoamiRequested.resolve();
						// Like a real request, the lookup ends early if the exchange is aborted.
						const aborted = Promise.withResolvers<never>();
						init?.signal?.addEventListener("abort", () => aborted.reject(init.signal?.reason), { once: true });
						await Promise.race([whoamiGate.promise, aborted.promise]);
						return json({ orgId: "org-1" });
					}
					return json({}, 404);
				},
				{ preconnect: fetch.preconnect },
			),
		);

		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		const leaseReleased = Promise.withResolvers<void>();
		const release = store.releaseCredentialRefreshLease.bind(store);
		vi.spyOn(store, "releaseCredentialRefreshLease").mockImplementation((id, owner) => {
			release(id, owner);
			leaseReleased.resolve();
		});

		let exchangeSignal: AbortSignal | undefined;
		const failures: unknown[] = [];
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: budgetMs,
			onRefreshFailure: error => failures.push(error),
			refresh: async (credential, signal) => {
				exchangeSignal = signal;
				const grant = await fetch(TOKEN_URL, {
					method: "POST",
					body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refresh }),
					signal,
				});
				if (!grant.ok) throw new Error(`token endpoint ${grant.status}`);
				const tokens = (await grant.json()) as { access_token: string; refresh_token: string; expires_in: number };
				// Post-exchange hook (e.g. an org lookup) that outlasts the caller budget.
				const whoami = (await (await fetch(WHOAMI_URL, { signal })).json()) as { orgId: string };
				return {
					access: tokens.access_token,
					refresh: tokens.refresh_token,
					expires: Date.now() + tokens.expires_in * 1000,
					orgId: whoami.orgId,
				};
			},
		});

		// The grant has answered and the post-exchange work is pending: only now does the budget run out.
		const firstEvent = await Promise.race([
			whoamiRequested.promise.then(() => "post-exchange work started"),
			refresh.then(
				() => "refresh resolved",
				() => "refresh rejected",
			),
		]);
		expect(firstEvent).toBe("post-exchange work started");
		expect(validRefreshTokens).toEqual(new Set(["r1"]));
		vi.advanceTimersByTime(budgetMs);

		// The caller stops waiting at the budget and sees the timeout.
		await expect(refresh).rejects.toMatchObject({
			message: `OAuth token refresh timed out for provider: ${PROVIDER}`,
		});
		expect(failures).toHaveLength(1);

		// The exchange itself runs on and still holds the lease.
		expect(exchangeSignal?.aborted).toBe(false);
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer", Date.now() + 15_000)).toBe(false);
		expect(store.listAuthCredentials(PROVIDER)[0]?.credential).toMatchObject({ refresh: "r0" });

		// Once the post-exchange work answers, the rotated token is persisted.
		whoamiGate.resolve();
		await leaseReleased.promise;
		expect(exchangeSignal?.aborted).toBe(false);
		expect(store.listAuthCredentials(PROVIDER)[0]?.credential).toMatchObject({
			type: "oauth",
			access: "access-r1",
			refresh: "r1",
			orgId: "org-1",
		});
		// The lease is released once the exchange has persisted.
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer", Date.now() + 15_000)).toBe(true);
	});

	test("a peer waiting on a held lease gives up at its budget", async () => {
		if (!store) throw new Error("test setup failed");
		vi.useFakeTimers();
		const budgetMs = 50;
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		const exchangeStarted = Promise.withResolvers<void>();
		const hung = Promise.withResolvers<never>();
		const first = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: budgetMs,
			refresh: () => {
				exchangeStarted.resolve();
				return hung.promise;
			},
		});
		// The first caller holds the lease for its exchange, then gives up at its budget.
		await exchangeStarted.promise;
		vi.advanceTimersByTime(budgetMs);
		await expect(first).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });

		let peerExchanged = false;
		const timersBefore = vi.getTimerCount();
		const peer = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: budgetMs,
			refresh: async () => {
				peerExchanged = true;
				throw new Error("peer must not exchange while the lease is held");
			},
		});
		// The held lease has a 15 s TTL; only the peer's budget passes on the clock.
		await untilWaitingOnLease(peer, timersBefore);
		vi.advanceTimersByTime(budgetMs);
		// The peer's wait was capped by its budget: it has woken and armed no further wait.
		await nextTask();
		expect(vi.getTimerCount()).toBe(timersBefore);
		await expect(peer).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });
		expect(peerExchanged).toBe(false);
		hung.reject(new Error("done"));
	});

	test("closing auth storage mid-exchange still saves the rotated token and refuses new refreshes", async () => {
		if (!store) throw new Error("test setup failed");
		// The 1 s budget never passes on the fake clock, so only `release` ends the exchange.
		vi.useFakeTimers();
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [{ type: "oauth", access: "access-r0", refresh: "r0", expires: 0 }]);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialFromRow: row => row,
			refreshTimeoutMs: 1_000,
			refresh: async () => {
				started.resolve();
				await release.promise;
				return { access: "access-r1", refresh: "r1", expires: Date.now() + 3_600_000 };
			},
		});
		await started.promise;
		authStorage.close();
		await expect(
			authStorage.oauth.refreshStored(PROVIDER, {
				credentialFromRow: row => row,
				forceRefresh: true,
				refresh: async () => {
					throw new Error("a closed auth storage must not start an exchange");
				},
			}),
		).rejects.toMatchObject({ message: "OAuth refresh stopped during shutdown" });
		release.resolve();
		await expect(refresh).resolves.toMatchObject({ refreshed: true, credential: { refresh: "r1" } });
		vi.useRealTimers();

		const reopened = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			const [row] = reopened.listAuthCredentials(PROVIDER);
			expect(row?.credential).toMatchObject({ type: "oauth", refresh: "r1" });
		} finally {
			reopened.close();
		}
	});

	test("closing auth storage mid-refresh on a store without leases still saves the rotated token", async () => {
		if (!store) throw new Error("test setup failed");
		// The refresh's default 10 s budget never passes on the fake clock, so only `release` ends it.
		vi.useFakeTimers();
		const sqlite = store;
		// A store without the durable lease concern refreshes outside `refreshStored`.
		const leaseless = new Proxy(sqlite, {
			get(target, key) {
				if (typeof key === "string" && key.endsWith("RefreshLease")) return undefined;
				if (key === "getCredentialRefreshLeaseExpiresAt") return undefined;
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const authStorage = new AuthStorage(leaseless, {
			refreshOAuthCredential: async () => {
				started.resolve();
				await release.promise;
				return { access: "access-r1", refresh: "r1", expires: Date.now() + 3_600_000 };
			},
		});
		await authStorage.credentials.set(PROVIDER, [{ type: "oauth", access: "access-r0", refresh: "r0", expires: 0 }]);
		const credentialId = sqlite.listAuthCredentials(PROVIDER)[0]!.id;
		const refresh = authStorage.oauth.refresh(credentialId);
		await started.promise;
		authStorage.close();
		await expect(authStorage.oauth.refresh(credentialId)).rejects.toMatchObject({
			message: "OAuth refresh stopped during shutdown",
		});
		release.resolve();
		await refresh;
		vi.useRealTimers();

		const reopened = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			const [row] = reopened.listAuthCredentials(PROVIDER);
			expect(row?.credential).toMatchObject({ type: "oauth", refresh: "r1" });
		} finally {
			reopened.close();
		}
	});

	test("a credential removed while the exchange ran is not restored to the pool", async () => {
		if (!store) throw new Error("test setup failed");
		// The default budget never passes on the fake clock, so only `gate` ends the exchange.
		vi.useFakeTimers();
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-a", refresh: "a0", expires: Date.now() - 60_000 },
			{ type: "oauth", access: "access-b", refresh: "b0", expires: Date.now() + 3_600_000 },
		]);
		const [target, sibling] = store.listAuthCredentials(PROVIDER);
		const exchangeStarted = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId: target!.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			refresh: async () => {
				exchangeStarted.resolve();
				await gate.promise;
				return { access: "access-a1", refresh: "a1", expires: Date.now() + 3_600_000 };
			},
		});
		await exchangeStarted.promise;
		await store.deleteAuthCredential(sibling!.id, "deleted by user");
		gate.resolve();
		await expect(refresh).resolves.toMatchObject({ refreshed: true });
		const pooled = authStorage.credentials.list(PROVIDER).map(entry => entry.id);
		expect(pooled).toEqual([target!.id]);
	});

	test("a credential removed while a failing exchange ran is not restored to the pool", async () => {
		if (!store) throw new Error("test setup failed");
		// The default budget never passes on the fake clock, so only `gate` ends the exchange.
		vi.useFakeTimers();
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-a", refresh: "a0", expires: Date.now() - 60_000 },
			{ type: "oauth", access: "access-b", refresh: "b0", expires: Date.now() + 3_600_000 },
			{ type: "oauth", access: "access-c", refresh: "c0", expires: Date.now() + 3_600_000 },
		]);
		const [target, sibling, kept] = store.listAuthCredentials(PROVIDER);
		const exchangeStarted = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const refresh = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId: target!.id,
			credentialFromRow: row => row,
			forceRefresh: true,
			isDefinitiveFailure: () => true,
			refresh: async () => {
				exchangeStarted.resolve();
				await gate.promise;
				throw new Error("invalid_grant");
			},
		});
		await exchangeStarted.promise;
		await store.deleteAuthCredential(sibling!.id, "deleted by user");
		gate.resolve();
		await expect(refresh).resolves.toMatchObject({ removed: true });
		const pooled = authStorage.credentials.list(PROVIDER).map(entry => entry.id);
		expect(pooled).toEqual([kept!.id]);
	});

	test("a waiter whose budget ran out does not take a lease that frees up", async () => {
		if (!store) throw new Error("test setup failed");
		vi.useFakeTimers();
		const budgetMs = 20;
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		expect(store.tryAcquireCredentialRefreshLease(credentialId, "peer", Date.now() + 15_000)).toBe(true);
		let exchanged = false;
		const timersBefore = vi.getTimerCount();
		const waiter = authStorage.oauth.refreshStored(PROVIDER, {
			credentialId,
			credentialFromRow: row => row,
			forceRefresh: true,
			refreshTimeoutMs: budgetMs,
			refresh: async () => {
				exchanged = true;
				return { access: "access-r1", refresh: "r1", expires: Date.now() + 3_600_000 };
			},
		});
		// The waiter sleeps on the held lease for the rest of its budget. The peer lets go, and the
		// waiter wakes exactly when its budget has run out, to a free lease.
		await untilWaitingOnLease(waiter, timersBefore);
		store.releaseCredentialRefreshLease(credentialId, "peer");
		vi.advanceTimersByTime(budgetMs);
		await expect(waiter).rejects.toMatchObject({
			message: `OAuth token refresh timed out for provider: ${PROVIDER}`,
		});
		expect(exchanged).toBe(false);
	});

	test("a caller whose lease acquisition outlasts its budget does not start the exchange", async () => {
		if (!store) throw new Error("test setup failed");
		vi.useFakeTimers();
		const authStorage = new AuthStorage(store, {});
		await authStorage.credentials.set(PROVIDER, [
			{ type: "oauth", access: "access-r0", refresh: "r0", expires: Date.now() - 60_000 },
		]);
		const credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		// Acquisition succeeds, but only after a SQLite busy wait that spends 30 ms of the clock,
		// more than the 20 ms budget.
		const acquire = store.tryAcquireCredentialRefreshLease.bind(store);
		vi.spyOn(store, "tryAcquireCredentialRefreshLease").mockImplementation((id, owner, expiresAt) => {
			const acquired = acquire(id, owner, expiresAt);
			vi.advanceTimersByTime(30);
			return acquired;
		});
		let exchanged = false;
		await expect(
			authStorage.oauth.refreshStored(PROVIDER, {
				credentialId,
				credentialFromRow: row => row,
				forceRefresh: true,
				refreshTimeoutMs: 20,
				refresh: async () => {
					exchanged = true;
					return { access: "access-r1", refresh: "r1", expires: Date.now() + 3_600_000 };
				},
			}),
		).rejects.toMatchObject({ message: `OAuth token refresh timed out for provider: ${PROVIDER}` });
		expect(exchanged).toBe(false);
		expect(acquire(credentialId, "peer", Date.now() + 15_000)).toBe(true);
	});
});
