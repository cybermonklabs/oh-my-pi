/**
 * The agent's declared-tools fingerprint is read on the status line, by the cache warmer and at every maintenance
 * point, and its memo keys on each tool's definition as its getters render it from live settings. While nothing those
 * getters read changes, a second read must find the memo and render no tool definition again; a live input a tool
 * renders from must still change the fingerprint, under the same tool objects.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as appendOnlyContext from "@oh-my-pi/pi-agent-core/append-only-context";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { cfgBashAutoBackgroundEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp/tool";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { LearnTool } from "@oh-my-pi/pi-coding-agent/tools/learn";
import { MemoryEditTool } from "@oh-my-pi/pi-coding-agent/tools/memory-edit";
import { MemoryRecallTool } from "@oh-my-pi/pi-coding-agent/tools/memory-recall";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import { MemoryRetainTool } from "@oh-my-pi/pi-coding-agent/tools/memory-retain";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { prompt } from "@oh-my-pi/pi-utils";

const model = getBundledModel("anthropic", "claude-opus-5-5");

function toolSession(settings: Settings): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

/** Every built-in whose getters render its definition from live state. */
async function renderingTools(session: ToolSession): Promise<AgentTool[]> {
	return [
		new ReadTool(session),
		new WriteTool(session),
		new BashTool(session),
		new EditTool(session),
		new LspTool(session),
		new EvalTool(session),
		await TaskTool.create(session),
		new LearnTool(session),
		new MemoryRetainTool(session),
		new MemoryEditTool(session),
		new MemoryRecallTool(session),
		new MemoryReflectTool(session),
		new YieldTool(session),
		new AstGrepTool(session),
		new GrepTool(session),
		new GlobTool(session),
	] as AgentTool[];
}

describe("Agent.declaredToolsFingerprint over the built-in tools", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders no tool definition again on a second read while nothing the tools read changed", async () => {
		if (!model) throw new Error("expected the bundled claude-opus-5-5");
		const tools = await renderingTools(toolSession(Settings.isolated()));
		const agent = new Agent({ initialState: { model, systemPrompt: [], tools, messages: [] } });
		const fingerprints = vi.spyOn(appendOnlyContext, "toolSpecsFingerprint");
		const first = agent.declaredToolsFingerprint(model);
		// Precondition: the first read computes the fingerprint.
		expect(fingerprints).toHaveBeenCalledTimes(1);

		const renders = vi.spyOn(prompt, "render");
		expect(agent.declaredToolsFingerprint(model)).toBe(first);
		expect(fingerprints).toHaveBeenCalledTimes(1);
		expect(renders).not.toHaveBeenCalled();
	});

	it("changes when a setting a tool's description reads changes, under the same tools", async () => {
		if (!model) throw new Error("expected the bundled claude-opus-5-5");
		const settings = Settings.isolated();
		const tools = await renderingTools(toolSession(settings));
		const agent = new Agent({ initialState: { model, systemPrompt: [], tools, messages: [] } });
		const bash = tools.find(tool => tool.name === "bash");
		if (!bash) throw new Error("expected bash");
		// Precondition: bash advertises auto-backgrounding, the default.
		expect(cfgBashAutoBackgroundEnabled.get(settings)).toBe(true);
		const before = agent.declaredToolsFingerprint(model);
		const descriptionBefore = bash.description;

		const renders = vi.spyOn(prompt, "render");
		cfgBashAutoBackgroundEnabled.set(settings, false);
		const after = agent.declaredToolsFingerprint(model);

		// Precondition: the agent still holds the same tool objects.
		expect(agent.state.tools).toBe(tools);
		expect(renders).toHaveBeenCalled();
		expect(bash.description).not.toBe(descriptionBefore);
		expect(after).not.toBe(before);
		expect(after).toBe(
			new Agent({
				initialState: { model, systemPrompt: [], tools: await renderingTools(toolSession(settings)), messages: [] },
			}).declaredToolsFingerprint(model),
		);
	});
});
