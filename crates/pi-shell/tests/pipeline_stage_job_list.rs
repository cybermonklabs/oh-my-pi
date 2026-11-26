//! A pipeline stage that is a simple command keeps its shell's job list
//! while it expands its words, as bash's stage does: bash forks the stage
//! first and expands the command's words in the child, which drops the
//! list (`without_job_control`) only as it runs a builtin other than `jobs`,
//! or a function (`execute_cmd.c`, `execute_subshell_builtin_or_function`).
//! So `echo "$(jobs)" | cat`, `kill "$(jobs -p)" | cat` and
//! `cat <(jobs) | cat` see the jobs, while `kill %1 | cat` finds none.
//! Each row's output is bash 5.3.20's for `bash -c` and from a script file,
//! measured; a job listed as running is a `sleep 30` the row then ends with
//! `kill` (a SIGTERM bash does not report), and a finished one's end is
//! waited for with `kill -0`, so the rows need no timing.
#![cfg(target_os = "linux")]

mod obash_support;

/// A row whose standard output bash 5.3.20 gives through `-c` (`out`) and
/// from a script file (`file`); its standard error is `err` both ways, with
/// each line's shell-name prefix `…: line 1: ` and each `(PID)` taken out;
/// its status is 0.
struct Both {
	name:   &'static str,
	script: &'static str,
	out:    &'static str,
	file:   &'static str,
	err:    &'static str,
}

/// How a row's script reaches obash: as `obash -c script`, or as a file
/// (`row.sh` in the row's directory) that `obash row.sh` reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Via {
	Command,
	File,
}

/// `text` with each line's shell-name prefix (`…: line 1: `) dropped and
/// every parenthesised number read as `(PID)`.
fn normalised(text: &str) -> String {
	let mut out = String::new();
	for line in text.lines() {
		let line = line.split_once(": line 1: ").map_or(line, |(_, rest)| rest);
		let mut rest = line;
		while let Some(open) = rest.find('(') {
			out.push_str(&rest[..=open]);
			rest = &rest[open + 1..];
			let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
			if digits > 0 && rest[digits..].starts_with(')') {
				out.push_str("PID");
				rest = &rest[digits..];
			}
		}
		out.push_str(rest);
		out.push('\n');
	}
	out
}

/// `script` through obash as `via` says, in a directory of its own: its
/// status, its output and its error text ([`normalised`]).
fn run(script: &str, via: Via) -> (Option<i32>, String, String) {
	let dir = tempfile::tempdir().unwrap();
	let mut cmd = obash_support::obash();
	match via {
		Via::Command => cmd.args(["-c", script]),
		Via::File => {
			std::fs::write(dir.path().join("row.sh"), script).unwrap();
			cmd.arg("row.sh")
		},
	};
	let result = obash_support::output(cmd.current_dir(dir.path()));
	let out = String::from_utf8_lossy(&result.stdout).into_owned();
	(result.status.code(), out, normalised(&String::from_utf8_lossy(&result.stderr)))
}

/// Runs each row through `obash -c` and from a script file, and fails with
/// every run whose status (0), output or error text differs from bash's,
/// each as a line `NAME: `, or `NAME (file): `, and the script. A run that
/// does not end within `obash_support`'s bound (its panic) is a difference
/// of its row too, and the rows before and after it keep theirs; after
/// [`HUNG`] such runs the test runs no more of them (each costs the bound)
/// and names each it did not run.
fn assert_both(rows: &[Both]) {
	let mut found = Vec::new();
	let mut hung = 0;
	for via in [Via::Command, Via::File] {
		for row in rows {
			let want = if via == Via::File { row.file } else { row.out };
			let how = if via == Via::File { " (file)" } else { "" };
			if hung >= HUNG {
				found.push(format!(
					"{}{how}: `{}`\n  not run: {HUNG} runs did not end",
					row.name, row.script
				));
				continue;
			}
			let (status, got, got_err) = match std::panic::catch_unwind(|| run(row.script, via)) {
				Ok(ran) => ran,
				Err(panic) => {
					hung += 1;
					let why = panic
						.downcast_ref::<String>()
						.map(String::as_str)
						.or_else(|| panic.downcast_ref::<&str>().copied())
						.unwrap_or("panicked");
					found.push(format!(
						"{}{how}: `{}`\n  bash: Some(0) {want:?} {:?}\n  omp:  {why}",
						row.name, row.script, row.err
					));
					continue;
				},
			};
			if (status, got.as_str(), got_err.as_str()) != (Some(0), want, row.err) {
				found.push(format!(
					"{}{how}: `{}`\n  bash: Some(0) {want:?} {:?}\n  omp:  {status:?} {got:?} \
					 {got_err:?}",
					row.name, row.script, row.err
				));
			}
		}
	}
	assert!(
		found.is_empty(),
		"{} of {} runs differ from bash:\n{}",
		found.len(),
		2 * rows.len(),
		found.join("\n")
	);
}

