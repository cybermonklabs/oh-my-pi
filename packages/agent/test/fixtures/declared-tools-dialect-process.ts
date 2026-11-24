/**
 * The child process of `declared-tools-strictness.test.ts`, run as `bun <this file>` with `PI_NO_STRICT` set: the
 * providers read it once, when they load. On claude-opus-5-5 with an `edit` tool (one the Anthropic provider declares
 * as strict unless `PI_NO_STRICT` is set), one agent takes its declared-tools fingerprint on Anthropic's messages API,
 * then under an owned dialect, then on the messages API again; a fresh agent takes it once on each. It writes them to
 * stdout as a {@link DialectSwitchRun}.
 */
import type { Dialect } from "@oh-my-pi/pi-ai/dialect";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Agent } from "../../src/agent";
import type { AgentTool } from "../../src/types";

export interface DialectSwitchRun {
	/** One agent's fingerprints, in order: on the messages API, under the dialect, on the messages API again. */
	switched: string[];
	/** A fresh agent's fingerprint on the messages API, then another fresh agent's under the dialect. */
	fresh: string[];
}

const model = getBundledModel("anthropic", "claude-opus-5-5");
if (!model) throw new Error("expected the bundled claude-opus-5-5");

const edit: AgentTool = {
	name: "edit",
	label: "edit",
	description: "edit tool",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		additionalProperties: false,
	} as unknown as AgentTool["parameters"],
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

function agentUnder(dialect: () => Dialect | undefined): Agent {
	return new Agent({
		initialState: { model, systemPrompt: [], tools: [edit], messages: [] },
		dialectResolver: dialect,
	});
}

let dialect: Dialect | undefined;
const agent = agentUnder(() => dialect);
const switched = [agent.declaredToolsFingerprint(model)];
dialect = "xml";
switched.push(agent.declaredToolsFingerprint(model));
dialect = undefined;
switched.push(agent.declaredToolsFingerprint(model));

const fresh = [
	agentUnder(() => undefined).declaredToolsFingerprint(model),
	agentUnder(() => "xml").declaredToolsFingerprint(model),
];

const run: DialectSwitchRun = { switched, fresh };
process.stdout.write(JSON.stringify(run));
