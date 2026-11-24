//! A command or process substitution of a shell that is not interactive
//! drops the finished jobs bash 5.3 drops before it runs its first command:
//! every one but the job `$!` names, and not one a SIGINT, SIGTERM or SIGPIPE
//! killed, nor one a signal the shell ignores with `trap '' SIG` killed (how
//! the job ended, not its status: one that exited 130, 141 or 143 goes).
//! Each one keeps its status for `wait PID`. So `$(jobs)` and `<(jobs)` list
//! what bash lists, and a loop that waits for `$(jobs -p | wc -l)` to fall
//! ends. A forked shell (a `( … )`, a background job, a pipeline's stage)
//! drops its own first, as it expands the substitution: every finished job,
//! `$!`'s too; a command substitution's own process drops every one but
//! `$!`'s. So the substitution gets none of them, and the shell's own `jobs`
//! after it lists none; a foreground command, a builtin or a pipeline it
//! runs drops none. Where bash's job list is frozen (the
//! last stage of a `lastpipe` pipeline, a function substitution, a trap run
//! with the list frozen, and any fork of a shell there) it drops none.
//! Each row's output is bash 5.3.20's for `bash -c`, and for the rows of
//! forks also from a script file, where bash's `startup_state` is 0 and a
//! forked shell outside a substitution drops none; a finished job's end is
//! waited for with `kill -0`, so the rows need no timing. bash 5.2.21 prints
//! a narrower status column, has no function substitution (`${ …; }`), and
//! under `-c` its command substitution keeps no finished job at all (from a
//! script file it keeps `$!`'s, as 5.3 does).
#![cfg(target_os = "linux")]

mod obash_support;

/// One script, its standard output and its standard error (each line's
/// shell-name prefix `…: line 1: ` and each `(PID)` taken out); its status
/// is 0.
struct Row {
	name:   &'static str,
	script: &'static str,
	out:    &'static str,
	err:    &'static str,
}

/// A row whose standard output bash 5.3.20 gives through `-c` (`out`) and
/// from a script file (`file`); its standard error is `err` both ways.
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

/// The rows whose status (0), output or error text through `via` differs
/// from bash's (`want`: each row's name, script, output and error text),
/// each as a line `NAME: `, or `NAME (file): `, and the script.
fn mismatches<'a>(
	rows: impl IntoIterator<Item = (&'a str, &'a str, &'a str, &'a str)>,
	via: Via,
) -> Vec<String> {
	let mut found = Vec::new();
	for (name, script, out, err) in rows {
		let (status, got, got_err) = run(script, via);
		if (status, got.as_str(), got_err.as_str()) != (Some(0), out, err) {
			let how = if via == Via::File { " (file)" } else { "" };
			found.push(format!(
				"{name}{how}: `{script}`\n  bash: Some(0) {out:?} {err:?}\n  omp:  {status:?} {got:?} \
				 {got_err:?}"
			));
		}
	}
	found
}

/// Fails with every mismatch of the `of` runs.
fn assert_none(found: &[String], of: usize) {
	assert!(
		found.is_empty(),
		"{} of {of} rows differ from bash:\n{}",
		found.len(),
		found.join("\n")
	);
}

/// Runs each row through `obash -c` and reports every row whose output,
/// error text or exit status differs from bash's.
fn assert_rows(rows: &[Row]) {
	let found = mismatches(rows.iter().map(|r| (r.name, r.script, r.out, r.err)), Via::Command);
	assert_none(&found, rows.len());
}

/// Runs each row through `obash -c` and from a script file, and reports
/// every run whose output, error text or exit status differs from bash's.
fn assert_both(rows: &[Both]) {
	let mut found = mismatches(rows.iter().map(|r| (r.name, r.script, r.out, r.err)), Via::Command);
	found.extend(mismatches(rows.iter().map(|r| (r.name, r.script, r.file, r.err)), Via::File));
	assert_none(&found, 2 * rows.len());
}

