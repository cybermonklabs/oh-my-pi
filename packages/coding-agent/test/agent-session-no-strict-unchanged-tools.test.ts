/**
 * The `anthropic` provider declares a tool as strict only when it is on its strict allowlist (`python`, `edit`, `find`,
 * `yield`) and its schema can be made strict; `PI_NO_STRICT` takes `strict` off those tools alone. A transcript whose
 * tools include none of them declares the same tool bytes with `PI_NO_STRICT` set or not, so a process that resumes it
 * with the variable toggled reads the whole cache entry the transcript's last request left. Its prompt cache status
 * must say so, and it must keep sending the transcript's stored system prompt rather than its own build: judged as if
 * the tools had changed, the entry looks unreadable, the hold is released, and the process's own build goes
 * out, which writes the whole cached prompt again. Each process here is a process of its own ({@link ProcessInput}),
 * with `PI_NO_STRICT` set or not.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { ProcessInput, ProcessRun } from "./fixtures/no-strict-session-process";
import { gatewayModelsYml, withoutCacheControl } from "./helpers/anthropic-gateway";

const PROCESS = path.join(import.meta.dir, "fixtures/no-strict-session-process.ts");

/** Tools the `anthropic` provider never declares as strict: neither is on its strict allowlist. */
const TOOLS = ["read", "bash"];

let processes = 0;

/** Runs one process on `tempDir` with `PI_NO_STRICT` set if `noStrict`, on `sessionFile` or a new session. */
async function runProcess(
	tempDir: TempDir,
	inputs: { agentsMd: string; noStrict: boolean },
	sessionFile: string | undefined,
	prompt: string,
): Promise<ProcessRun> {
	const out = tempDir.join(`process-${++processes}.json`);
	const input: ProcessInput = {
		dir: tempDir.path(),
		sessionFile,
		agentsMd: inputs.agentsMd,
		prompts: [{ text: prompt, minute: 0 }],
		out,
		toolNames: TOOLS,
	};
	const child = Bun.spawn([process.execPath, PROCESS, JSON.stringify(input)], {
		cwd: tempDir.path(),
		env: { ...process.env, PI_TEST_RUNTIME: "1", PI_NO_STRICT: inputs.noStrict ? "1" : undefined },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`The process exited with ${exitCode}: ${stderr}`);
	return (await Bun.file(out).json()) as ProcessRun;
}

describe("a resumed transcript with no tool the provider declares as strict, PI_NO_STRICT toggled", () => {
	it.each([{ noStrict: false }, { noStrict: true }])(
		"reads the cache entry and keeps the transcript's system prompt, PI_NO_STRICT set on resume: $noStrict",
		async ({ noStrict }) => {
			using tempDir = TempDir.createSync("@pi-no-strict-unchanged-tools-");
			await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
			const live = await runProcess(tempDir, { agentsMd: "Build with make.", noStrict: false }, undefined, "first");
			// The context file changed while no process ran: the resumed process's own build differs.
			const resumed = await runProcess(
				tempDir,
				{ agentsMd: "Build with ninja.", noStrict },
				live.sessionFile,
				"second",
			);
			const last = live.requests.at(-1);
			const [first] = resumed.requests;
			if (!last || !first) throw new Error("Expected both processes' requests");
			// Preconditions: no request declares a strict tool, so the resumed request declares the transcript's tool
			// bytes whether PI_NO_STRICT is set or not; the transcript's last request sent the first build.
			expect((first.tools ?? []).some(tool => isRecord(tool) && tool.strict === true)).toBe(false);
			expect(withoutCacheControl(first.tools)).toBe(withoutCacheControl(last.tools));
			expect(withoutCacheControl(last.system)).toContain("Build with make.");

			// The entry the transcript left is one the resumed request reads, and that request sends its prompt.
			expect(resumed.status).toMatchObject({ state: "warm" });
			expect(withoutCacheControl(first.system)).toBe(withoutCacheControl(last.system));
		},
		120_000,
	);
});
