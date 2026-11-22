//! A job's state once its last process is gone, as Bash 5.3.20 reports it
//! (`obash -c`). Bash marks a job done in the `waitchld` that reaps its last
//! process, so when `kill -0 $!` says the pipeline's last program is gone,
//! `jobs`, `fg`, `bg`, `kill %1` and a command substitution's `jobs` see the
//! job done. In each `first` row the job's last stage exits only once the
//! shell has reaped the first (it spins while `/proc/<first pid>` exists), so
//! Bash's answer does not depend on timing; in each `last` row the first stage
//! ends only after the shell's first report. Bash 5.2.21 prints the same but
//! for its narrower status column (24, not 27) and an empty `$(jobs)` (its
//! command substitution starts without the job list).
#![cfg(target_os = "linux")]

mod obash_support;

/// One script, its standard output, and its standard error with each line's
/// `NAME: line 1: ` prefix and each `(PID)` taken out.
struct Row {
	name:   &'static str,
	script: &'static str,
	out:    &'static str,
	err:    &'static str,
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

/// Runs each row through `obash -c` and reports every row whose output,
/// error text or exit status (0) differs from Bash's.
fn assert_rows(rows: &[Row]) {
	let mut mismatches = Vec::new();
	for row in rows {
		let result = obash_support::output(obash_support::obash().args(["-c", row.script]));
		let out = String::from_utf8_lossy(&result.stdout).into_owned();
		let err = normalised(&String::from_utf8_lossy(&result.stderr));
		if (result.status.code(), out.as_str(), err.as_str()) != (Some(0), row.out, row.err) {
			mismatches.push(format!(
				"{}: `{}`\n  bash: Some(0) {:?} {:?}\n  omp:  {:?} {out:?} {err:?}",
				row.name,
				row.script,
				row.out,
				row.err,
				result.status.code()
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

/// Once `kill -0 $!` says a background pipeline's last program is gone and
/// the shell reaped every other one, the job is done for `jobs`, `jobs -r`,
/// `-n`, `%1` and `$(jobs)`.
#[test]
fn a_pipeline_job_whose_processes_are_gone_is_done() {
	assert_rows(&[
		Row {
			name:   "first/jobs",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs; echo end",
			out:    "[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; while [ -e /proc/$p ]; do :; done; exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "first/jobs-r",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs -r; echo end",
			out:    "end\n",
			err:    "",
		},
		Row {
			name:   "first/jobs-n",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs -n; echo end",
			out:    "[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; while [ -e /proc/$p ]; do :; done; exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "first/jobs-%1",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs %1; echo end",
			out:    "[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; while [ -e /proc/$p ]; do :; done; exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "first/cmdsub",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; while [ -e /proc/$p ]; do :; done; exit 5']\nend\n",
			err:    "",
		},
		Row {
			name:   "last/jobs",
			script: r#"T=$(mktemp -d); /bin/sh -c 'echo $$ > "$1/F"; until [ -e "$1/G" ]; do :; done; exit 3' sh "$T" | /bin/sh -c 'exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs; echo --; : > "$T/G"; until [ -s "$T/F" ]; do :; done; read f < "$T/F"; while kill -0 $f 2>/dev/null; do :; done; jobs; rm -r "$T"; echo end"#,
			out:    "[1]+  Running                    /bin/sh -c 'echo $$ > \"$1/F\"; until [ -e \
			         \"$1/G\" ]; do :; done; exit 3' sh \"$T\" | /bin/sh -c 'exit 5' &\n--\n[1]+  \
			         Exit 5                     /bin/sh -c 'echo $$ > \"$1/F\"; until [ -e \"$1/G\" \
			         ]; do :; done; exit 3' sh \"$T\" | /bin/sh -c 'exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "last/cmdsub",
			script: r#"T=$(mktemp -d); /bin/sh -c 'echo $$ > "$1/F"; until [ -e "$1/G" ]; do :; done; exit 3' sh "$T" | /bin/sh -c 'exit 5' & while kill -0 $! 2>/dev/null; do :; done; : > "$T/G"; until [ -s "$T/F" ]; do :; done; read f < "$T/F"; while kill -0 $f 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; rm -r "$T"; echo end"#,
			out:    "[[1]+  Exit 5                     /bin/sh -c 'echo $$ > \"$1/F\"; until [ -e \
			         \"$1/G\" ]; do :; done; exit 3' sh \"$T\" | /bin/sh -c 'exit 5']\nend\n",
			err:    "",
		},
	]);
}

/// `fg` and `bg` of such a job say it has terminated (status 1); `fg`
/// neither prints the job nor waits.
#[test]
fn fg_and_bg_of_a_pipeline_job_whose_processes_are_gone_say_it_terminated() {
	assert_rows(&[
		Row {
			name:   "first/fg",
			script: r#"set -m; /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; fg %1; echo "st=$?"; echo end"#,
			out:    "st=1\nend\n",
			err:    "fg: job has terminated\n",
		},
		Row {
			name:   "first/bg",
			script: r#"set -m; /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; bg %1; echo "st=$?"; echo end"#,
			out:    "st=1\nend\n",
			err:    "bg: job has terminated\n",
		},
	]);
}

/// `kill %1` of a finished job not yet reported, as Bash 5.3's `kill_pid`
/// treats it: without job control none of its processes is left to signal
/// and `kill` succeeds; with job control `killpg` finds no process group.
#[test]
fn kill_of_a_finished_job_is_as_bash_5_3_kills_it() {
	assert_rows(&[
		Row {
			name:   "first/kill",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; kill %1; echo "st=$?"; echo end"#,
			out:    "st=0\nend\n",
			err:    "",
		},
		Row {
			name:   "single/kill",
			script: r#"/bin/sh -c 'exit 3' & while kill -0 $! 2>/dev/null; do :; done; kill %1; echo "st=$?"; echo end"#,
			out:    "st=0\nend\n",
			err:    "",
		},
		Row {
			name:   "single/kill-m",
			script: r#"set -m; /bin/sh -c 'exit 3' & while kill -0 $! 2>/dev/null; do :; done; kill %1; echo "st=$?"; echo end"#,
			out:    "st=1\nend\n",
			err:    "kill: (PID) - No such process\n",
		},
	]);
}

/// What already matched Bash: a job that is one program (`$!` names the
/// job itself), a subshell job (`$!` virtual), and `wait %1`'s status.
#[test]
fn a_lone_program_or_subshell_job_and_wait_stay_as_bash_has_them() {
	assert_rows(&[
		Row {
			name:   "single/jobs",
			script: r"/bin/sh -c 'exit 3' & while kill -0 $! 2>/dev/null; do :; done; jobs; echo end",
			out:    "[1]+  Exit 3                     /bin/sh -c 'exit 3'\nend\n",
			err:    "",
		},
		Row {
			name:   "virtual/jobs",
			script: r"( /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' ) & while kill -0 $! 2>/dev/null; do :; done; jobs; echo end",
			out:    "[1]+  Exit 5                     ( /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; while [ -e /proc/$p ]; do :; done; exit 5' )\nend\n",
			err:    "",
		},
		Row {
			name:   "first/wait",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; while [ -e /proc/$p ]; do :; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; wait %1; echo "st=$?"; echo end"#,
			out:    "st=5\nend\n",
			err:    "",
		},
	]);
}