/// `$(jobs)` lists a finished job only when `$!` names it, or when a SIGINT,
/// SIGTERM or SIGPIPE killed it, or a signal the shell ignores killed it
/// (`trap '' SIG`); every running job is listed, and the shell's own `jobs`
/// still lists them all. A job that a signal the shell traps with a command
/// killed goes: the command substitution's process takes that trap off, and
/// keeps only one that ignores its signal. A job that exited 130, 141 or 143
/// goes. Without job control a background job starts with SIGINT ignored, so
/// its `kill -INT $$` exits 0 and the job goes; with `set -m` it dies of
/// SIGINT and stays. A dropped current or previous job makes the marks be
/// chosen again: the one finished job left has none.
#[test]
fn a_command_substitution_lists_the_jobs_bash_lists() {
	assert_rows(&[
		Row {
			name:   "two-done",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]""#,
			out:    "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "done-then-running",
			script: r#"/bin/true & p=$!; sleep 20 & while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; kill %2; wait; echo end"#,
			out:    "[[2]+  Running                    sleep 20 &]\nend\n",
			err:    "",
		},
		Row {
			name:   "running-then-done",
			script: r#"sleep 20 & /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; kill %1; wait; echo end"#,
			out:    "[[1]-  Running                    sleep 20 &\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "two-done-then-running",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; sleep 20 & while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; kill %3; wait; echo end"#,
			out:    "[[3]+  Running                    sleep 20 &]\nend\n",
			err:    "",
		},
		Row {
			name:   "terminated-kept",
			script: r#"sleep 20 & p=$!; /bin/true & q=$!; kill -TERM $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]-  Terminated                 sleep 20\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "broken-pipe-kept",
			script: r#"sleep 20 & p=$!; /bin/true & q=$!; kill -PIPE $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]-  Broken pipe                sleep 20\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "killed-under-an-ignoring-trap-kept",
			script: r#"trap '' KILL; sleep 20 & p=$!; /bin/true & q=$!; kill -KILL $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]-  Killed                     sleep 20\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "hangup-under-a-trap-with-a-command-dropped",
			script: r#"trap 'echo hup' HUP; sleep 20 & p=$!; /bin/true & q=$!; kill -HUP $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "hangup-under-an-ignoring-trap-set-after-it-kept",
			script: r#"sleep 20 & p=$!; /bin/true & q=$!; kill -HUP $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; trap '' HUP; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]-  Hangup                     sleep 20\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "exit-status-dropped",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "sigint-ignored-dropped",
			script: r#"/bin/sh -c 'kill -INT $$' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "interrupt-kept-with-job-control",
			script: r#"set -m; /bin/sh -c 'kill -INT $$' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]-  Interrupt                  /bin/sh -c 'kill -INT $$'\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "exit-130-dropped",
			script: r#"/bin/sh -c 'exit 130' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "exit-141-dropped",
			script: r#"/bin/sh -c 'exit 141' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "exit-143-dropped",
			script: r#"/bin/sh -c 'exit 143' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "the-shell-keeps-them",
			script: r"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); jobs; echo end",
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true\nend\n",
			err:    "",
		},
	]);
}

