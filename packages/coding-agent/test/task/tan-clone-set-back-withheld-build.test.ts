/**
 * A `/tan` clone of a session that holds a `personality` change starts on the held prompt its copied transcript
 * stores, with the session's build as the prompt it sends once the change goes out. A sync then sets `personality`
 * back: the stored prompt says what the settings say, so it is the prompt that goes out with the clone's change. The
 * build the clone gives a copy of its own (a `/tan` of the clone, the prompt a parked clone stores for a cold revive)
 * must be that prompt, not the build of a value the settings no longer have.
 */
import { afterEach, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createInMemoryAuthStorage,
	personalityOverlay,
	RELOAD_CALLS,
	reloadOverlay,
	setClock,
} from "../helpers/agent-session-setup";
import {
	answer,
	gatewayModelsYml,
	gatewaySessionOptions,
	mockGatewayFetch,
	textOf,
} from "../helpers/anthropic-gateway";

/** The first line the `pragmatic` personality renders into the system prompt. */
const PRAGMATIC_TEXT = "Pragmatic, effective senior engineer.";

const MINUTE_MS = 60_000;

afterEach(() => {
	vi.restoreAllMocks();
});

it("gives the stored prompt as a /tan clone's build once the held change is set back", async () => {
	using dir = TempDir.createSync("@omp-tan-clone-set-back-build-");
	await Bun.write(dir.join("models.yml"), gatewayModelsYml());
	const overlay = dir.join("overlay.yml");
	await Bun.write(overlay, personalityOverlay("default"));
	const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
	const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, dir.join("models.yml"));
	const model = modelRegistry.find("anthropic", "claude-opus-5-5");
	if (!model) throw new Error("Expected the gateway's claude-opus-5-5");
	const shared: CreateAgentSessionOptions = {
		...gatewaySessionOptions(dir),
		authStorage,
		modelRegistry,
		model,
		settings,
		toolNames: ["read"],
		contextFiles: [],
		skills: [],
	};
	const { session: parent } = await createAgentSession({
		...shared,
		sessionManager: SessionManager.create(dir.path(), dir.join("parent")),
	});
	let clone: AgentSession | undefined;
	try {
		setClock(0);
		await parent.prompt("first");
		await reloadOverlay({ session: parent, settings, overlay }, personalityOverlay("pragmatic"), RELOAD_CALLS);
		setClock(MINUTE_MS);
		await parent.prompt("second");
		await parent.sessionManager.ensureOnDisk();
		await parent.sessionManager.flush();
		const build = parent.withheldPromptBuild;
		const parentFile = parent.sessionManager.getSessionFile();
		if (!build || !parentFile) throw new Error("Expected a persisted session that withholds the change");
		const sessionManager = await SessionManager.forkFrom(parentFile, dir.path(), dir.join("clone"), undefined, {
			suppressBreadcrumb: true,
		});
		({ session: clone } = await createAgentSession({
			...shared,
			systemPrompt: build,
			tanParent: parent,
			sessionManager,
		}));
		setClock(2 * MINUTE_MS);
		await clone.prompt("in the clone");
		await reloadOverlay({ session: clone, settings, overlay }, personalityOverlay("default"), RELOAD_CALLS);

		const cloneRequest = gateway.requests.at(-1);
		if (!cloneRequest) throw new Error("Expected the clone's request");
		// Preconditions: the parent's build renders the held change; the clone starts on the held prompt, which it
		// still withholds that build for.
		expect(build.join("\n")).toContain(PRAGMATIC_TEXT);
		expect(textOf(cloneRequest.system)).not.toContain(PRAGMATIC_TEXT);
		const cloneBuild = clone.withheldPromptBuild;
		if (!cloneBuild) throw new Error("Expected the clone to withhold the change");

		expect(cloneBuild.join("\n")).not.toContain(PRAGMATIC_TEXT);
		expect(cloneBuild).toEqual(clone.baseSystemPrompt);
	} finally {
		await clone?.dispose();
		await parent.dispose();
		authStorage.close();
		gateway.restore();
	}
}, 60_000);
