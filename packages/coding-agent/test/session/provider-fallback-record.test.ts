/**
 * A session records the strict-tools fallback its provider keeps after an endpoint rejected strict tools, and a
 * process that resumes the session puts it back before its first request. GitLab Duo sends a request as the model of
 * the API its route names, under the upstream id, so the fallback names that id: the process finds the model it was
 * recorded for through the model its requests go out as. A `cache_control` fallback lasts as long as the provider
 * state that learned it: no record holds it, and none puts it back.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { restoreAnthropicFallback } from "@oh-my-pi/pi-ai/providers/anthropic";
import {
	type ProviderFallback,
	providerFallbacks,
	strictToolsFallbackHolds,
} from "@oh-my-pi/pi-ai/providers/provider-fallbacks";
import { wireModel } from "@oh-my-pi/pi-ai/providers/wire-model";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ProviderFallbackRecord } from "@oh-my-pi/pi-coding-agent/session/provider-fallback-record";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PROVIDER_FALLBACKS = "provider-fallbacks";

describe("a recorded strict-tools fallback of a model a wrapper transport sends as another", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
	});

	it("is put back for GitLab Duo's next request, and no record dropping it is written", () => {
		const dir = TempDir.createSync("@pi-provider-fallback-record-");
		cleanups.push(() => dir.removeSync());
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const model = modelRegistry.find("gitlab-duo", "duo-chat-gpt-5-2-codex");
		if (!model) throw new Error("Expected GitLab Duo's duo-chat-gpt-5-2-codex");
		const wire = wireModel(model);
		// Precondition: the request goes out on Responses under the upstream id, which no catalog row of Duo names.
		expect(wire.api).toBe("openai-responses");
		expect(modelRegistry.find("gitlab-duo", wire.id)).toBeUndefined();

		// The process before kept the fallback the endpoint's 400 turned on, for the scope its requests went out under.
		const fallback: ProviderFallback = {
			api: "openai-responses",
			provider: wire.provider,
			baseUrl: wire.baseUrl,
			modelId: wire.id,
			off: "strict-tools",
		};
		const sessionManager = SessionManager.inMemory(dir.path());
		sessionManager.appendCustomEntry(PROVIDER_FALLBACKS, { version: 1, fallbacks: [fallback] });
		const providerSessionState = new Map<string, ProviderSessionState>();
		new ProviderFallbackRecord({ sessionManager, providerSessionState, modelRegistry }).sync();

		// The next request sends no tool as strict, as the last one of the process before did.
		expect(strictToolsFallbackHolds(providerSessionState, wire)).toBe(true);
		const records = sessionManager
			.getEntries()
			.filter(entry => entry.type === "custom" && entry.customType === PROVIDER_FALLBACKS);
		expect(records).toHaveLength(1);
	});
});

describe("a cache_control fallback", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	it("is put back from no record, goes in none, and stays with the provider state that learned it", async () => {
		const dir = TempDir.createSync("@pi-provider-fallback-record-");
		cleanups.push(() => dir.removeSync());
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
		const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
		const scope = { api: "anthropic-messages", baseUrl: "https://gateway.test", modelId: "claude-opus-5-5" } as const;
		const strictTools: ProviderFallback = { ...scope, off: "strict-tools" };
		const breakpointOptions: ProviderFallback = { ...scope, off: "cache-control-options" };
		// A record an earlier process wrote while records held cache_control fallbacks too.
		const file = dir.join("session.jsonl");
		const timestamp = new Date(0).toISOString();
		const lines = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "fallbacks", timestamp, cwd: dir.path() },
			{
				type: "custom",
				id: "record-1",
				parentId: null,
				timestamp,
				customType: PROVIDER_FALLBACKS,
				data: { version: 1, fallbacks: [strictTools, breakpointOptions] },
			},
		];
		await Bun.write(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		const sessionManager = await SessionManager.open(file);
		cleanups.push(() => sessionManager.close());
		const records = () =>
			sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom" && entry.customType === PROVIDER_FALLBACKS);
		const providerSessionState = new Map<string, ProviderSessionState>();
		const record = new ProviderFallbackRecord({ sessionManager, providerSessionState, modelRegistry });

		// The resumed process's first request leaves strict tools out, and sends `ttl` again.
		record.sync();
		expect(providerFallbacks(providerSessionState)).toEqual([strictTools]);
		expect(records()).toHaveLength(1);

		// The endpoint refuses `ttl` again: the provider keeps the fallback, and the session records nothing of it.
		restoreAnthropicFallback(providerSessionState, breakpointOptions);
		record.sync();
		expect(records()).toHaveLength(1);

		// A read of the session's entries in whole in the same process keeps what its provider state learned.
		await sessionManager.setSessionFile(file);
		record.sync();
		expect(providerFallbacks(providerSessionState)).toEqual([strictTools, breakpointOptions]);
		expect(records()).toHaveLength(1);
	});
});