/// A loop that waits until fewer than N jobs are listed ends: each finished
/// job but `$!`'s leaves the command substitution's list (it hung, counting
/// every job that ever ended; the inner loop's own bound prints `stuck`),
/// also when its jobs exited 130 or 143, or ignored a SIGINT.
#[test]
fn a_count_of_listed_jobs_falls_when_they_end() {
	assert_rows(&[
		Row {
			name:   "count",
			script: r#"for i in 1 2 3 4 5; do /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; echo "$(jobs -p | wc -l)"; done; echo end"#,
			out:    "1\n1\n1\n1\n1\nend\n",
			err:    "",
		},
		Row {
			name:   "throttle",
			script: r#"n=0; for i in 1 2 3 4 5 6; do while [ "$(jobs -p | wc -l)" -ge 3 ]; do n=$((n + 1)); [ $n -lt 50 ] || { echo stuck; break 2; }; done; /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; done; echo end"#,
			out:    "end\n",
			err:    "",
		},
		Row {
			name:   "throttle-interrupt",
			script: r#"n=0; for i in 1 2 3 4 5 6; do while [ "$(jobs -p | wc -l)" -ge 3 ]; do n=$((n + 1)); [ $n -lt 50 ] || { echo stuck; break 2; }; done; /bin/sh -c 'kill -INT $$' & p=$!; while kill -0 $p 2>/dev/null; do :; done; done; echo end"#,
			out:    "end\n",
			err:    "",
		},
		Row {
			name:   "throttle-exit-130",
			script: r#"n=0; for i in 1 2 3 4 5 6; do while [ "$(jobs -p | wc -l)" -ge 3 ]; do n=$((n + 1)); [ $n -lt 50 ] || { echo stuck; break 2; }; done; /bin/sh -c 'exit 130' & p=$!; while kill -0 $p 2>/dev/null; do :; done; done; echo end"#,
			out:    "end\n",
			err:    "",
		},
		Row {
			name:   "throttle-exit-143",
			script: r#"n=0; for i in 1 2 3 4 5 6; do while [ "$(jobs -p | wc -l)" -ge 3 ]; do n=$((n + 1)); [ $n -lt 50 ] || { echo stuck; break 2; }; done; /bin/sh -c 'exit 143' & p=$!; while kill -0 $p 2>/dev/null; do :; done; done; echo end"#,
			out:    "end\n",
			err:    "",
		},
	]);
}

/// Where bash's job list is frozen, its command substitution drops no job:
/// the substitution's process is a fork that keeps the list frozen, so it
/// deletes nothing before its first command. That is the last stage of a
/// `lastpipe` pipeline, which the shell runs itself, a function
/// substitution (`${ …; }`), and a trap run with the list frozen (`INT` as
/// the foreground child that SIGINT killed ends), also for a command
/// substitution started inside one started there. A loop in a `lastpipe`
/// stage that waits for `$(jobs -p | wc -l)` to fall counts every job (its
/// bound prints `stuck`); after the pipeline the count falls again.
#[test]
fn a_command_substitution_drops_no_job_where_bash_s_list_is_frozen() {
	assert_rows(&[
		Row {
			name:   "lastpipe",
			script: r#"shopt -s lastpipe; /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo | { x=$(jobs); echo "[$x]"; }; echo end"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-nested",
			script: r#"shopt -s lastpipe; /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo | { x=$(echo "$(jobs)"); echo "[$x]"; }; echo end"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "function-substitution",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-nested",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(echo "$(jobs)"); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\nend\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-count",
			script: r#"shopt -s lastpipe; /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo | { x=$(jobs -p | wc -l); echo "n=$x"; }; x=$(jobs -p | wc -l); echo "after n=$x""#,
			out:    "n=2\nafter n=1\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-throttle",
			script: r#"shopt -s lastpipe; n=0; printf '%s\n' 1 2 3 4 5 6 | while read i; do while [ "$(jobs -p | wc -l)" -ge 3 ]; do n=$((n + 1)); [ $n -lt 50 ] || { echo stuck; break 2; }; done; /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; done; echo end"#,
			out:    "stuck\nend\n",
			err:    "",
		},
		Row {
			name:   "int-trap",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; trap 'x=$(jobs); echo "[$x]"' INT; /bin/sh -c 'kill -INT $PPID; kill -INT $$'; echo "rc=$?""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\nrc=130\n",
			err:    "",
		},
	]);
}

