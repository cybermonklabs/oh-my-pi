import "../../src/thread/subagent-worker-entry";
import { parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { textFormatThreadService } from "../../src/thread/services/text-format";
import { textFormatParsing } from "../../src/thread/text-format-forwarding";

// Keeps the link the entry gives the `textFormat` service, closes it once the
// forwarders hold it, then parses one document of each format, timing each
// parse, and reports what each gave and the parsing state before and after.

const DOCUMENTS: ReadonlyArray<readonly [format: string, document: string, parse: (document: string) => unknown]> = [
	["YAML", "name: closed\nitems: [1, 2]\nnested:\n  ok: true\n", document => Bun.YAML.parse(document)],
	["TOML", 'title = "closed"\n[owner]\nname = "omp"\ntags = ["a", "b"]\n', document => Bun.TOML.parse(document)],
	["JSONC", '{\n  // line\n  "a": [1, 2,],\n  "b": { "c": true, },\n}', document => Bun.JSONC.parse(document)],
	["JSON5", "{ a: 1, b: 'two', hex: 0xFF, }", document => Bun.JSON5.parse(document)],
	["XML", '<root id="1"><item>1</item><item>2</item></root>', document => Bun.XML.parse(document)],
];

let workerLink: WorkerThreadLink | undefined;
const installWorker = textFormatThreadService.installWorker?.bind(textFormatThreadService);
textFormatThreadService.installWorker = link => {
	workerLink = link;
	installWorker?.(link);
};

function attempt(parse: () => unknown): { value: unknown } | { error: string } {
	try {
		return { value: parse() };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

function run(): void {
	if (!workerLink) throw new Error("The worker entry gave the textFormat service no link");
	workerLink.close("text-format-closed: closed by the fixture");
	const before = textFormatParsing();
	const rows = DOCUMENTS.map(([format, document, parse]) => {
		const started = performance.now();
		const outcome = attempt(() => parse(document));
		return { format, document, outcome, elapsedMs: performance.now() - started };
	});
	logger.debug("text-format-closed: done", { states: [before, textFormatParsing()], rows });
}

// Runs after the entry's own listener handled the init message, so the link is attached.
parentPort?.once("message", () => run());
