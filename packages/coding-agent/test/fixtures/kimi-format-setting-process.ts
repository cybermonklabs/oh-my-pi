/**
 * One omp process of `agent-session-kimi-format-setting-wire.test.ts`: a session on Kimi Code's K3 whose API format
 * `providers.kimiApiFormat` overrides the one the model's catalog row resolves. The test imports
 * {@link runKimiSession} under default settings and runs this file as `bun <this file> <input JSON>` with
 * `PI_NO_STRICT` set, which the providers read once, when they load. A session sends a prompt, then one with a forced
 * tool choice, against a stand-in of Kimi Code's endpoints.
 */
import { vi } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { requestBodyText } from "@oh-my-pi/pi-ai/utils/request-body";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { gatewaySessionOptions, answer as messagesAnswer } from "../helpers/anthropic-gateway";
import { asGlobalFetch } from "../helpers/fetch-mock";
import { answer as completionsAnswer } from "../helpers/openai-gateway";

export type KimiApiFormat = "anthropic" | "openai";

/** Where Kimi Code takes each API format's requests. */
const ENDPOINTS: Record<KimiApiFormat, string> = {
	anthropic: "https://api.kimi.com/coding/v1/messages",
	openai: "https://api.kimi.com/coding/v1/chat/completions",
};

/** What the test gives the process. */
export interface KimiProcessInput {
	/** The test's directory: the working and agent directory, with the sessions. */
	dir: string;
	/** The API format the model's catalog row resolves. */
	catalog: KimiApiFormat;
	/** `providers.kimiApiFormat`. */
	setting: KimiApiFormat;
}

/** What the process saw. */
export interface KimiProcessRun {
	/** The API format of each request's endpoint, oldest first. */
	formats: KimiApiFormat[];
	/** The tools the first request declares. */
	tools: unknown;
	/** The tool choice the forced turn's request sent; undefined for none. */
	forcedToolChoice: unknown;
	/** Whether the warmer armed the forced turn's request. */
	armedForced: boolean;
	/** The session's declared-tools fingerprint for its model after both turns. */
	fingerprint: string;
}

/** A request body as far as the process reads it. */
interface KimiRequest {
	tools?: unknown;
	tool_choice?: unknown;
}

/** Runs one session as {@link KimiProcessInput} describes. */
export async function runKimiSession(input: KimiProcessInput): Promise<KimiProcessRun> {
	// Kimi Code's catalog rows are chat completions rows whose compat names the API format a request goes out in.
	const k3 = getBundledModel<"openai-completions">("kimi-code", "k3");
	// K3 in the catalog's format, behind a chat completions host that takes no forced tool choice: a request sends a
	// forced choice as given on Anthropic's API and as `auto` on chat completions.
	const model: Model<"openai-completions"> = {
		...k3,
		compat: { ...k3.compat, kimiApiFormat: input.catalog, supportsForcedToolChoice: false },
	};
	const formats: KimiApiFormat[] = [];
	const requests: KimiRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (request, init) => {
			const url = String(request instanceof Request ? request.url : request);
			const format = url === ENDPOINTS.anthropic ? "anthropic" : url === ENDPOINTS.openai ? "openai" : undefined;
			if (!format) throw new Error(`Unexpected request to ${url}`);
			formats.push(format);
			requests.push(JSON.parse(requestBodyText(init) ?? "{}"));
			return format === "anthropic"
				? messagesAnswer(requests.length)
				: completionsAnswer("openai-completions", requests.length);
		}),
	);
	const warmerStarts = vi.spyOn(CacheWarmer.prototype, "start");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("kimi-code", "kimi-test-key");
	try {
		const { session } = await createAgentSession({
			...gatewaySessionOptions({ path: () => input.dir }),
			sessionManager: SessionManager.create(input.dir, path.join(input.dir, "sessions")),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(input.dir, "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "providers.kimiApiFormat": input.setting }),
			model,
			// `edit` goes out strict on Anthropic's API unless `PI_NO_STRICT` is set; chat completions sends no tool
			// strict to Kimi Code.
			toolNames: ["read", "edit"],
			contextFiles: [],
			skills: [],
		});
		try {
			await session.prompt("first");
			await session.prompt("second", { toolChoice: { type: "tool", name: "read" } });
			const [first, forced] = requests;
			if (!first || !forced) throw new Error("Expected a request for each prompt");
			return {
				formats,
				tools: first.tools,
				forcedToolChoice: forced.tool_choice,
				armedForced: warmerStarts.mock.results.at(-1)?.value !== undefined,
				fingerprint: session.agent.declaredToolsFingerprint(session.model),
			};
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		vi.restoreAllMocks();
	}
}

if (import.meta.main) {
	const input = JSON.parse(Bun.argv[2] ?? "{}") as KimiProcessInput & { out: string };
	await Bun.write(input.out, JSON.stringify(await runKimiSession(input)));
	process.exit(0);
}