/// A fork of a shell whose job list is frozen keeps it frozen (bash's
/// `without_job_control` empties a subshell's job list but leaves the
/// freeze): a command or process substitution it starts drops none of the
/// jobs the fork itself started. In a `lastpipe` stage and in `${ …; }`: a
/// `( … )` subshell, a `{ …; } &` group, a pipeline stage, a substitution
/// nested in a subshell, a process substitution, and a fork of such a fork.
#[test]
fn a_fork_of_a_frozen_shell_drops_no_job() {
	assert_rows(&[
		Row {
			name:   "lastpipe-subshell",
			script: r#"shopt -s lastpipe; echo | { ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" ); }"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-async-group",
			script: r#"shopt -s lastpipe; echo | { { /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } & wait; }"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-pipeline-stage",
			script: r#"shopt -s lastpipe; echo | { { /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } | cat; }"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-subshell-nested",
			script: r#"shopt -s lastpipe; echo | { ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(echo "$(jobs)"); echo "[$x]" ); }"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-subshell",
			script: r#"y=${ ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" ); }; echo "$y""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-async-group",
			script: r#"y=${ { /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } & wait; }; echo "$y""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-pipeline-stage",
			script: r#"y=${ { /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } | cat; }; echo "$y""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-subshell-nested",
			script: r#"y=${ ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(echo "$(jobs)"); echo "[$x]" ); }; echo "$y""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-process-substitution",
			script: r#"y=${ cat <( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" ); }; echo "$y""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-subshell-in-a-subshell",
			script: r#"shopt -s lastpipe; echo | { ( ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" ) ); }"#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
		Row {
			name:   "function-substitution-async-group-in-a-subshell",
			script: r#"y=${ ( { /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } & wait ); }; echo "$y""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true]\n",
			err:    "",
		},
	]);
}

/// A process substitution's process keeps the shell's job list and drops
/// the finished jobs a command substitution drops, before its first
/// command: `cat <(jobs)` lists what `$(jobs)` lists (it listed nothing).
/// Where the shell's job list is frozen it drops none (a function
/// substitution, a trap run with the list frozen), and it has no job
/// control: `fg` says so, where a command substitution finds no current
/// job.
#[test]
fn a_process_substitution_lists_the_jobs_a_command_substitution_lists() {
	assert_rows(&[
		Row {
			name:   "process-substitution",
			script: r"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); echo end",
			out:    "[2]   Done                       /bin/true\nend\n",
			err:    "",
		},
		Row {
			name:   "function-substitution",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ cat <(jobs); }; echo "$y""#,
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true\n",
			err:    "",
		},
		Row {
			name:   "int-trap",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; trap 'cat <(jobs)' INT; /bin/sh -c 'kill -INT $PPID; kill -INT $$'; echo "rc=$?""#,
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       \
			         /bin/true\nrc=130\n",
			err:    "",
		},
		Row {
			name:   "no-job-control",
			script: r#"set -m; sleep 0.3 & cat <(fg; echo "rc=$?"); wait"#,
			out:    "rc=1\n",
			err:    "fg: no job control\n",
		},
	]);
}

/// A process substitution of a forked shell of a `-c` shell gets no
/// finished job: the fork dropped them all as it expanded `<( … )`, and its
/// own `jobs` after lists none (it listed `$!`'s job in the substitution,
/// and every job after). From a script file the fork drops none, and the
/// substitution lists `$!`'s. A process substitution inside one keeps `$!`'s
/// job, as a command substitution does.
#[test]
fn a_process_substitution_of_a_fork_gets_no_finished_job() {
	assert_both(&[
		Both {
			name:   "subshell",
			script: r"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); echo e )",
			out:    "e\n",
			file:   "[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "subshell-jobs-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); jobs; echo e )",
			out:    "e\n",
			file:   "[2]   Done                       /bin/true\n[1]-  Exit 3                     \
			         /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "subshell-then-end",
			script: r"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs) ); echo end",
			out:    "end\n",
			file:   "[2]   Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "background-group",
			script: r"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); } & wait; echo end",
			out:    "end\n",
			file:   "[2]   Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline-stage",
			script: r"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); } | cat; echo end",
			out:    "end\n",
			file:   "[2]   Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "after-an-external",
			script: r"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; /bin/true; cat <(jobs) ); echo end",
			out:    "end\n",
			file:   "[2]   Done                       /bin/true\nend\n",
			err:    "",
		},
		Both {
			name:   "in-a-command-substitution",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(cat <(jobs)); echo "[$x]" )"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "subshell-jobs-later",
			script: r"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); echo ---; jobs; echo e )",
			out:    "---\ne\n",
			file:
				"[2]   Done                       /bin/true\n---\n[1]-  Done                       \
				 /bin/true\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "in-a-process-substitution",
			script: r"cat <( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs) )",
			out:    "[2]   Done                       /bin/true\n",
			file:   "[2]   Done                       /bin/true\n",
			err:    "",
		},
	]);
}

