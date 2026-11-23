/**
 * `providers.kimiApiFormat` sends a Kimi Code model's requests in the API format it names, over the one the model's
 * catalog row resolves. The session's prompt cache decisions read the model a request goes out as, so they must read it
 * in the format the request goes out in. Read in the other one, the declared-tools fingerprint changes under
 * `PI_NO_STRICT` where the tools the request sends do not, or stays where they change, so a process resumed with the
 * variable toggled judges its cache entry on tools its requests do not send; and the warmer replays a turn that went
 * out with a forced tool choice, or drops the entry of one that went out with the default choice.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { NO_STRICT } from "@oh-my-pi/pi-ai/utils/schema/adapt";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { type KimiProcessInput, type KimiProcessRun, runKimiSession } from "./fixtures/kimi-format-setting-process";
import { withoutCacheControl } from "./helpers/anthropic-gateway";

const PROCESS = path.join(import.meta.dir, "fixtures/kimi-format-setting-process.ts");

/** Runs {@link runKimiSession} in a process of its own with `PI_NO_STRICT` set. */
async function runUnderNoStrict(input: KimiProcessInput): Promise<KimiProcessRun> {
	const out = path.join(input.dir, "no-strict-run.json");
	const child = Bun.spawn([process.execPath, PROCESS, JSON.stringify({ ...input, out })], {
		cwd: input.dir,
		env: { ...process.env, PI_TEST_RUNTIME: "1", PI_NO_STRICT: "1" },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`The process exited with ${exitCode}: ${stderr}`);
	return (await Bun.file(out).json()) as KimiProcessRun;
}

/** Whether a request with `toolChoice` goes out with the default tool choice: none named, or `auto`. */
function isDefaultToolChoice(toolChoice: unknown): boolean {
	return toolChoice === undefined || toolChoice === "auto" || (isRecord(toolChoice) && toolChoice.type === "auto");
}

describe("a Kimi Code model whose API format providers.kimiApiFormat overrides", () => {
	it.each([
		{ catalog: "anthropic", setting: "openai" },
		{ catalog: "openai", setting: "anthropic" },
	] satisfies Pick<KimiProcessInput, "catalog" | "setting">[])(
		"reads the $setting API its requests go out on, not the catalog's $catalog one",
		async ({ catalog, setting }) => {
			using dir = TempDir.createSync("@pi-kimi-format-setting-wire-");
			// Precondition: this process runs under default settings.
			expect(NO_STRICT).toBe(false);
			const input: KimiProcessInput = { dir: dir.path(), catalog, setting };
			const defaults = await runKimiSession(input);
			const noStrict = await runUnderNoStrict(input);

			// Preconditions: every request goes out in the format the setting names. `PI_NO_STRICT` changes the tools
			// only on Anthropic's API, which drops `edit`'s strict flag, and a forced tool choice goes out as given there
			// and as `auto` on chat completions.
			expect([...defaults.formats, ...noStrict.formats]).toEqual([setting, setting, setting, setting]);
			const toolsChanged = withoutCacheControl(noStrict.tools) !== withoutCacheControl(defaults.tools);
			expect(toolsChanged).toBe(setting === "anthropic");
			expect(isDefaultToolChoice(defaults.forcedToolChoice)).toBe(setting === "openai");

			// The warmer arms the forced turn exactly when it went out with the default tool choice.
			expect(defaults.armedForced).toBe(isDefaultToolChoice(defaults.forcedToolChoice));
			// The fingerprint changes under `PI_NO_STRICT` exactly where the tools the requests send change.
			expect(noStrict.fingerprint !== defaults.fingerprint).toBe(toolsChanged);
		},
		60_000,
	);
});
