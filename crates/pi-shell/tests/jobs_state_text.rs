//! `jobs` shows a finished job as bash 5.3 does (`printable_job_status`,
//! `print_pipeline`): by how the process it names ended (its wait status),
//! the last one of a pipeline job; `jobs -l` lists each process of a
//! pipeline job. Each row's output is bash 5.3.20's for `bash -c`; each job's
//! end is waited for (`kill -0`, or `jobs -r` listing none for a pipeline),
//! so the rows need no timing. bash 5.2.21 prints a narrower status column.
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

/// A finished job shows how its process ended, by its wait status (bash
/// `printable_job_status`): a job that exited 143, 130 or 137 shows `Exit N`
/// (`Done(N)` in posix mode), not the signal 128 + N names; one a signal
/// killed shows the signal. A `{ …; }` or `( … )` job whose command a
/// signal killed exited 143 itself. It was the signal's description.
#[test]
fn a_finished_job_shows_how_its_process_ended() {
	assert_rows(&[
		Row {
			name:   "exit-143",
			script: r"/bin/sh -c 'exit 143' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 143                   /bin/sh -c 'exit 143'\n",
			err:    "",
		},
		Row {
			name:   "exit-130",
			script: r"/bin/sh -c 'exit 130' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 130                   /bin/sh -c 'exit 130'\n",
			err:    "",
		},
		Row {
			name:   "exit-137",
			script: r"/bin/sh -c 'exit 137' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 137                   /bin/sh -c 'exit 137'\n",
			err:    "",
		},
		Row {
			name:   "exit-143-posix",
			script: r"set -o posix; /bin/sh -c 'exit 143' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Done(143)                  /bin/sh -c 'exit 143'\n",
			err:    "",
		},
		Row {
			name:   "exit-143-n",
			script: r"/bin/sh -c 'exit 143' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs -n",
			out:    "[1]+  Exit 143                   /bin/sh -c 'exit 143'\n",
			err:    "",
		},
		Row {
			name:   "brace-exit-143",
			script: r"{ /bin/sh -c 'exit 143'; } & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 143                   { /bin/sh -c 'exit 143'; }\n",
			err:    "",
		},
		Row {
			name:   "subshell-exit-143",
			script: r"( exit 143 ) & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 143                   ( exit 143 )\n",
			err:    "",
		},
		Row {
			name:   "brace-killed",
			script: r"{ /bin/sh -c 'kill -TERM $$'; } & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 143                   { /bin/sh -c 'kill -TERM $$'; }\n",
			err:    "Terminated                 /bin/sh -c 'kill -TERM $$'\n",
		},
		Row {
			name:   "comsub-exit-143",
			script: r#"/bin/sh -c 'exit 143' & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); echo "[$x]""#,
			out:    "[[1]+  Exit 143                   /bin/sh -c 'exit 143']\n",
			err:    "",
		},
		Row {
			name:   "wait-then-jobs",
			script: r"/bin/sh -c 'exit 143' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null; do :; done; wait $q; jobs",
			out:    "[1]   Exit 143                   /bin/sh -c 'exit 143'\n",
			err:    "",
		},
		Row {
			name:   "killed-term",
			script: r"sleep 20 & p=$!; kill -TERM $p; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Terminated                 sleep 20\n",
			err:    "",
		},
		Row {
			name:   "killed-kill",
			script: r"sleep 20 & p=$!; kill -KILL $p; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Killed                     sleep 20\n",
			err:    "",
		},
		Row {
			name:   "exit-3",
			script: r"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs",
			out:    "[1]+  Exit 3                     /bin/sh -c 'exit 3'\n",
			err:    "",
		},
	]);
}

