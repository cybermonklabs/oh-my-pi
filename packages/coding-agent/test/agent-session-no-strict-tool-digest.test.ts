/**
 * `PI_NO_STRICT` withholds `strict` from every tool definition an `anthropic` request declares. The provider reads it
 * once, when it loads, so it changes between processes: a process that resumes a transcript with it set or unset since
 * sends other tool bytes than the transcript's last request did, and that request reads none of the cache entry. The
 * prompt cache status must say the tools changed, and the resumed process must send its own system prompt from its
 * first request instead of keeping the transcript's for a cache entry it cannot read. Each process here is a process of
 * its own ({@link ProcessInput}), with `PI_NO_STRICT` set or not.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { gatewayModelsYml, withoutCacheControl } from "./helpers/anthropic-gateway";
import type { ProcessInput, ProcessRun } from "./fixtures/no-strict-session-process";

const PROCESS = path.join(import.meta.dir, "fixtures/no-strict-session-process.ts");

let processes = 0;

/** Runs one process on `tempDir` with `PI_NO_STRICT` set if `noStrict`, on `sessionFile` or a new session. */
async function runProcess(
	tempDir: TempDir,
	inputs: { agentsMd: string; noStrict: boolean },
	sessionFile: string | undefined,
	prompts: ProcessInput["prompts"],
): Promise<ProcessRun> {
	const out = tempDir.join(`process-${++processes}.json`);
	const input: ProcessInput = { dir: tempDir.path(), sessionFile, agentsMd: inputs.agentsMd, prompts, out };
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

describe("a resumed transcript whose process set PI_NO_STRICT", () => {
	it.each([
		{ noStrict: true, state: "cold", sameTools: false },
		{ noStrict: false, state: "warm", sameTools: true },
	])(
		"reports the cache $state on resume with PI_NO_STRICT set: $noStrict",
		async ({ noStrict, state, sameTools }) => {
			using tempDir = TempDir.createSync("@pi-no-strict-tool-digest-");
			await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
			const inputs = { agentsMd: "Build with make.", noStrict: false };
			const live = await runProcess(tempDir, inputs, undefined, [{ text: "first", minute: 0 }]);
			const resumed = await runProcess(tempDir, { ...inputs, noStrict }, live.sessionFile, [
				{ text: "second", minute: 0 },
			]);
			const last = live.requests.at(-1);
			const [first] = resumed.requests;
			if (!last || !first) throw new Error("Expected both processes' requests");
			// Precondition: PI_NO_STRICT, and nothing else, changes the tool bytes the resumed request sends.
			expect(withoutCacheControl(first.tools) === withoutCacheControl(last.tools)).toBe(sameTools);

			expect(resumed.status).toMatchObject(noStrict ? { state, reason: { kind: "tools" } } : { state });
		},
		120_000,
	);

	it("writes the cached prompt once when the resumed process also changed the context file", async () => {
		using tempDir = TempDir.createSync("@pi-no-strict-tool-digest-");
		await Bun.write(tempDir.join("models.yml"), gatewayModelsYml());
		const live = await runProcess(tempDir, { agentsMd: "Build with make.", noStrict: false }, undefined, [
			{ text: "first", minute: 0 },
		]);
		// The resumed process sends a prompt every minute, which keeps the one-hour entry warm.
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", noStrict: true },
			live.sessionFile,
			Array.from({ length: 6 }, (_, minute) => ({ text: `a call at minute ${minute}`, minute })),
		);

		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		// Precondition: under PI_NO_STRICT the first resumed request sends other tool bytes, so it reads none of the entry.
		expect(withoutCacheControl(first.tools)).not.toBe(withoutCacheControl(last.tools));
		// Requests whose tool definitions or system prompt, sent in that order before the messages, differ from the
		// request before them: each one writes the whole cached conversation.
		let previous = last;
		let rewrites = 0;
		for (const request of resumed.requests) {
			const sentBefore = withoutCacheControl([previous.tools, previous.system]);
			if (withoutCacheControl([request.tools, request.system]) !== sentBefore) rewrites++;
			previous = request;
		}
		expect(withoutCacheControl(resumed.requests.at(-1)?.system)).toContain("Build with ninja.");
		expect(rewrites).toBe(1);
	}, 120_000);
});