/// A `( … )`, a background group, a pipeline's stage, a nested `( … )`, a
/// function or `eval` run in one, of a `-c` shell: as it expands a command
/// or process substitution, the fork drops every finished job, `$!`'s too,
/// from its own list, so the substitution lists none and the fork's own
/// `jobs` after it none. A running job stays, so does one a SIGTERM killed,
/// and in posix mode `$!`'s. The shell itself (a `{ …; }` it runs) drops
/// none of its own, nor does a fork that runs no substitution. A
/// foreground external, a builtin or a pipeline drops none; `wait PID`
/// takes only its job. From a script file a fork drops none (bash's
/// `startup_state` 0), and the substitution lists `$!`'s; a fork inside a
/// substitution drops them all both ways.
#[test]
fn a_fork_drops_every_finished_job_as_it_expands_a_substitution() {
	assert_both(&[
		Both {
			name:   "subshell",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" )"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "subshell-then-its-own-jobs",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; jobs; echo e )"#,
			out:    "[]\ne\n",
			file:   "[[2]   Done                       /bin/true]\n[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "subshell-count",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs -p | wc -l); echo "[$x]" )"#,
			out:    "[0]\n",
			file:   "[1]\n",
			err:    "",
		},
		Both {
			name:   "subshell-bang-exit-3",
			script: r#"( /bin/true & q=$!; /bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; while kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" )"#,
			out:    "[]\n",
			file:   "[[2]   Exit 3                     /bin/sh -c 'exit 3']\n",
			err:    "",
		},
		Both {
			name:   "nested-subshell",
			script: r#"( ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" ) )"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "background-group",
			script: r#"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } & wait"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "pipeline-stage",
			script: r#"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; } | cat"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "function-in-a-subshell",
			script: r#"f() { jobs; }; ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(f); echo "[$x]" )"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "subshell-twice",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); y=$(jobs); echo "[$x][$y]" )"#,
			out:    "[][]\n",
			file:   "[[2]   Done                       /bin/true][[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "eval-in-a-subshell",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; eval 'x=$(jobs)'; echo "[$x]" )"#,
			out:    "[]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "subshell-jobs-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(:); jobs; echo e )",
			out:    "e\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "background-group-jobs-after",
			script: r"{ /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(:); jobs; echo e; } & wait",
			out:    "e\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "in-a-substitution",
			script: r#"x=$( ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(jobs); echo "[$y]" ) ); echo "$x""#,
			out:    "[]\n",
			file:   "[]\n",
			err:    "",
		},
		Both {
			name:   "bang-kept",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$([ "$!" = "$q" ] && echo same || echo "diff"); echo "[$x]" )"#,
			out:    "[same]\n",
			file:   "[same]\n",
			err:    "",
		},
		Both {
			name:   "running-kept",
			script: r#"( sleep 20 & p=$!; x=$(jobs); echo "[$x]"; kill $p; wait )"#,
			out:    "[[1]+  Running                    sleep 20 &]\n",
			file:   "[[1]+  Running                    sleep 20 &]\n",
			err:    "",
		},
		Both {
			name:   "terminated-kept",
			script: r#"( /bin/sh -c 'kill -TERM $$' & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" )"#,
			out:    "[[1]+  Terminated                 /bin/sh -c 'kill -TERM $$']\n",
			file:   "[[1]+  Terminated                 /bin/sh -c 'kill -TERM $$']\n",
			err:    "",
		},
		Both {
			name:   "posix-keeps-bang",
			script: r#"set -o posix; ( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]" )"#,
			out:    "[[2]   Done                       /bin/true]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "shell",
			script: r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]""#,
			out:    "[[2]   Done                       /bin/true]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "group-in-the-shell",
			script: r#"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; }"#,
			out:    "[[2]   Done                       /bin/true]\n",
			file:   "[[2]   Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "subshell-own-jobs",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs; [ "$!" = "$q" ] && echo bang-q )"#,
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\nbang-q\n",
			file:   "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\nbang-q\n",
			err:    "",
		},
		Both {
			name:   "background-group-own-jobs",
			script: r"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs; } & wait",
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\n",
			file:   "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\n",
			err:    "",
		},
		Both {
			name:   "pipeline-stage-own-jobs",
			script: r"{ /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs; } | cat",
			out:    "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\n",
			file:   "[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\n",
			err:    "",
		},
		Both {
			name:   "external-drops-none",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; /bin/true; jobs; echo e )",
			out:    "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "builtin-drops-none",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; :; jobs; echo e )",
			out:    "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "posix-terminated-kept",
			script: r"set -o posix; ( sleep 20 & p=$!; /bin/true & q=$!; kill -TERM $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(:); jobs; echo e )",
			out:    "[1]-  Terminated                 sleep 20\n[2]+  Done                       /bin/true\ne\n",
			file:   "[1]-  Terminated                 sleep 20\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "pipeline-drops-none",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; true | cat; jobs; echo e )",
			out:    "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "wait-drops-its-job",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; wait $p; echo "w=$?"; jobs; echo e )"#,
			out:    "w=3\n[2]   Done                       /bin/true\ne\n",
			file:   "w=3\n[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
	]);
}

