/**
 * `PI_NO_STRICT` withholds `strict` from every tool definition an `anthropic` request declares, and on an OpenAI API
 * (Responses, chat completions) from each tool the request would otherwise ask strict decoding for. The provider reads
 * it once, when it loads, so it changes between processes: a process that resumes a transcript with it set or unset
 * since sends other tool bytes than the transcript's last request did, and that request reads none of the cache entry.
 * The prompt cache status must say the tools changed, and the resumed process must send its own system prompt from its
 * first request instead of keeping the transcript's for a cache entry it cannot read. Under `PI_NO_STRICT`, Claude
 * Code's experimental-beta kill switch still changes the tool bytes where the endpoint takes `eager_input_streaming`:
 * it takes the flag off every tool. Each process here is a process of its own ({@link ProcessInput}), with
 * `PI_NO_STRICT` set or not.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { gatewayModelsYml, withoutCacheControl } from "./helpers/anthropic-gateway";
import { type GatewayRequest, type OpenAIGatewayApi, openAIGatewayModelsYml } from "./helpers/openai-gateway";
import type { ProcessInput, ProcessRun } from "./fixtures/no-strict-session-process";

const PROCESS = path.join(import.meta.dir, "fixtures/no-strict-session-process.ts");

let processes = 0;

/**
 * Runs one process on `tempDir` with `PI_NO_STRICT` set if `noStrict` and Claude Code's experimental-beta kill switch
 * if `killSwitch`, on `sessionFile` or a new session, on the gateway's `api` or its Anthropic messages API.
 */
async function runProcess(
	tempDir: TempDir,
	inputs: { agentsMd: string; noStrict: boolean; api?: OpenAIGatewayApi; killSwitch?: boolean },
	sessionFile: string | undefined,
	prompts: ProcessInput["prompts"],
): Promise<ProcessRun> {
	const out = tempDir.join(`process-${++processes}.json`);
	const input: ProcessInput = {
		dir: tempDir.path(),
		sessionFile,
		agentsMd: inputs.agentsMd,
		prompts,
		out,
		api: inputs.api,
	};
	const child = Bun.spawn([process.execPath, PROCESS, JSON.stringify(input)], {
		cwd: tempDir.path(),
		env: {
			...process.env,
			PI_TEST_RUNTIME: "1",
			PI_NO_STRICT: inputs.noStrict ? "1" : undefined,
			CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: inputs.killSwitch ? "1" : undefined,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`The process exited with ${exitCode}: ${stderr}`);
	return (await Bun.file(out).json()) as ProcessRun;
}

/** The system prompt `request` sends, on any of the gateway's APIs. */
function systemOf(request: GatewayRequest): string {
	const items = request.input ?? request.messages ?? [];
	return withoutCacheControl([
		request.system,
		request.instructions,
		items.filter(item => item.role === "system" || item.role === "developer"),
	]);
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

describe("a resumed transcript under PI_NO_STRICT whose process turned Claude Code's kill switch on", () => {
	it("reports the tools changed where the endpoint takes eager_input_streaming", async () => {
		using tempDir = TempDir.createSync("@pi-no-strict-tool-digest-");
		// A gateway whose compat takes the per-tool `eager_input_streaming` flag, as api.anthropic.com does.
		const eagerGateway = gatewayModelsYml().replace(
			"supportsLongCacheRetention: true",
			"supportsLongCacheRetention: true\n      supportsEagerToolInputStreaming: true",
		);
		await Bun.write(tempDir.join("models.yml"), eagerGateway);
		const live = await runProcess(tempDir, { agentsMd: "Build with make.", noStrict: true }, undefined, [
			{ text: "first", minute: 0 },
		]);
		const resumed = await runProcess(
			tempDir,
			{ agentsMd: "Build with ninja.", noStrict: true, killSwitch: true },
			live.sessionFile,
			[{ text: "second", minute: 0 }],
		);
		const last = live.requests.at(-1);
		const [first] = resumed.requests;
		if (!last || !first) throw new Error("Expected both processes' requests");
		// Preconditions: no request declares a strict tool, and the switch takes `eager_input_streaming` off every tool.
		const flags = (request: GatewayRequest) =>
			(request.tools ?? []).map(tool => ({
				strict: isRecord(tool) ? tool.strict : undefined,
				eager: isRecord(tool) ? tool.eager_input_streaming : undefined,
			}));
		expect(flags(last)).toEqual([
			{ strict: undefined, eager: true },
			{ strict: undefined, eager: true },
		]);
		expect(flags(first)).toEqual([
			{ strict: undefined, eager: undefined },
			{ strict: undefined, eager: undefined },
		]);

		expect(resumed.status).toMatchObject({ state: "cold", reason: { kind: "tools" } });
		expect(systemOf(first)).toContain("Build with ninja.");
	}, 120_000);
});

describe("a resumed transcript on an OpenAI API whose process set PI_NO_STRICT", () => {
	it.each([
		{ api: "openai-responses", liveNoStrict: false, resumedNoStrict: true },
		{ api: "openai-responses", liveNoStrict: true, resumedNoStrict: false },
		{ api: "openai-responses", liveNoStrict: false, resumedNoStrict: false },
		{ api: "openai-completions", liveNoStrict: false, resumedNoStrict: true },
		{ api: "openai-completions", liveNoStrict: true, resumedNoStrict: false },
		{ api: "openai-completions", liveNoStrict: false, resumedNoStrict: false },
	] satisfies { api: OpenAIGatewayApi; liveNoStrict: boolean; resumedNoStrict: boolean }[])(
		"on $api, PI_NO_STRICT set: $liveNoStrict, then $resumedNoStrict",
		async ({ api, liveNoStrict, resumedNoStrict }) => {
			const toggled = liveNoStrict !== resumedNoStrict;
			using tempDir = TempDir.createSync("@pi-no-strict-tool-digest-");
			await Bun.write(tempDir.join("models.yml"), openAIGatewayModelsYml());
			const live = await runProcess(
				tempDir,
				{ agentsMd: "Build with make.", noStrict: liveNoStrict, api },
				undefined,
				[{ text: "first", minute: 0 }],
			);
			// The resumed process builds another system prompt: it keeps the transcript's only while the cache entry is read.
			const resumed = await runProcess(
				tempDir,
				{ agentsMd: "Build with ninja.", noStrict: resumedNoStrict, api },
				live.sessionFile,
				[{ text: "second", minute: 0 }],
			);
			const last = live.requests.at(-1);
			const [first] = resumed.requests;
			if (!last || !first) throw new Error("Expected both processes' requests");
			// Precondition: PI_NO_STRICT, and nothing else, changes the tool bytes the resumed request sends.
			expect(withoutCacheControl(first.tools) === withoutCacheControl(last.tools)).toBe(!toggled);

			expect(resumed.status).toMatchObject(
				toggled ? { state: "cold", reason: { kind: "tools" } } : { state: "warm" },
			);
			expect(systemOf(first)).toContain(toggled ? "Build with ninja." : "Build with make.");
		},
		120_000,
	);
});