/// The runs that may hit `obash_support`'s bound before [`assert_both`]
/// stops running rows: a test that hangs on every row would otherwise take
/// the bound once per row.
const HUNG: usize = 2;

/// A pipeline stage that is a simple command expands its words with its
/// shell's job list: bash forks the stage and expands the words in the
/// child, which drops the list only as it runs the command. A command or
/// process substitution in a word lists the running job, in the first, a
/// middle or the last stage, in a function's argument, an assignment word,
/// after a leading redirection, under `!`, in a background pipeline, after
/// `command` or `exec`, for an external command, in a `lastpipe` stage's
/// pipeline, in posix mode and under `pipefail`; a job spec a substitution
/// gives `jobs` or `kill` names it; a substitution in an external's
/// redirection lists it too.
#[test]
fn a_stage_s_words_see_the_job_list() {
	assert_both(&[
		Both {
			name:   "running",
			script: r#"sleep 30 & echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "running-in-a-function-substitution",
			script: r#"y=${ sleep 30 & echo "[$(jobs)]" | cat; kill %1; }; echo "$y"; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "count-in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; echo | { sleep 30 & echo "n=$(jobs -p | wc -l)" | cat; kill $!; }; echo end"#,
			out:    "n=1\nend\n",
			file:   "n=1\nend\n",
			err:    "",
		},
		Both {
			name:   "count",
			script: r#"sleep 30 & echo "n=$(jobs -p | wc -l)" | cat; kill %1; echo end"#,
			out:    "n=1\nend\n",
			file:   "n=1\nend\n",
			err:    "",
		},
		Both {
			name:   "first-stage",
			script: r#"sleep 30 & echo "[$(jobs)]" | cat | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "middle-stage",
			script: r#"sleep 30 & : | echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "last-stage",
			script: r#"sleep 30 & : | echo "[$(jobs)]"; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "process-substitution",
			script: "sleep 30 & cat <(jobs) | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "a-function-s-argument",
			script: r#"f() { echo "[$1]"; }; sleep 30 & f "$(jobs)" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "an-assignment-word",
			script: r#"sleep 30 & x=$(jobs -p | wc -l) sh -c 'echo "n=$x"' | cat; kill %1; echo end"#,
			out:    "n=1\nend\n",
			file:   "n=1\nend\n",
			err:    "",
		},
		Both {
			name:   "after-a-redirection",
			script: r#"sleep 30 & 2>/dev/null echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "under-not",
			script: r#"sleep 30 & ! echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-background-pipeline",
			script: r#"sleep 30 & echo "[$(jobs)]" | cat & wait $!; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "after-command",
			script: r#"sleep 30 & command echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "after-exec",
			script: r#"sleep 30 & exec echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "an-external-s-word",
			script: r#"sleep 30 & /bin/echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-stage-in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; sleep 30 & echo | { echo "[$(jobs)]" | cat; }; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "posix-mode",
			script: r#"set -o posix; sleep 30 & echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "pipefail",
			script: r#"set -o pipefail; sleep 30 & echo "[$(jobs)]" | cat; kill %1; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "two-substitutions",
			script: r#"sleep 30 & echo "$(jobs -p | wc -l) $(jobs | wc -l)" | cat; kill %1; echo end"#,
			out:    "1 1\nend\n",
			file:   "1 1\nend\n",
			err:    "",
		},
		Both {
			name:   "a-process-and-a-command-substitution",
			script: r#"sleep 30 & cat <(jobs) - <<< "$(jobs -p | wc -l)" | cat; kill %1; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\n1\nend\n",
			file:   "[1]+  Running                    sleep 30 &\n1\nend\n",
			err:    "",
		},
		Both {
			name:   "a-job-spec-for-jobs",
			script: r#"sleep 30 & jobs "$(jobs -p >/dev/null; echo %1)" | cat; kill %1; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "a-pid-for-kill",
			script: r#"sleep 30 & kill "$(jobs -p)" | cat; wait; echo "w=$?"; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "",
		},
		Both {
			name:   "an-external-s-redirection",
			script: r#"sleep 30 & /bin/echo x > "$(jobs >&2; echo /dev/null)" | cat; kill %1; echo end"#,
			out:    "end\n",
			file:   "end\n",
			err:    "[1]+  Running                    sleep 30 &\n",
		},
	]);
}