/// A command substitution's own process drops every finished job but `$!`'s
/// from its own list as it expands a command or process substitution (the
/// list it took from its shell, and its own jobs): the inner one and the
/// process's own `jobs` after it list only `$!`'s, from a script file too.
/// A foreground external or a builtin drops none. A job a SIGTERM killed
/// stays; one that a signal the shell traps with a command killed goes (the
/// substitution's process has that trap reset).
#[test]
fn a_command_substitution_drops_its_own_jobs_as_it_expands_one() {
	assert_both(&[
		Both {
			name:   "inner-list",
			script: r#"x=$( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(jobs); echo "{$y}" ); echo "[$x]""#,
			out:    "[{[2]   Done                       /bin/true}]\n",
			file:   "[{[2]   Done                       /bin/true}]\n",
			err:    "",
		},
		Both {
			name:   "jobs-after",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(:); jobs; echo e ); echo "[$x]""#,
			out:    "[[2]   Done                       /bin/true\ne]\n",
			file:   "[[2]   Done                       /bin/true\ne]\n",
			err:    "",
		},
		Both {
			name:   "process-substitution",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; cat <(jobs); jobs; echo e ); echo "[$x]""#,
			out:    "[[2]   Done                       /bin/true\n[2]   Done                       /bin/true\ne]\n",
			file:   "[[2]   Done                       /bin/true\n[2]   Done                       /bin/true\ne]\n",
			err:    "",
		},
		Both {
			name:   "own-jobs",
			script: r#"x=$( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs ); echo "[$x]""#,
			out:    "[[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true]\n",
			file:   "[[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true]\n",
			err:    "",
		},
		Both {
			name:   "external-drops-none",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; /bin/true; jobs; echo e ); echo "[$x]""#,
			out:    "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne]\n",
			file:   "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne]\n",
			err:    "",
		},
		Both {
			name:   "builtin-drops-none",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; :; jobs; echo e ); echo "[$x]""#,
			out:    "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne]\n",
			file:   "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne]\n",
			err:    "",
		},
		Both {
			name:   "terminated-kept",
			script: r#"x=$( sleep 20 & p=$!; /bin/true & q=$!; kill -TERM $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(:); jobs; echo e ); echo "[$x]""#,
			out:    "[[1]-  Terminated                 sleep 20\n[2]+  Done                       /bin/true\ne]\n",
			file:   "[[1]-  Terminated                 sleep 20\n[2]+  Done                       /bin/true\ne]\n",
			err:    "",
		},
		Both {
			name:   "hangup-under-an-inherited-trap-dropped",
			script: r#"trap 'echo hup' HUP; x=$( sleep 20 & p=$!; /bin/true & q=$!; kill -HUP $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(:); jobs; echo e ); echo "[$x]""#,
			out:    "[[2]   Done                       /bin/true\ne]\n",
			file:   "[[2]   Done                       /bin/true\ne]\n",
			err:    "",
		},
	]);
}

