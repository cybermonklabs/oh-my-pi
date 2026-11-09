import { register } from "../config/registry";

export const cfgMemorySampleEnabled = register({
	id: "memorySample.enabled",
	type: "boolean",
	default: true,
	ui: {
		tab: "tools",
		group: "Developer",
		label: "Memory self-report",
		description:
			"Record this session's memory, its box's cgroup limit and its work counters to the session journal, so the record survives the process being killed",
	},
});

export const cfgMemorySampleIntervalMs = register({
	id: "memorySample.intervalMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tools",
		group: "Developer",
		label: "Memory sample interval (ms)",
		description:
			"How often a sample is taken when no turn or compaction asks for one. 0 keeps only the event-driven samples, which leaves a long turn unrecorded",
	},
});
