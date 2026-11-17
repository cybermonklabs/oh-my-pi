import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

beforeAll(async () => {
	await initTheme();
});

const authStorage = {
	credentials: { has: (_providerId: string) => false },
	keys: { source: (_providerId: string) => undefined },
} as unknown as AuthStorage;

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"login",
			authStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	it("does not offer env-only providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (_providerId: string) => false },
				keys: {
					source: (providerId: string) =>
						providerId === "opencode-go" || providerId === "opencode-zen"
							? { kind: "api_key", concrete: true }
							: undefined,
				},
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("No stored provider credentials to log out");

		component.handleInput("\n");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (providerId: string) => providerId === "opencode-go" },
				keys: {
					source: (providerId: string) =>
						providerId === "opencode-go" ? { kind: "api_key", concrete: true } : undefined,
				},
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("logged in");

		component.handleInput("\n");
		expect(selected).toEqual(["opencode-go"]);
	});

	it("offers an alias login's stored credentials for logout once, under the provider that stores them", () => {
		const providers = getOAuthProviders();
		const target = providers.find(provider => provider.id === "openai-codex");
		const alias = providers.find(provider => provider.storeCredentialsAs === "openai-codex");
		expect(target).toBeDefined();
		expect(alias).toBeDefined();
		if (!target || !alias) return;

		const validated: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (providerId: string) => providerId === "openai-codex" },
				keys: { source: (_providerId: string) => undefined },
			} as unknown as AuthStorage,
			() => {},
			() => {},
			{
				validateAuth: async providerId => {
					validated.push(providerId);
					return true;
				},
			},
		);
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		component.stopValidation();

		// The alias row would remove the same logins as its target's row.
		expect(rendered).toContain(target.name);
		expect(rendered).not.toContain(alias.name);
		expect(validated).toEqual(["openai-codex"]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of victim.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			expect(alias).toBeDefined();
			if (!alias) return;
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of alias.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(alias.name);
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["opencode-go"] } });

			const selected: string[] = [];
			const component = new OAuthSelectorComponent(
				"logout",
				{
					credentials: { has: (providerId: string) => providerId === "opencode-go" },
					keys: {
						source: (providerId: string) =>
							providerId === "opencode-go" ? { kind: "api_key", concrete: true } : undefined,
					},
				} as unknown as AuthStorage,
				providerId => selected.push(providerId),
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of "opencode-go") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("OpenCode Go");
		});
	});
});
