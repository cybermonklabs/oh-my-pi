/**
 * `getWithCredential` reports which kind of credential supplied the bearer, so
 * request telemetry can tell a subscription (OAuth) call from a per-token API
 * key call on the same provider id.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";

const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;

describe("KeyCascade.getWithCredential credentialType", () => {
	const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
	let storage: AuthStorage | undefined;

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		storage?.close();
		storage = undefined;
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	const open = async (): Promise<AuthStorage> => {
		storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"));
		return storage;
	};

	it("marks a stored OAuth login as oauth", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [
			{ type: "oauth", access: "oauth-access", refresh: "refresh-1", expires: Date.now() + 3_600_000 },
		]);

		const resolved = await auth.keys.getWithCredential("anthropic", "session");
		expect(resolved?.apiKey).toBe("oauth-access");
		expect(resolved?.credentialType).toBe("oauth");
	});

	it("names the login that minted an OAuth grant stored under another provider", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "console-access",
				refresh: "refresh-1",
				expires: Date.now() + 3_600_000,
				loginProvider: "anthropic-console",
			},
		]);

		const resolved = await auth.keys.getWithCredential("anthropic", "session");
		expect(resolved?.credentialType).toBe("oauth");
		expect(resolved?.loginProvider).toBe("anthropic-console");
	});

	it("marks a stored API key as api_key", async () => {
		const auth = await open();
		await auth.credentials.set("anthropic", [{ type: "api_key", key: "sk-ant-api-stored" }]);

		const resolved = await auth.keys.getWithCredential("anthropic", "session");
		expect(resolved?.apiKey).toBe("sk-ant-api-stored");
		expect(resolved?.credentialType).toBe("api_key");
	});

	it("marks an environment API key as api_key", async () => {
		const auth = await open();
		process.env.ANTHROPIC_API_KEY = "sk-ant-api-env";

		const resolved = await auth.keys.getWithCredential("anthropic", "session");
		expect(resolved?.apiKey).toBe("sk-ant-api-env");
		expect(resolved?.credentialType).toBe("api_key");
	});

	it("leaves a runtime override unclassified", async () => {
		const auth = await open();
		auth.keys.setRuntime("anthropic", "runtime-key");

		const resolved = await auth.keys.getWithCredential("anthropic", "session");
		expect(resolved?.apiKey).toBe("runtime-key");
		expect(resolved?.credentialType).toBeUndefined();
	});
});
