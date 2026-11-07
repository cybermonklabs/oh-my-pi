import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { refreshOAuthToken } from "@oh-my-pi/pi-ai/registry/oauth";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const CONSOLE_CLIENT_ID = "41077d10-94b8-4194-be48-d251e9eb21b4";
const CONSOLE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

afterEach(() => {
	vi.restoreAllMocks();
});

function tokenResponse(suffix: string): Response {
	return new Response(
		JSON.stringify({
			access_token: `access-${suffix}`,
			refresh_token: `refresh-${suffix}`,
			expires_in: 28800,
			account: { uuid: "account-id", email_address: "user@example.com" },
			organization: { uuid: "org-id", name: "Example Org" },
			workspace: { id: "wrkspc_example", name: "Claude Code" },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("anthropic console oauth", () => {
	it("stores the Console grant under anthropic and refreshes it through the Console client", async () => {
		let authUrl = "";
		const exchangeBodies: Record<string, string>[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			expect(String(input)).toBe(CONSOLE_TOKEN_URL);
			exchangeBodies.push(JSON.parse(String(init?.body)));
			return tokenResponse("login");
		});
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.credentials.reload();

		await storage.oauth.login("anthropic-console", {
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => `code-123#${new URL(authUrl).searchParams.get("state")}`,
			fetch: fetchMock,
		});

		const authorize = new URL(authUrl);
		expect(authorize.origin + authorize.pathname).toBe("https://platform.claude.com/oauth/authorize");
		expect(authorize.searchParams.get("client_id")).toBe(CONSOLE_CLIENT_ID);
		expect(authorize.searchParams.get("scope")).toBe("user:profile user:inference");
		expect(exchangeBodies[0]?.client_id).toBe(CONSOLE_CLIENT_ID);

		const stored = storage.credentials.get("anthropic");
		if (stored?.type !== "oauth") throw new Error("expected an anthropic oauth credential");
		expect(stored.loginProvider).toBe("anthropic-console");
		expect(stored.workspaceId).toBe("wrkspc_example");
		expect(stored.orgId).toBe("org-id");

		// Refresh is requested for the storing provider; the recorded login must
		// still route it to the Console token endpoint and client.
		const refreshBodies: Record<string, string>[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit) => {
					expect(String(input)).toBe(CONSOLE_TOKEN_URL);
					refreshBodies.push(JSON.parse(String(init?.body)));
					return tokenResponse("refreshed");
				},
				{ preconnect: fetch.preconnect },
			),
		);
		const refreshed = await refreshOAuthToken("anthropic", stored);
		expect(refreshBodies[0]).toMatchObject({
			grant_type: "refresh_token",
			client_id: CONSOLE_CLIENT_ID,
			refresh_token: "refresh-login",
		});
		expect(refreshed.access).toBe("access-refreshed");

		store.close();
	});
});
