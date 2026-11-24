import { describe, expect, it } from "bun:test";
import { TEXT_FORMAT_FORWARD_TIMEOUT_MS } from "../../src/thread/text-format-forwarding";
import { useWorkerTests } from "./worker-test-helpers";

/** How long the busy-main test blocks the main thread. */
const MAIN_BUSY_MS = 2500;

/** Main's own parse of a document of each format the closed-link worker reports. */
const LOCAL_PARSES: Readonly<Record<string, (document: string) => unknown>> = {
	YAML: document => Bun.YAML.parse(document),
	TOML: document => Bun.TOML.parse(document),
	JSONC: document => Bun.JSONC.parse(document),
	JSON5: document => Bun.JSON5.parse(document),
	XML: document => Bun.XML.parse(document),
};

/** One parse the closed-link worker reports: what it gave, and how long it took. */
interface ClosedLinkParse {
	format: string;
	document: string;
	outcome: unknown;
	elapsedMs: number;
}

const { startWorker, nextRecord } = useWorkerTests();

describe("subagent worker text-format parsing", () => {
	it("gives the same value or the same error as a local parse, and parses a TOML date locally", async () => {
		// If this regresses, settings, skills or agents load differently in subagents on
		// worker threads than on the main thread.
		const done = nextRecord("text-format-parity: done");
		const worker = startWorker({ entry: new URL("../fixtures/text-format-parity-worker.ts", import.meta.url) });
		await worker.ready;
		const { context } = await done;
		expect({ states: context?.states, rows: context?.rows }).toEqual({
			// Still forwarding after every forwarded document: none of them ran a local parse.
			states: ["forwarding", "local"],
			rows: [
				["YAML", "value", "same"],
				["YAML malformed", "SyntaxError", "same"],
				["TOML from bytes", "value", "same"],
				["TOML integer past 2^53", "SyntaxError", "same"],
				["JSONC", "value", "same"],
				["JSONC malformed", "SyntaxError", "same"],
				["JSON5", "value", "same"],
				["JSON5 malformed", "SyntaxError", "same"],
				["XML", "value", "same"],
				["XML compact: false", "value", "same"],
				["XML malformed", "SyntaxError", "same"],
				["TOML with dates", "value", "same"],
			],
		});
	}, 30_000);

	it("parses locally after one timeout while the main thread is blocked, then without waiting", async () => {
		// If this regresses, a subagent worker hangs, or fails a parse, while the main thread is busy.
		const done = nextRecord("text-format-busy: done", event => {
			if (event.message === "text-format-busy: parsing") Bun.sleepSync(MAIN_BUSY_MS);
		});
		const worker = startWorker({ entry: new URL("../fixtures/text-format-busy-main-worker.ts", import.meta.url) });
		await worker.ready;
		const { context } = await done;
		expect(context?.value).toEqual(Bun.YAML.parse(String(context?.document)));
		expect(context?.state).toBe("local");
		const elapsedMs = Number(context?.elapsedMs);
		expect(elapsedMs).toBeGreaterThanOrEqual(TEXT_FORMAT_FORWARD_TIMEOUT_MS);
		expect(elapsedMs).toBeLessThan(MAIN_BUSY_MS - 500);
		expect(Number(context?.secondElapsedMs)).toBeLessThan(TEXT_FORMAT_FORWARD_TIMEOUT_MS / 10);
	}, 30_000);

	it("parses locally once the link is closed", async () => {
		// If this regresses, a subagent worker whose link closed fails every config or frontmatter parse.
		const done = nextRecord("text-format-closed: done");
		// The fixture closes its end of the link before main's boot call reaches it, so the worker never reports ready.
		startWorker({ entry: new URL("../fixtures/text-format-closed-link-worker.ts", import.meta.url) });
		const { context } = await done;
		expect(context?.states).toEqual(["forwarding", "local"]);
		const rows = context?.rows as ClosedLinkParse[] | undefined;
		expect(rows?.map(row => row.format)).toEqual(Object.keys(LOCAL_PARSES));
		for (const { format, document, outcome, elapsedMs } of rows ?? []) {
			expect(outcome).toEqual({ value: LOCAL_PARSES[format](document) });
			expect(elapsedMs).toBeLessThan(TEXT_FORMAT_FORWARD_TIMEOUT_MS / 10);
		}
	}, 30_000);
});
