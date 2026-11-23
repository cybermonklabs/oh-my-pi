import "../../src/thread/subagent-worker-entry";
import { parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import { textFormatParsing } from "../../src/thread/text-format-forwarding";

// Announces a parse (the test blocks main on that record), parses one YAML
// document, then parses it again, and reports the value, both durations and
// the parsing state after the first.

const DOCUMENT = "name: busy\nitems: [1, 2, 3]\nnested:\n  ok: true\n";

function run(): void {
	logger.debug("text-format-busy: parsing");
	const started = performance.now();
	const value = Bun.YAML.parse(DOCUMENT);
	const elapsedMs = performance.now() - started;
	const state = textFormatParsing();
	const restarted = performance.now();
	Bun.YAML.parse(DOCUMENT);
	const secondElapsedMs = performance.now() - restarted;
	logger.debug("text-format-busy: done", { document: DOCUMENT, value, elapsedMs, state, secondElapsedMs });
}

// Runs after the entry's own listener handled the init message, so the link is attached.
parentPort?.once("message", () => run());
