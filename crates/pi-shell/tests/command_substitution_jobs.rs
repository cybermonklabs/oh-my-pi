//! A command substitution of a shell that is not interactive drops the
//! finished jobs bash 5.3 drops before it runs its first command: every one
//! but the job `$!` names, and not one a SIGINT, SIGTERM or SIGPIPE killed.
//! Each one keeps its status for `wait PID`. So `$(jobs)` lists what bash
//! lists, and a loop that waits for `$(jobs -p | wc -l)` to fall ends. Each
//! row's output is bash 5.3.20's for `bash -c`; a finished job's end is
//! waited for with `kill -0`, so the rows need no timing. bash 5.2.21 prints
//! a narrower status column, and under `-c` its command substitution keeps
//! no finished job at all (from a script file it keeps `$!`'s, as 5.3 does).
#![cfg(target_os = "linux")]

mod obash_support;

/// One script, its standard output and its standard error; its status is 0.
struct Row {
	name:   &'static str,
	script: &'static str,
	out:    &'static str,
	err:    &'static str,
}

/// Runs each row through `obash -c` and reports every row whose output,
/// error text or exit status differs from bash's.
fn assert_rows(rows: &[Row]) {
	let mut mismatches = Vec::new();
	for row in rows {
		let result = obash_support::output(obash_support::obash().args(["-c", row.script]));
		let out = String::from_utf8_lossy(&result.stdout).into_owned();
		let err = String::from_utf8_lossy(&result.stderr).into_owned();
		if (result.status.code(), out.as_str(), err.as_str()) != (Some(0), row.out, row.err) {
			mismatches.push(format!(
				"{}: `{}`\n  bash: Some(0) {:?} {:?}\n  omp:  {:?} {out:?} {err:?}",
				row.name,
				row.script,
				row.out,
				row.err,
				result.status.code(),
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// `$(jobs)` lists a finished job only when `$!` names it, or when a SIGINT,
/// SIGTERM or SIGPIPE ended it (here SIGTERM and SIGPIPE: a background job
/// of a shell without job control ignores SIGINT); every running job is
/// listed, and the shell's own `jobs` still lists them all. A dropped
/// current or previous job makes the marks be chosen again: the one finished
/// job left has none.
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
			name:   "exit-status-dropped",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
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
/// every job that ever ended; the inner loop's own bound prints `stuck`).
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
	]);
}

/// A job the command substitution dropped keeps its status there: `wait
/// PID` returns it (it said `not a child of this shell`, 127).
#[test]
fn a_dropped_job_keeps_its_status_for_wait() {
	assert_rows(&[Row {
		name:   "wait",
		script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(wait $p; echo $?); echo "[$x]"; echo end"#,
		out:    "[3]\nend\n",
		err:    "",
	}]);
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
