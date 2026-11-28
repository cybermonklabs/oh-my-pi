import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { createTtsSubprocess } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { BELOW_TOOL_SCORE, BELOW_TOOL_SCORE_TIMEOUT_MS, belowToolScore } from "./helpers/oom-score";

// Each process Oh My Pi starts for the bash or eval tool runs with `oom_score_adj` 1000, so a
// memory cgroup's OOM killer ends it before Oh My Pi. The paths the upstream port also has are
// tested next to their code (bash-executor, shell-snapshot, eval/kernel-spawn,
// eval/js-package-environment, utils/ptree-env), as are the release's own direnv and pty
// shell (direnv, tools/bash-interactive); these are the embedded shell's external and a worker
// that is no tool's process.

const SCORE = "/proc/self/oom_score_adj";

describe.skipIf(!BELOW_TOOL_SCORE)("tool processes run with oom_score_adj 1000", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = TempDir.createSync("@omp-tool-oom-score-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: dir.path() });
	});

	afterEach(() => {
		resetSettingsForTest();
		dir.removeSync();
	});

	// The embedded shell's external command: the native spawn's vfork child.
	const EXTERNAL_SCORE = "a program a bash tool command runs";
	it(
		EXTERNAL_SCORE,
		async () => {
			await belowToolScore(import.meta.path, EXTERNAL_SCORE, async before => {
				const result = await executeBash(`/bin/cat ${SCORE}`, { cwd: dir.path(), timeout: 10_000 });
				expect(result.exitCode).toBe(0);
				expect(result.output.trim()).toBe("1000");
				expect(await Bun.file(SCORE).text()).toBe(before);
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: a worker that is no tool's process (here the TTS worker) starts at 1000 too, so
	// the kernel would end it before tool processes; it keeps Oh My Pi's value.
	const WORKER_SCORE = "leaves an inference worker at this process's value";
	it(
		WORKER_SCORE,
		async () => {
			await belowToolScore(import.meta.path, WORKER_SCORE, async before => {
				const spawned = createTtsSubprocess();
				try {
					const pong = Promise.withResolvers<void>();
					spawned.inbound.add(message => {
						if (message.type === "pong") pong.resolve();
					});
					spawned.errors.add(pong.reject);
					spawned.proc.send({ type: "ping", id: "oom-score" });
					await pong.promise;
					expect(await Bun.file(`/proc/${spawned.proc.pid}/oom_score_adj`).text()).toBe(before);
				} finally {
					spawned.intentionalExit.value = true;
					spawned.proc.kill("SIGKILL");
					await spawned.proc.exited;
				}
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);
});
