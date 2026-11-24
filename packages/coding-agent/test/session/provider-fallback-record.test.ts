/**
 * A session records the strict-tools fallback its provider keeps after an endpoint rejected strict tools, and a
 * process that resumes the session puts it back before its first request. GitLab Duo sends a request as the model of
 * the API its route names, under the upstream id, so the fallback names that id: the process finds the model it was
 * recorded for through the model its requests go out as.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { type ProviderFallback, strictToolsFallbackHolds } from "@oh-my-pi/pi-ai/providers/provider-fallbacks";
import { wireModel } from "@oh-my-pi/pi-ai/providers/wire-model";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ProviderFallbackRecord } from "@oh-my-pi/pi-coding-agent/session/provider-fallback-record";
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
