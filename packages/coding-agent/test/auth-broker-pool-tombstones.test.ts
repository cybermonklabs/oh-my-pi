/**
 * An auth broker client's account pool decides which disabled logins the client acts on, as it decides which
 * active ones it uses: a turn waits for a key, and `/logout` offers a login, only for an account in the pool.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, DELETED_BY_USER, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { listLogoutAccounts } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/logout";

const BROKER_TOKEN = "pooled-tombstones";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function oauthLogin(email: string) {
	return {
		type: "oauth" as const,
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 60_000,
		email,
	};
}

/**
 * A client of an auth broker with the account pool `{ anthropic: { accounts: [A] } }`. On the broker the user
 * logged out of account A, so no key of the pool is left, and a refresh failure disabled another account, B.
 */
async function openPooledClient() {
	const temp = await TempDir.create("@auth-broker-pool-tombstones-");
	cleanups.push(() => temp.remove());
	const brokerStorage = new AuthStorage(await SqliteAuthCredentialStore.open(temp.join("broker.db")));
	cleanups.push(() => brokerStorage.close());
	await brokerStorage.credentials.set("anthropic", [oauthLogin("a@example.test"), oauthLogin("b@example.test")]);
	for (const row of brokerStorage.credentials.list("anthropic")) {
		const email = row.credential.type === "oauth" ? row.credential.email : undefined;
		await brokerStorage.credentials.disable(
			row.id,
			email === "a@example.test" ? DELETED_BY_USER : "oauth refresh failed: invalid_grant",
		);
	}
	const accountA = (await brokerStorage.credentials.listDisabled("anthropic")).find(
		row => row.email === "a@example.test",
	)?.identityKey;
	if (!accountA) throw new Error("Expected account A's identity key");
	const broker = startAuthBroker({
		storage: brokerStorage,
		bind: "127.0.0.1:0",
		bearerTokens: [BROKER_TOKEN],
		disableRefresher: true,
	});
	cleanups.push(() => broker.close());
	const authStorage = new AuthStorage(
		new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: broker.url, token: BROKER_TOKEN }),
			streamSnapshots: false,
			accountPool: new Map([["anthropic", { accounts: new Set([accountA]) }]]),
		}),
	);
	cleanups.push(() => authStorage.close());
	await authStorage.credentials.reload();
	return { authStorage, registry: new ModelRegistry(authStorage, temp.join("models.yml")) };
}

describe("a broker client's account pool over failure-disabled logins", () => {
	it("does not wait for a key on an account outside the pool", async () => {
		// If this regresses, a turn with no key of its pool spends its retry budget and ends marked for
		// `omp --resume --restore`, waiting on another account's login that this client never uses.
		const { registry } = await openPooledClient();

		expect(await registry.missingKeyMayRecover("anthropic")).toBe(false);
	});

	it("does not offer /logout an account outside the pool", async () => {
		// If this regresses, /logout lists another account's disabled login, and removing it records the user's
		// removal on that account on the shared broker, for every client of it.
		const { authStorage } = await openPooledClient();

		expect(await listLogoutAccounts(authStorage, "anthropic", "pooled-session")).toEqual([]);
	});
});
