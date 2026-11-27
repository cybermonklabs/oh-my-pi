import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runInteractiveBashPty } from "@oh-my-pi/pi-coding-agent/tools/bash-interactive";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { PtySession } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { BELOW_TOOL_SCORE, withBelowToolScore } from "../helpers/oom-score";

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;

/**
 * A UI whose `custom()` mounts the overlay factory against a headless TUI over
 * a virtual terminal and resolves with the value the overlay reports through
 * `done`. Nothing is rendered to a real terminal.
 */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(
		factory: (tui: TUI, uiTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
	): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		await factory(new TUI(new VirtualTerminal(100, 30)), theme, KeybindingsManager.inMemory(), resolve);
		return promise;
	};
	return { custom };
}

const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");

describe("runInteractiveBashPty", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
		initTheme();
		tempDir = TempDir.createSync("@omp-bash-pty-env-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		// The spawn env is filtered `Bun.env` plus procmgr's fixed keys. Those keys
		// and anything set at runtime never reach the native environ the PTY
		// inherits, so the PTY must be handed them.
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-l", "-c"],
			env: {
				PATH: Bun.env.PATH ?? "",
				HOME: tempDir.path(),
				TERM: "dumb",
				// The spawn env carries CI (unless PI_BASH_NO_CI is set) and may carry
				// the launcher's NO_COLOR; either turns tools monochrome and
				// non-interactive on a real terminal.
				CI: "shell-ci",
				NO_COLOR: "shell-no-color",
				// Editor and pinentry guards for commands nobody can answer; a pty
				// call has a user at the keyboard.
				GIT_EDITOR: "shell-git-editor",
				GPG_TTY: "shell-gpg-tty",
				OMP_PTY_RUNTIME_PROBE: "from-shell-env",
				OMP_PTY_LAYER: "shell",
			},
			prefix: undefined,
		});
	});

	afterEach(() => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/** Run the env probe on a real PTY with `direnvEnv` as the command's overrides. */
	async function probe(direnvEnv: Record<string, string>): Promise<string> {
		const result = await runInteractiveBashPty(headlessUi(), {
			command: `printf 'probe=%s layer=%s term=%s ci=%s no_color=%s git_editor=%s gpg_tty=%s\\n' "\${OMP_PTY_RUNTIME_PROBE-unset}" "\${OMP_PTY_LAYER-unset}" "$TERM" "\${CI-unset}" "\${NO_COLOR-unset}" "\${GIT_EDITOR-unset}" "\${GPG_TTY-unset}"`,
			cwd: tempDir.path(),
			timeoutMs: 15_000,
			env: direnvEnv,
		});
		expect(result.exitCode).toBe(0);
		return result.output;
	}

	it.skipIf(ptyUnavailable)(
		"runs the command with the shell spawn env minus its non-interactive guards, direnv overrides on top, and a real TERM",
		async () => {
			const output = await probe({ OMP_PTY_LAYER: "direnv" });

			expect(output).toContain("probe=from-shell-env layer=direnv term=xterm-256color");
			// The native environ underneath may hold its own values for these
			// (CI runners set CI); what must not arrive is the spawn env's value.
			expect(output).not.toContain("shell-ci");
			expect(output).not.toContain("shell-no-color");
			expect(output).not.toContain("shell-git-editor");
			expect(output).not.toContain("shell-gpg-tty");
		},
	);

	it.skipIf(ptyUnavailable)("lets direnv values win over the terminal defaults and the dropped guards", async () => {
		const output = await probe({
			TERM: "direnv-term",
			CI: "direnv-ci",
			NO_COLOR: "direnv-no-color",
			GIT_EDITOR: "direnv-git-editor",
			GPG_TTY: "direnv-gpg-tty",
		});

		expect(output).toContain(
			"term=direnv-term ci=direnv-ci no_color=direnv-no-color git_editor=direnv-git-editor gpg_tty=direnv-gpg-tty",
		);
	});

	// The shell a pty call starts runs with `oom_score_adj` 1000, as every process a tool starts
	// does, so a memory cgroup's OOM killer ends it before Oh My Pi; Oh My Pi's own value stays.
	it.skipIf(ptyUnavailable || !BELOW_TOOL_SCORE)(
		"starts the shell and its child with oom_score_adj 1000 and leaves this process's own value",
		async () => {
			const score = "/proc/self/oom_score_adj";
			await withBelowToolScore(async before => {
				const result = await runInteractiveBashPty(headlessUi(), {
					command: `read -r score < ${score}; printf 'score=%s child=%s\\n' "$score" "$(/bin/cat ${score})"`,
					cwd: tempDir.path(),
					timeoutMs: 15_000,
				});
				expect(result.exitCode).toBe(0);
				expect(result.output).toContain("score=1000 child=1000");
				expect(await Bun.file(score).text()).toBe(before);
			});
		},
	);

	/** `true` as a pty call of a shell whose file is `body`; that file and the call's outcome. */
	async function runInShell(body: string): Promise<{ shell: string; outcome: string }> {
		const shell = path.join(tempDir.path(), "bash");
		fs.writeFileSync(shell, body, { mode: 0o700 });
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell,
			args: ["-l", "-c"],
			env: { PATH: Bun.env.PATH ?? "", HOME: tempDir.path() },
			prefix: undefined,
		});
		const result = await runInteractiveBashPty(headlessUi(), {
			command: "true",
			cwd: tempDir.path(),
			timeoutMs: 15_000,
		});
		return { shell, outcome: result.exitCode === undefined ? result.output.trim() : `ran: ${result.exitCode}` };
	}

	// Failure mode: a shell that cannot start (a script whose `#!` interpreter is missing, a file without
	// `#!` that the kernel cannot load) is reported as a command that ran and exited 127, or runs as shell
	// code. The pty call must report what the PTY spawner reports for the shell itself.
	it.skipIf(ptyUnavailable || process.platform !== "linux")(
		"reports a shell that cannot exec as its spawn does",
		async () => {
			for (const body of ["#!/nonexistent/interpreter\n", "echo ran as shell code\n"]) {
				const { shell, outcome } = await runInShell(body);
				const session = new PtySession();
				const start = session.startArgv({ application: shell, args: ["-lc", "true"], cwd: tempDir.path() });
				const direct = await start.then(
					result => `ran: ${result.exitCode}`,
					(error: Error) => `PTY error: ${error.message}`,
				);
				expect(outcome).toBe(direct);
			}
		},
	);

	// Failure mode: a shell that starts and exits 127 is taken for one that could not start.
	it.skipIf(ptyUnavailable || process.platform !== "linux")(
		"reports a shell that exits 127 as a command that ran",
		async () => {
			expect((await runInShell("#!/bin/sh\nexit 127\n")).outcome).toBe("ran: 127");
		},
	);
});
