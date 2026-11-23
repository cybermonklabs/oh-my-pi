/**
 * A subagent the task tool spawns gets its system prompt from a `systemPrompt` function that wraps the default prompt,
 * device catalog included, and drops the parent-owned `todo` tool before its first prompt
 * (`session.setActiveToolsByName`), which rebuilds that prompt. Its first request lists the `xd://` devices in the
 * system prompt; it must not also carry a hidden notice that the device inventory changed: nothing was mounted after
 * the prompt was built, and the release sent no such notice.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
} from "./helpers/anthropic-gateway";

const MOUNT_NOTICE = "xd:// device inventory changed";

/**
 * Opens a session on the gateway's model with the default tools, its prompt from `systemPrompt` when given, drops
 * `todo` from its tools as the task executor drops it from a subagent's, sends one prompt and returns the request.
 */
async function firstRequest(
	tempDir: TempDir,
	systemPrompt: ((defaultPrompt: string[]) => string[]) | undefined,
): Promise<MessagesRequest> {
	await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
	const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	const authStorage = createInMemoryAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = modelRegistry.find("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
		const { session } = await createAgentSession({
			...gatewaySessionOptions(tempDir),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "providers.cacheRetention": "long" }),
			model,
			contextFiles: [],
			skills: [],
			systemPrompt,
		});
		try {
			const enabled = session.getEnabledToolNames();
			// Precondition: the parent-owned tool is there to drop, so the call changes the tool set.
			expect(enabled).toContain("todo");
			await session.setActiveToolsByName(enabled.filter(name => name !== "todo"));
			await session.prompt("first");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		gateway.restore();
	}
	const [request] = gateway.requests;
	if (!request) throw new Error("Expected one request");
	return request;
}

describe("a subagent-shaped session whose system prompt a function wraps", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends no device inventory notice for the devices its prompt lists", async () => {
		using tempDir = TempDir.createSync("@pi-custom-prompt-xdev-notice-");
		const request = await firstRequest(tempDir, defaultPrompt => [...defaultPrompt]);

		// Precondition: the system prompt lists the mounted devices.
		const system = textOf(request.system);
		expect(system).toContain("# xd:// Tool Devices");
		expect(system).toContain("xd://ast_edit");

		// Nothing was mounted after the prompt was built: no message tells the model the inventory changed.
		expect(textOf(request.messages)).not.toContain(MOUNT_NOTICE);
	}, 30_000);

	it("sends none with the default prompt (control)", async () => {
		using tempDir = TempDir.createSync("@pi-custom-prompt-xdev-notice-");
		const request = await firstRequest(tempDir, undefined);

		expect(textOf(request.system)).toContain("xd://ast_edit");
		expect(textOf(request.messages)).not.toContain(MOUNT_NOTICE);
	}, 30_000);
});
