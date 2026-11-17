import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => vi.restoreAllMocks());

describe("/logout through an auth broker older than the client", () => {
	it("says the broker did not record the removal of a failure-disabled login, and to upgrade it", async () => {
		// If this regresses, /logout reports the login as already gone while the broker keeps its failure, and turns keep waiting for it.
		await using temp = await TempDir.create("@logout-older-broker-");
		await Settings.init({ inMemory: true });
		const brokerStorage = new AuthStorage(await SqliteAuthCredentialStore.open(temp.join("broker.db")));
		await brokerStorage.credentials.set("anthropic", [
			{
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 60_000,
				email: "disabled@example.test",
			},
		]);
		const id = brokerStorage.credentials.list("anthropic")[0]!.id;
		await brokerStorage.credentials.disable(id, "oauth refresh failed: invalid_grant");
		// A broker built before it recorded removals on tombstones answers 404 for any id that is not active.
		const disable = brokerStorage.credentials.disable.bind(brokerStorage.credentials);
		vi.spyOn(brokerStorage.credentials, "disable").mockImplementation(async (credentialId, disabledCause) =>
			brokerStorage.credentials.list().some(row => row.id === credentialId)
				? disable(credentialId, disabledCause)
				: false,
		);
		const token = "logout-older-broker";
		const broker = startAuthBroker({
			storage: brokerStorage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		const authStorage = new AuthStorage(
			new RemoteAuthCredentialStore({
				client: new AuthBrokerClient({ url: broker.url, token }),
				streamSnapshots: false,
			}),
		);
		try {
			await authStorage.credentials.reload();
			const registry = new ModelRegistry(authStorage, temp.join("models.yml"));
			vi.spyOn(registry, "refreshProvider").mockResolvedValue(undefined);
			const reported = Promise.withResolvers<string>();
			const ctx = createInteractiveModeContext({
				session: { modelRegistry: registry, sessionId: "logout-session", refreshScopedModels: async () => {} },
				present: () => reported.reject(new Error("logout reported success")),
				showError: message => reported.resolve(message),
			});
			const controller = new SelectorController(ctx);
			let selector: Component | undefined;
			controller.showSelector = create => {
				selector = create(() => {}).component;
			};
			await controller.showOAuthSelector("logout", "anthropic");
			expect(selector).toBeInstanceOf(LogoutAccountSelectorComponent);

			selector!.handleInput?.("\n");

			const message = await reported.promise;
			expect(message).toContain(`did not record the removal of anthropic credential #${id}`);
			expect(message).toContain("Upgrade the auth broker");
		} finally {
			authStorage.close();
			await broker.close();
			brokerStorage.close();
		}
	});
});
