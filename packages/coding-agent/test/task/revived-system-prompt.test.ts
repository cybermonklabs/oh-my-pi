/**
 * A subagent that parks holding a settings change stores the build that goes out with the change as its prompt, and
 * beside it the base the change was withheld from, with each held setting's value that base was built with. A cold
 * revive sends the base only while every held setting has that value again: a change set back while the session was
 * parked. Any other settings keep the stored build.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { PersistedSessionInit } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { revivedSystemPrompt } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";

const BUILD = ["prompt that lists grep, and scout as disabled"];
const BASE = ["prompt the session sent before the change"];

function parkedInit(settings: { id: string; value?: unknown }[]): PersistedSessionInit {
	return {
		systemPrompt: BUILD,
		task: "task",
		tools: ["read", "grep"],
		heldChangeBase: { systemPrompt: BASE, settings },
	};
}

const HELD = [
	{ id: "grep.enabled", value: false },
	{ id: "task.disabledAgents", value: [] },
];

describe("the prompt a cold revive sends", () => {
	it("is the stored build when the session parked holding no settings change", () => {
		const init: PersistedSessionInit = { systemPrompt: BUILD, task: "task", tools: ["read"] };
		expect(revivedSystemPrompt(init, Settings.isolated({}))).toBe(BUILD);
	});

	it("is the base once every setting the change held has the value the base was built with again", () => {
		const settings = Settings.isolated({ "grep.enabled": false, "task.disabledAgents": [] });
		expect(revivedSystemPrompt(parkedInit(HELD), settings)).toBe(BASE);
	});

	it("is the stored build while the change stands", () => {
		const settings = Settings.isolated({ "grep.enabled": true, "task.disabledAgents": ["scout"] });
		expect(revivedSystemPrompt(parkedInit(HELD), settings)).toBe(BUILD);
	});

	it("is the stored build while any one setting the change held keeps its new value", () => {
		const settings = Settings.isolated({ "grep.enabled": false, "task.disabledAgents": ["scout"] });
		expect(revivedSystemPrompt(parkedInit(HELD), settings)).toBe(BUILD);
	});

	it("is the stored build when the change held a setting this process does not know", () => {
		const settings = Settings.isolated({ "grep.enabled": false });
		const init = parkedInit([
			{ id: "grep.enabled", value: false },
			{ id: "no.such.setting", value: 1 },
		]);
		expect(revivedSystemPrompt(init, settings)).toBe(BUILD);
	});
});
