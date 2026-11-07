/** How aggressively cosmetic motion is suppressed; `strict` also caps the repaint cadence. */
export type ReduceMotionLevel = "off" | "on" | "strict";

// Process-wide mirror of the host's reduce-motion preference. Deliberately a
// leaf module with no imports: the startup prepaint scene (composer, welcome,
// theme) reads it, so pulling a settings graph in here would drag the host's
// discovery/MCP/catalog/session-storage modules in before the first frame.
let activeLevel: ReduceMotionLevel = "off";

/** Select the reduce-motion level. The host pushes its `display.reduceMotion` preference here. */
export function setReduceMotionLevel(level: ReduceMotionLevel): void {
	activeLevel = level;
}

/** Current reduce-motion level. */
export function reduceMotionLevel(): ReduceMotionLevel {
	return activeLevel;
}

/** Whether cosmetic animations must render a single frozen frame. */
export function isReduceMotion(): boolean {
	return activeLevel !== "off";
}