/// A job a command substitution, or the fork that expanded it, dropped keeps
/// its status there: `wait PID` returns it (it said `not a child of this
/// shell`, 127), `$!`'s job too, which a fork drops. A finished job the
/// command substitution took from its shell is its own to wait for: `wait
/// PID` (or `%N`) returns that job's status, also where the shell's list
/// is frozen, and again on a second `wait`.
#[test]
fn a_dropped_job_keeps_its_status_for_wait() {
	assert_both(&[
		Both {
			name:   "wait",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(wait $p; echo $?); echo "[$x]"; echo end"#,
			out:    "[3]\nend\n",
			file:   "[3]\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-bang",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(wait $p; echo "w=$?"); echo "[$x]" )"#,
			out:    "[w=3]\n",
			file:   "[w=3]\n",
			err:    "",
		},
		Both {
			name:   "subshell",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(wait $p; echo "w=$?"); echo "{$y}"; jobs; echo e )"#,
			out:    "{w=3}\ne\n",
			file:   "{w=3}\n[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "comsub",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=$(wait $p; echo "w=$?"); echo "{$y}"; jobs; echo e ); echo "[$x]""#,
			out:    "[{w=3}\n[2]   Done                       /bin/true\ne]\n",
			file:   "[{w=3}\n[2]   Done                       /bin/true\ne]\n",
			err:    "",
		},
		Both {
			name:   "subshell-bang-of-two",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(wait $q 2>&1; echo "w=$?"); echo "[$x]" )"#,
			out:    "[w=0]\n",
			file:   "[w=0]\n",
			err:    "",
		},
		Both {
			name:   "copy-of-bang",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(wait $q 2>&1; echo "w=$?"); echo "[$x]""#,
			out:    "[w=0]\n",
			file:   "[w=0]\n",
			err:    "",
		},
		Both {
			name:   "copy-twice",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(wait $q; echo "w=$?"; wait $q; echo "v=$?"); echo "[$x]""#,
			out:    "[w=0\nv=0]\n",
			file:   "[w=0\nv=0]\n",
			err:    "",
		},
		Both {
			name:   "copy-by-job-number",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(wait %2 2>&1; echo "w=$?"); echo "[$x]""#,
			out:    "[w=0]\n",
			file:   "[w=0]\n",
			err:    "",
		},
		Both {
			name:   "copy-in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; echo | { x=$(wait $p 2>&1; echo "w=$?"); echo "[$x]"; }"#,
			out:    "[w=3]\n",
			file:   "[w=3]\n",
			err:    "",
		},
	]);
}

/// `jobs` ends with bash's `notify_and_cleanup (-1)` too: after `jobs %1`, a
/// fork of a `-c` shell drops its other finished job, and the `-c` shell
/// itself keeps it.
#[test]
fn the_end_of_jobs_drops_in_a_fork_only() {
	assert_rows(&[
		Row {
			name:   "subshell",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs %1; echo -; jobs; echo e )",
			out:    "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n-\ne\n",
			err:    "",
		},
		Row {
			name:   "shell",
			script: r"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs %1; echo -; jobs; echo e",
			out:    "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n-\n[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
	]);
}

/// An interactive shell's command substitution keeps every finished job (it
/// reads no line through the path that drops them): `bash --norc -i -c`
/// lists both. Only the output is compared: bash's standard error carries
/// job-control warnings and `[1] PID` notices that obash does not print.
#[test]
fn an_interactive_shell_s_command_substitution_keeps_every_job() {
	let script = r#"/bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]""#;
	let result = obash_support::output(
		obash_support::obash()
			.args(["--norc", "-i", "-c", script])
			.stdin(std::process::Stdio::null()),
	);
	assert_eq!(
		String::from_utf8_lossy(&result.stdout),
		"[[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true]\n"
	);
	assert_eq!(result.status.code(), Some(0));
}
