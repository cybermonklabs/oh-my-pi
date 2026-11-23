/**
 * While a session holds a settings change on a bound prompt, `/tan` gives its clone the session's build, the prompt
 * that goes out with the change (`AgentSession.withheldPromptBuild`), as the clone's fixed prompt, and the session
 * itself (`tanParent`): the clone restores the held prompt its copied transcript stores, which the session's operator
 * inputs built, and starts on it. A session that is not a `/tan` clone, started on a copy of the same transcript with
 * the same fixed prompt, has its fixed prompt as its operator inputs, so that stored prompt is refused and it sends its
 * own from its first request. The build the session gives is a copy: no caller sets what a clone starts from through
 * it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
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
	type MessagesRequest,
	mockGatewayFetch,
	textOf,
	withoutCacheControl,
} from "../helpers/anthropic-gateway";

/** The first line the `pragmatic` personality renders into the system prompt. */
const PRAGMATIC_TEXT = "Pragmatic, effective senior engineer.";

const MINUTE_MS = 60_000;

/** A session that holds a settings change, the options a copy of it starts with, and every request sent so far. */
interface HeldParent {
	dir: TempDir;
	parent: AgentSession;
	shared: CreateAgentSessionOptions;
	requests: MessagesRequest[];
}

describe("a /tan clone of a session that holds a settings change", () => {
	const cleanups: (() => Promise<void> | void)[] = [];
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	/**
	 * A session whose `personality` change is held: its first request, then the change, then a request a minute later
	 * that keeps the prompt without it. Returns the session, what it needs to start copies, and its requests so far.
	 */
	async function heldParent(): Promise<HeldParent> {
		const dir = TempDir.createSync("@omp-tan-clone-restore-gate-");
		cleanups.push(() => dir.removeSync());
		await Bun.write(dir.join("models.yml"), gatewayModelsYml());
		const overlay = dir.join("overlay.yml");
		await Bun.write(overlay, personalityOverlay("default"));
		const settings = await Settings.loadIsolated({ cwd: dir.path(), agentDir: dir.path(), configFiles: [overlay] });
		const gateway = mockGatewayFetch(turn => answer(turn, { cacheWriteTokens: 100 }));
		cleanups.push(() => gateway.restore());
		const authStorage = createInMemoryAuthStorage();
		cleanups.push(() => authStorage.close());
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
		cleanups.push(() => parent.dispose());
		setClock(0);
		await parent.prompt("first");
		await reloadOverlay({ session: parent, settings, overlay }, personalityOverlay("pragmatic"), RELOAD_CALLS);
		setClock(MINUTE_MS);
		await parent.prompt("second");
		await parent.sessionManager.ensureOnDisk();
		await parent.sessionManager.flush();
		return { dir, parent, shared, requests: gateway.requests };
	}

	/** A session started on a copy of `parent`'s transcript with `options`; its first request at two minutes. */
	async function copyOf(
		{ dir, parent, shared }: HeldParent,
		name: string,
		options: { systemPrompt: string[]; tanParent?: AgentSession },
	): Promise<void> {
		const parentFile = parent.sessionManager.getSessionFile();
		if (!parentFile) throw new Error("Expected a persisted parent session");
		const sessionManager = await SessionManager.forkFrom(parentFile, dir.path(), dir.join(name), undefined, {
			suppressBreadcrumb: true,
		});
		const { session } = await createAgentSession({ ...shared, ...options, sessionManager });
		cleanups.push(() => session.dispose());
		setClock(2 * MINUTE_MS);
		await session.prompt("in the copy");
	}

	it("starts the clone on the held prompt the parent sends, and refuses that prompt to any other copy", async () => {
		const held = await heldParent();
		const build = held.parent.withheldPromptBuild;
		if (!build) throw new Error("Expected the parent to withhold a change");
		const parentRequest = held.requests.at(-1);
		if (!parentRequest) throw new Error("Expected the parent's requests");

		await copyOf(held, "clone", { systemPrompt: build, tanParent: held.parent });
		await copyOf(held, "other", { systemPrompt: build });
		const [cloneRequest, otherRequest] = held.requests.slice(-2);
		if (!cloneRequest || !otherRequest) throw new Error("Expected each copy's request");

		// Precondition: the parent's request keeps the prompt without the change.
		expect(textOf(parentRequest.system)).not.toContain(PRAGMATIC_TEXT);
		expect(withoutCacheControl(cloneRequest.system)).toBe(withoutCacheControl(parentRequest.system));
		expect(textOf(otherRequest.system)).toContain(PRAGMATIC_TEXT);
	}, 60_000);

	it("gives the build as a copy that no caller can set", async () => {
		const { parent } = await heldParent();
		const build = parent.withheldPromptBuild;
		if (!build) throw new Error("Expected the parent to withhold a change");
		expect(build.join("\n")).toContain(PRAGMATIC_TEXT);

		build.splice(0, build.length, "forged");
		expect(Reflect.set(parent, "withheldPromptBuild", ["forged"])).toBe(false);

		expect(parent.withheldPromptBuild?.join("\n")).toContain(PRAGMATIC_TEXT);
		expect(parent.withheldPromptBuild).not.toContain("forged");
	}, 60_000);
});