/// A finished pipeline job shows its last process's end (`print_pipeline`'s
/// `show = last`), also under `pipefail`, where the job's status is an
/// earlier process's: it showed the job's status, `Terminated` for a first
/// stage SIGTERM killed. Each row waits until `jobs -r` lists no job.
#[test]
fn a_pipeline_job_shows_its_last_process() {
	assert_rows(&[
		Row {
			name:   "pipefail-first-killed",
			script: r#"set -o pipefail; /bin/sh -c 'kill -TERM $$' | cat & while [ -n "$(jobs -r)" ]; do :; done; jobs"#,
			out:    "[1]+  Done                       /bin/sh -c 'kill -TERM $$' | cat\n",
			err:    "",
		},
		Row {
			name:   "pipefail-first-killed-last-exit-3",
			script: r#"set -o pipefail; /bin/sh -c 'kill -TERM $$' | /bin/sh -c 'cat >/dev/null; exit 3' & while [ -n "$(jobs -r)" ]; do :; done; jobs"#,
			out:    "[1]+  Exit 3                     /bin/sh -c 'kill -TERM $$' | /bin/sh -c 'cat \
			         >/dev/null; exit 3'\n",
			err:    "",
		},
		Row {
			name:   "first-killed",
			script: r#"/bin/sh -c 'kill -TERM $$' | cat & while [ -n "$(jobs -r)" ]; do :; done; jobs"#,
			out:    "[1]+  Done                       /bin/sh -c 'kill -TERM $$' | cat\n",
			err:    "",
		},
		Row {
			name:   "last-killed",
			script: r#"/bin/true | /bin/sh -c 'cat >/dev/null; kill -TERM $$' & while [ -n "$(jobs -r)" ]; do :; done; jobs"#,
			out:    "[1]+  Terminated                 /bin/true | /bin/sh -c 'cat >/dev/null; kill \
			         -TERM $$'\n",
			err:    "",
		},
		Row {
			name:   "pipeline-wait-r-exit-143",
			script: r#"/bin/true | /bin/sh -c 'cat >/dev/null; exit 143' & while [ -n "$(jobs -r)" ]; do :; done; jobs"#,
			out:    "[1]+  Exit 143                   /bin/true | /bin/sh -c 'cat >/dev/null; exit \
			         143'\n",
			err:    "",
		},
		Row {
			name:   "lastpipe-job",
			script: r#"shopt -s lastpipe; { /bin/sh -c 'exit 143' | cat; } & while [ -n "$(jobs -r)" ]; do :; done; jobs"#,
			out:    "[1]+  Done                       { /bin/sh -c 'exit 143' | cat; }\n",
			err:    "",
		},
	]);
}

/// `jobs -l` of a pipeline job lists each process on its own line with its
/// pid and its own status, left blank where it is the first one's; the
/// last line ends with ` &` while the job runs. It printed one line. The
/// pids are masked as `PID`.
#[test]
fn jobs_l_lists_each_process_of_a_pipeline_job() {
	assert_rows(&[
		Row {
			name:   "pipefail-first-killed-long",
			script: r#"set -o pipefail; /bin/sh -c 'kill -TERM $$' | cat & while [ -n "$(jobs -r)" ]; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'"#,
			out:    "[1]+ PID Terminated                 /bin/sh -c 'kill -TERM $$'\n      PID Done                       | cat\n",
			err:    "",
		},
		Row {
			name:   "first-killed-long",
			script: r#"/bin/sh -c 'kill -TERM $$' | cat & while [ -n "$(jobs -r)" ]; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'"#,
			out:    "[1]+ PID Terminated                 /bin/sh -c 'kill -TERM $$'\n      PID Done                       | cat\n",
			err:    "",
		},
		Row {
			name:   "last-killed-long",
			script: r#"/bin/true | /bin/sh -c 'cat >/dev/null; kill -TERM $$' & while [ -n "$(jobs -r)" ]; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'"#,
			out:    "[1]+ PID Done                       /bin/true\n      PID Terminated                 | /bin/sh -c 'cat >/dev/null; kill -TERM $$'\n",
			err:    "",
		},
		Row {
			name:   "two-exits-long",
			script: r#"/bin/sh -c 'exit 2' | /bin/sh -c 'cat >/dev/null; exit 3' & while [ -n "$(jobs -r)" ]; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'"#,
			out:    "[1]+ PID Exit 2                     /bin/sh -c 'exit 2'\n      PID Exit 3                     | /bin/sh -c 'cat >/dev/null; exit 3'\n",
			err:    "",
		},
		Row {
			name:   "same-exits-long",
			script: r#"/bin/true | cat & while [ -n "$(jobs -r)" ]; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'"#,
			out:    "[1]+ PID Done                       /bin/true\n      PID                          | cat\n",
			err:    "",
		},
		Row {
			name:   "three-long",
			script: r#"/bin/sh -c 'exit 2' | /bin/sh -c 'cat >/dev/null; exit 2' | cat & while [ -n "$(jobs -r)" ]; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'"#,
			out:    "[1]+ PID Exit 2                     /bin/sh -c 'exit 2'\n      PID                          | /bin/sh -c 'cat >/dev/null; exit 2'\n      PID Done                       | cat\n",
			err:    "",
		},
		Row {
			name:   "running-long",
			script: r"sleep 20 | cat & jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'; kill %1; wait",
			out:    "[1]+ PID Running                    sleep 20\n      PID                          | cat &\n",
			err:    "",
		},
		Row {
			name:   "running-one-long",
			script: r"sleep 20 & jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'; kill %1; wait",
			out:    "[1]+ PID Running                    sleep 20 &\n",
			err:    "",
		},
		Row {
			name:   "exit-143-long",
			script: r"/bin/sh -c 'exit 143' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs -l | sed -E 's/^(\[[0-9]+\].) *[0-9]+ /\1 PID /; s/^ +[0-9]+ /      PID /'",
			out:    "[1]+ PID Exit 143                   /bin/sh -c 'exit 143'\n",
			err:    "",
		},
	]);
}