/// The finished jobs a substitution in a stage's words lists are those a
/// substitution of the shell itself would list: from a `-c` shell none that
/// it would not report (bash drops them as the stage's child re-parses the
/// substitution), from a script file every one, and in a `lastpipe` stage
/// or a function substitution, where no job may be deleted, every one, the
/// foreground jobs kept there hidden.
#[test]
fn a_stage_s_words_see_its_shell_s_finished_jobs() {
	assert_both(&[
		Both {
			name:   "finished",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "$(jobs)" | cat;echo end"#,
			out:    "\nend\n",
			file:   "[2]   Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "finished-in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; echo | { /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "$(jobs)" | cat; }; echo end"#,
			out:    "[2]-  Done                       /bin/true\n[3]+  Done                       /bin/true\nend\n",
			file:   "[2]-  Done                       /bin/true\n[3]+  Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "finished-in-a-function-substitution",
			script: r#"y=${ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "$(jobs)" | cat; }; echo "$y"; echo end"#,
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\nend\n",
			file:   "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "an-exit-status",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "[$(jobs)]" | cat; echo end"#,
			out:    "[]\nend\n",
			file:   "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Both {
			name:   "an-exit-status-in-posix-mode",
			script: r#"set -o posix; /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "[$(jobs)]" | cat; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			file:   "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Both {
			name:   "an-exit-status-in-a-function-substitution",
			script: r#"y=${ /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "[$(jobs)]" | cat; }; echo "$y"; echo end"#,
			out:    "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true]\nend\n",
			file:   "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true]\nend\n",
			err:    "",
		},
		Both {
			name:   "the-stage-then-the-shell",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo "[$(jobs)]" | cat; echo "<$(jobs)>"; jobs; echo end"#,
			out:    "[]\n<[2]   Done                       /bin/true>\n[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\nend\n",
			file:   "[[2]   Done                       /bin/true]\n<[2]   Done                       /bin/true>\n[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "a-kept-foreground-job-hidden",
			script: r#"y=${ /bin/true; sleep 30 & echo "[$(jobs)]" | cat; kill $!; }; echo "$y"; echo end"#,
			out:    "[[2]+  Running                    sleep 30 &]\nend\n",
			file:   "[[2]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "no-notice-before-an-external",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; /bin/echo "[$(:)]" | cat; echo end"#,
			out:    "[]\nend\n",
			file:   "[]\nend\n",
			err:    "",
		},
		Both {
			name:   "finished-for-an-external",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; /bin/echo "[$(jobs)]" | cat; echo end"#,
			out:    "[]\nend\n",
			file:   "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
	]);
}

/// A job spec in a stage's substitution names its shell's job: `kill %1`
/// signals it (0), and `wait %1` finds it but not as a child of the
/// substitution, so it returns bash's `-1` at once.
#[test]
fn a_job_spec_in_a_stage_s_words_names_the_job() {
	assert_both(&[
		Both {
			name:   "wait",
			script: r#"sleep 30 & echo "[$(wait %1; echo w=$?)]" | cat; kill %1; echo end"#,
			out:    "[w=-1]\nend\n",
			file:   "[w=-1]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill",
			script: r#"sleep 30 & echo "[$(kill %1; echo k=$?)]" | cat; wait; echo "w=$?"; echo end"#,
			out:    "[k=0]\nw=0\nend\n",
			file:   "[k=0]\nw=0\nend\n",
			err:    "",
		},
	]);
}

/// The stage drops the list before it runs a builtin other than `jobs`, or
/// a function (bash's `execute_subshell_builtin_or_function`:
/// `without_job_control`, but `kill_current_pipeline` for `jobs`): `kill
/// %1`, `wait %1` and `disown %1` find no job there, also when a
/// substitution in the stage's words gave the stage the list (`kill %1
/// "$(:)"`, `builtin kill …`, a function given `"$(:)"`, `x=$(:) builtin
/// jobs`), `jobs %1` and `command jobs` do (bash runs the `jobs` builtin
/// there), also as `command -p jobs`, `command -- jobs`, `command command
/// jobs` or `command 'jobs'`, past a function named `jobs`, after a prefix
/// redirection or assignment, by a name its expansion gives (`$j`, `$c
/// jobs`), and with a redirection, which bash makes after the drop. A
/// function lists none, `builtin jobs` lists none with a redirection or
/// without, `command kill` with a redirection finds none, and a
/// substitution in a builtin's redirection sees none. A compound command
/// stage (`for`, `while`, `if`) has no list from the start
/// (`execute_in_subshell`), nor has an assignment-only stage's value.
#[test]
fn a_stage_drops_the_list_before_a_builtin_or_function() {
	assert_both(&[
		Both {
			name:   "kill-finds-none",
			script: "sleep 30 & kill %1 | cat; jobs; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "kill: %1: no such job\n",
		},
		Both {
			name:   "kill-with-a-substitution-finds-none",
			script: r#"sleep 30 & kill %1 "$(:)" | cat; jobs; kill %1 2>/dev/null; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "kill: %1: no such job\nkill: `': not a pid or valid job spec\n",
		},
		Both {
			name:   "builtin-kill-with-a-substitution-finds-none",
			script: r#"sleep 30 & builtin kill %1 "$(:)" | cat; jobs; kill %1 2>/dev/null; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "kill: %1: no such job\nkill: `': not a pid or valid job spec\n",
		},
		Both {
			name:   "wait-with-a-substitution-finds-none",
			script: r#"sleep 30 & wait %1 "$(:)" | cat; echo "w=$?"; kill %1; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "wait: %1: no such job\nwait: `': not a pid or valid job spec\n",
		},
		Both {
			name:   "a-function-with-a-substitution-lists-none",
			script: r#"f() { jobs; echo "n=$#"; }; sleep 30 & f "$(:)" | cat; kill %1; echo end"#,
			out:    "n=1\nend\n",
			file:   "n=1\nend\n",
			err:    "",
		},
		Both {
			name:   "builtin-jobs-with-an-assignment-substitution-lists-none",
			script: "sleep 30 & x=$(:) builtin jobs | cat; kill %1; echo end",
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "kill-with-a-redirection-finds-none",
			script: r#"sleep 30 & kill %1 2>/dev/null | cat; echo "k=${PIPESTATUS[0]}"; kill %1; echo end"#,
			out:    "k=1\nend\n",
			file:   "k=1\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-finds-none",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; wait %1 | cat; echo "w=$?"; echo end"#,
			out:    "w=0\nend\n",
			file:   "w=0\nend\n",
			err:    "wait: %1: no such job\n",
		},
		Both {
			name:   "disown-finds-none",
			script: "sleep 30 & disown %1 | cat; jobs; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "disown: %1: no such job\n",
		},
		Both {
			name:   "jobs-finds-it",
			script: "sleep 30 & jobs %1 | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-jobs-lists-it",
			script: "sleep 30 & command jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-jobs-with-a-redirection-lists-it",
			script: "sleep 30 & command jobs 2>/dev/null | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-jobs-into-a-file-lists-it",
			script: r#"F=$(mktemp); sleep 30 & command jobs >"$F" | cat; cat "$F"; rm -f "$F"; kill %1; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-p-jobs-lists-it",
			script: "sleep 30 & command -p jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-p-jobs-with-a-redirection-lists-it",
			script: "sleep 30 & command -p jobs 2>/dev/null | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-dash-dash-jobs-lists-it",
			script: "sleep 30 & command -- jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-p-dash-dash-jobs-lists-it",
			script: "sleep 30 & command -p -- jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-command-jobs-lists-it",
			script: "sleep 30 & command command jobs 2>/dev/null | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-quoted-jobs-lists-it",
			script: "sleep 30 & command 'jobs' | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-jobs-past-a-function-lists-it",
			script: "jobs() { echo fn; }; sleep 30 & command jobs 2>/dev/null | cat; kill %1; echo \
			         end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-after-a-redirection-lists-it",
			script: "sleep 30 & 2>/dev/null jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-jobs-after-a-redirection-lists-it",
			script: "sleep 30 & 2>/dev/null command jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-after-an-assignment-lists-it",
			script: "sleep 30 & x=1 jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-jobs-after-an-assignment-lists-it",
			script: "sleep 30 & x=1 command jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-by-an-expansion-lists-it",
			script: "j=jobs; sleep 30 & $j | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-by-an-expansion-lists-it",
			script: "c=command; sleep 30 & $c jobs | cat; kill %1; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "command-kill-with-a-redirection-finds-none",
			script: "sleep 30 & command kill %1 2>/dev/null | cat; jobs; kill %1 2>/dev/null; echo \
			         end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "a-function-lists-none",
			script: "f() { jobs; }; sleep 30 & f | cat; kill %1; echo end",
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "a-function-given-them-lists-none",
			script: r#"f() { jobs; echo "n=$#"; }; sleep 30 & f "$(jobs -p)" | cat; kill %1; echo end"#,
			out:    "n=1\nend\n",
			file:   "n=1\nend\n",
			err:    "",
		},
		Both {
			name:   "builtin-jobs-lists-none",
			script: "sleep 30 & builtin jobs | cat; kill %1; echo end",
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "builtin-jobs-with-a-redirection-lists-none",
			script: "sleep 30 & builtin jobs 2>/dev/null | cat; kill %1; echo end",
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "an-assignment-before-a-builtin",
			script: r#"sleep 30 & x=$(jobs -p) echo "[$x]" | sed 's/[0-9][0-9]*/PID/'; kill %1; echo end"#,
			out:    "[]\nend\n",
			file:   "[]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-builtin-s-redirection-sees-none",
			script: r#"sleep 30 & echo x > "$(jobs >&2; echo /dev/null)" | cat; kill %1; echo end"#,
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "a-for-loop-lists-none",
			script: r#"sleep 30 & for i in 1; do echo "[$(jobs)]"; done | cat; kill %1; echo end"#,
			out:    "[]\nend\n",
			file:   "[]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-while-loop-lists-none",
			script: r#"sleep 30 & while [ -n "$(jobs)" ]; do echo in; break; done | cat; kill %1; echo end"#,
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "an-if-lists-none",
			script: r#"sleep 30 & if [ -n "$(jobs)" ]; then echo in; fi | cat; kill %1; echo end"#,
			out:    "end\n",
			file:   "end\n",
			err:    "",
		},
		Both {
			name:   "an-assignment-only-stage",
			script: r#"sleep 30 & x=$(jobs) | cat; echo "[$x]"; kill %1; echo end"#,
			out:    "[]\nend\n",
			file:   "[]\nend\n",
			err:    "",
		},
	]);
}
