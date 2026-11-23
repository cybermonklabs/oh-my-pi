//! A job's state once its last process is gone, as Bash 5.3.20 reports it
//! (`obash -c`). Bash marks a job done in the `waitchld` that reaps its last
//! process, so when `kill -0 $!` says the pipeline's last program is gone,
//! `jobs`, `fg`, `bg`, `kill %1` and a command substitution's `jobs` see the
//! job done. In each `first` row the job's last stage exits only once the
//! shell has reaped the first (it polls while `/proc/<first pid>` exists), so
//! Bash's answer does not depend on timing; in each `last` row the first stage
//! ends only after the shell's first report. Bash 5.2.21 prints the same but
//! for its narrower status column (24, not 27) and an empty `$(jobs)` (its
//! command substitution starts without the job list). A job that left the
//! table keeps its status for `wait PID` (bash's bgp list), a job `disown`
//! dropped is no child, `kill %1` makes a job's state news for `jobs -n`, and
//! the shell's own loop runs beside background loops that start subshells.
//!
//! A row's processes end with the test, however the test ends: each row runs
//! in a directory of its own, obash dies with the thread that started it
//! (`PR_SET_PDEATHSIG`), and each wait of a job's stage polls at most 6000
//! times, 10 ms apart, and only while its shell (`$PPID`) lives.
#![cfg(target_os = "linux")]

mod obash_support;

use std::{
	io,
	os::unix::process::CommandExt,
	path::Path,
	process::{Child, Command, Stdio},
	thread,
	time::{Duration, Instant},
};

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

/// How a row's script reaches obash: as `obash -c script`, or as a file
/// (`row.sh` in the row's directory) that `obash row.sh` reads.
#[derive(Clone, Copy, Debug)]
enum Via {
	Command,
	File,
}

/// `obash -c script` (or `obash row.sh`, `via`) in `dir`, as
/// [`obash_support::obash`] starts it, and killed when the thread that
/// spawns it ends (`PR_SET_PDEATHSIG`), so a test that is killed takes its
/// row's shell with it. The job's stages end once that shell is gone: each
/// of their waits checks `$PPID`.
fn row_command(dir: &Path, script: &str, via: Via) -> Command {
	let mut cmd = obash_support::obash();
	match via {
		Via::Command => cmd.args(["-c", script]),
		Via::File => {
			std::fs::write(dir.join("row.sh"), script).unwrap();
			cmd.arg("row.sh")
		},
	};
	cmd.current_dir(dir);
	let test = std::process::id();
	// SAFETY: the hook runs in the forked child before `exec` and only calls
	// prctl and getppid (plain syscalls, async-signal-safe).
	unsafe {
		cmd.pre_exec(move || {
			if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) == -1 {
				return Err(io::Error::last_os_error());
			}
			// The test ended between the fork and the prctl: no signal comes.
			if u32::try_from(libc::getppid()).ok() != Some(test) {
				return Err(io::Error::from_raw_os_error(libc::ESRCH));
			}
			Ok(())
		});
	}
	cmd
}

/// Runs each row through `obash -c`, in a directory of its own, and reports
/// every row whose output, error text or exit status (0) differs from
/// Bash's.
fn assert_rows(rows: &[Row]) {
	assert_rows_via(rows, Via::Command);
}

/// [`assert_rows`], with each script reaching obash as `via` says.
fn assert_rows_via(rows: &[Row], via: Via) {
	let mut mismatches = Vec::new();
	for row in rows {
		let dir = tempfile::tempdir().unwrap();
		let result = obash_support::output(&mut row_command(dir.path(), row.script, via));
		let out = String::from_utf8_lossy(&result.stdout).into_owned();
		let err = normalised(&String::from_utf8_lossy(&result.stderr));
		if (result.status.code(), out.as_str(), err.as_str()) != (Some(0), row.out, row.err) {
			mismatches.push(format!(
				"{} ({via:?}): `{}`\n  bash: Some(0) {:?} {:?}\n  omp:  {:?} {out:?} {err:?}",
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
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs; echo end",
			out:    "[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 \
			         $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "first/jobs-r",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs -r; echo end",
			out:    "end\n",
			err:    "",
		},
		Row {
			name:   "first/jobs-n",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs -n; echo end",
			out:    "[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 \
			         $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "first/jobs-%1",
			script: r"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs %1; echo end",
			out:    "[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 \
			         $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "first/cmdsub",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]+  Exit 5                     /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 \
			         $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5']\nend\n",
			err:    "",
		},
		Row {
			name:   "last/jobs",
			script: r"/bin/sh -c 'echo $$ > F; n=0; until [ -e G ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 3' | /bin/sh -c 'exit 5' & while kill -0 $! 2>/dev/null; do :; done; jobs; echo --; : > G; until [ -s F ]; do :; done; read f < F; while kill -0 $f 2>/dev/null; do :; done; jobs; echo end",
			out:    "[1]+  Running                    /bin/sh -c 'echo $$ > F; n=0; until [ -e G ]; \
			         do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep \
			         0.01; done; exit 3' | /bin/sh -c 'exit 5' &\n--\n[1]+  Exit 5                     \
			         /bin/sh -c 'echo $$ > F; n=0; until [ -e G ]; do n=$((n+1)); [ $n -le 6000 ] && \
			         kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 3' | /bin/sh -c \
			         'exit 5'\nend\n",
			err:    "",
		},
		Row {
			name:   "last/cmdsub",
			script: r#"/bin/sh -c 'echo $$ > F; n=0; until [ -e G ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 3' | /bin/sh -c 'exit 5' & while kill -0 $! 2>/dev/null; do :; done; : > G; until [ -s F ]; do :; done; read f < F; while kill -0 $f 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; echo end"#,
			out:    "[[1]+  Exit 5                     /bin/sh -c 'echo $$ > F; n=0; until [ -e G ]; \
			         do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep \
			         0.01; done; exit 3' | /bin/sh -c 'exit 5']\nend\n",
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
			script: r#"set -m; /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; fg %1; echo "st=$?"; echo end"#,
			out:    "st=1\nend\n",
			err:    "fg: job has terminated\n",
		},
		Row {
			name:   "first/bg",
			script: r#"set -m; /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; bg %1; echo "st=$?"; echo end"#,
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
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; kill %1; echo "st=$?"; echo end"#,
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
			script: r"( /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' ) & while kill -0 $! 2>/dev/null; do :; done; jobs; echo end",
			out:    "[1]+  Exit 5                     ( /bin/sh -c 'echo $$; exit 3' | /bin/sh -c \
			         'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 \
			         $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' )\nend\n",
			err:    "",
		},
		Row {
			name:   "first/wait",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & while kill -0 $! 2>/dev/null; do :; done; wait %1; echo "st=$?"; echo end"#,
			out:    "st=5\nend\n",
			err:    "",
		},
	]);
}

/// The statuses of jobs that `jobs` reported and forgot stay for `wait
/// PID` (bash's bgp list): again and again, once in posix mode; a plain
/// `wait` and `disown -a` forget them, `disown -r` does not.
#[test]
fn wait_finds_the_status_of_a_job_jobs_forgot() {
	assert_rows(&[
		Row {
			name:   "kept/pipe-not-last",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & p=$!; sleep 0.5 & while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait $p; echo "st=$?"; wait; echo end"#,
			out:    "st=5\nend\n",
			err:    "",
		},
		Row {
			name:   "kept/pipe-not-last-l",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & p=$!; sleep 0.5 & while kill -0 $p 2>/dev/null; do :; done; jobs -l >/dev/null; wait $p; echo "st=$?"; wait; echo end"#,
			out:    "st=5\nend\n",
			err:    "",
		},
		Row {
			name:   "kept/twice",
			script: r#"/bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & p=$!; sleep 0.5 & while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait $p; echo "st=$?"; wait $p; echo "st=$?"; wait; echo end"#,
			out:    "st=5\nst=5\nend\n",
			err:    "",
		},
		Row {
			name:   "kept/posix",
			script: r#"set -o posix; /bin/sh -c 'echo $$; exit 3' | /bin/sh -c 'read p; n=0; while [ -e /proc/$p ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 5' & p=$!; sleep 0.5 & while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait $p; echo "st=$?"; wait $p 2>/dev/null; echo "st=$?"; wait; echo end"#,
			out:    "st=5\nst=127\nend\n",
			err:    "",
		},
		Row {
			name:   "kept/two-jobs",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/sh -c 'exit 4' & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs >/dev/null; wait $p; echo "st=$?"; wait $q; echo "st=$?""#,
			out:    "st=3\nst=4\n",
			err:    "",
		},
		Row {
			name:   "kept/plain-wait-forgets",
			script: r#"/bin/sh -c 'exit 3' & p=$!; /bin/sh -c 'exit 4' & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; jobs >/dev/null; wait; wait $p 2>/dev/null; echo "st=$?""#,
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "kept/disown-a-forgets",
			script: r#"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; sleep 1 >/dev/null 2>&1 & disown -a; wait $p 2>/dev/null; echo "st=$?""#,
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "kept/disown-r-keeps",
			script: r#"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; sleep 1 >/dev/null 2>&1 & disown -r; wait $p; echo "st=$?""#,
			out:    "st=3\n",
			err:    "",
		},
	]);
}

/// `jobs` in a command substitution reports and forgets its copy of the
/// parent's finished job, but the child is the parent's: the parent's
/// `wait $p` still finds it and returns its status.
#[test]
fn jobs_in_a_command_substitution_leaves_the_parent_s_child_alone() {
	assert_rows(&[
		Row {
			name:   "copy/program",
			script: r"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); wait $p; echo st=$?",
			out:    "st=3\n",
			err:    "",
		},
		Row {
			name:   "copy/pipe",
			script: r"/bin/true | /bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; x=$(jobs); wait $p; echo st=$?",
			out:    "st=3\n",
			err:    "",
		},
	]);
}

/// `wait PID` of a job `disown` dropped answers at once: `disown` and
/// `disown %1` keep the status it had (0 while it runs: the program here
/// ends only after `disown`), `-a` and `-r` keep none (not a child), also
/// once it ended.
#[test]
fn wait_for_a_disowned_job_answers_at_once() {
	assert_rows(&[
		Row {
			name:   "disowned/a",
			script: r#"sleep 3 >/dev/null 2>&1 & disown -a; wait $! 2>/dev/null; echo "st=$?""#,
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "disowned/r",
			script: r#"sleep 3 >/dev/null 2>&1 & disown -r; wait $! 2>/dev/null; echo "st=$?""#,
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "disowned/ended-a",
			script: r#"/bin/sh -c 'exit 3' & p=$!; disown -a; while kill -0 $p 2>/dev/null; do :; done; wait $p 2>/dev/null; echo "st=$?""#,
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "disowned/ended-pct",
			script: r#"/bin/sh -c 'n=0; until [ -e go ]; do n=$((n+1)); [ $n -le 6000 ] && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 3' & p=$!; disown %1; : > go; while kill -0 $p 2>/dev/null; do :; done; wait $p; echo "st=$?""#,
			out:    "st=0\n",
			err:    "",
		},
	]);
}

/// `kill %1` makes a job's state news again for `jobs -n` (bash
/// `kill_pid`); `kill PID` does not.
#[test]
fn kill_of_a_job_makes_its_state_news_again() {
	assert_rows(&[
		Row {
			name:   "notified/pct",
			script: r"sleep 20 & jobs -n; kill -0 %1; jobs -n; echo two; kill %1 2>/dev/null; wait 2>/dev/null; echo end",
			out:    "[1]+  Running                    sleep 20 &\n[1]+  Running                    \
			         sleep 20 &\ntwo\nend\n",
			err:    "",
		},
		Row {
			name:   "notified/pct-m",
			script: r"set -m; sleep 20 & jobs -n; kill -0 %1; jobs -n; echo two; kill %1 2>/dev/null; wait 2>/dev/null; echo end",
			out:    "[1]+  Running                    sleep 20 &\n[1]+  Running                    \
			         sleep 20 &\ntwo\nend\n",
			err:    "",
		},
		Row {
			name:   "notified/pid",
			script: r"sleep 20 & jobs -n; kill -0 $!; jobs -n; echo two; kill %1 2>/dev/null; wait 2>/dev/null; echo end",
			out:    "[1]+  Running                    sleep 20 &\ntwo\nend\n",
			err:    "",
		},
	]);
}

/// The shell's own loop runs beside two background loops that start
/// subshells: it ends long before them, and `kill` ends them.
#[test]
fn the_shell_runs_beside_loops_that_start_subshells() {
	assert_rows(&[Row {
		name:   "beside/two-loops",
		script: r"( i=0; while [ $i -lt 20000 ]; do (:); i=$((i+1)); done; echo A-done ) & ( i=0; while [ $i -lt 20000 ]; do (:); i=$((i+1)); done; echo B-done ) & i=0; while [ $i -lt 3000 ]; do i=$((i+1)); done; echo fg-done; kill %1 %2; wait 2>/dev/null; echo end",
		out:    "fg-done\nend\n",
		err:    "",
	}]);
}

/// A disowned job's end still runs the CHLD trap: bash's `waitchld` counts
/// every child it reaps, before it looks for the job.
#[test]
fn a_disowned_job_s_end_runs_the_chld_trap() {
	assert_rows(&[
		Row {
			name:   "chld/disown",
			script: r"trap 'echo chld' CHLD; /bin/true & p=$!; disown; while kill -0 $p 2>/dev/null; do :; done; echo end",
			out:    "chld\nend\n",
			err:    "",
		},
		Row {
			name:   "chld/disown-pct",
			script: r"trap 'echo chld' CHLD; /bin/true & p=$!; disown %1; while kill -0 $p 2>/dev/null; do :; done; echo end",
			out:    "chld\nend\n",
			err:    "",
		},
		Row {
			name:   "chld/disown-sleep",
			script: r"trap 'echo chld' CHLD; sleep 0.3 & disown; sleep 1; echo end",
			out:    "chld\nchld\nend\n",
			err:    "",
		},
	]);
}

/// While `$p` is still `$!`, a status the list forgot is gone: a plain
/// `wait`, `disown -a` and a posix `wait PID` forget it, and `wait $p` is
/// then 127, also for a subshell job (whose pid is its virtual pid) and a
/// pipeline.
#[test]
fn a_forgotten_status_is_gone_while_its_pid_is_still_bang() {
	assert_rows(&[
		Row {
			name:   "bang/wait",
			script: r"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait; wait $p 2>/dev/null; echo st=$?",
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "bang/wait-sub",
			script: r"( exit 3 ) & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait; wait $p 2>/dev/null; echo st=$?",
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "bang/wait-pipe",
			script: r"/bin/true | /bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait; wait $p 2>/dev/null; echo st=$?",
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "bang/disown-a",
			script: r"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; disown -a; wait $p 2>/dev/null; echo st=$?",
			out:    "st=127\n",
			err:    "",
		},
		Row {
			name:   "bang/posix",
			script: r"set -o posix; /bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait $p; echo st=$?; wait $p 2>/dev/null; echo st=$?",
			out:    "st=3\nst=127\n",
			err:    "",
		},
		Row {
			name:   "bang/posix-sub",
			script: r"set -o posix; ( exit 3 ) & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; wait $p; echo st=$?; wait $p 2>/dev/null; echo st=$?",
			out:    "st=3\nst=127\n",
			err:    "",
		},
	]);
}

/// `wait $p` of a job still in the table returns its status, and so does a
/// second `wait $p` (bash's `wait PID` only marks the job; it leaves the
/// table later with its status kept); a posix shell and a plain `wait`
/// forget it.
#[test]
fn wait_twice_returns_the_status_twice() {
	assert_rows(&[
		Row {
			name:   "twice/program",
			script: r"/bin/sh -c 'exit 3' & p=$!; wait $p; echo st=$?; wait $p; echo st=$?",
			out:    "st=3\nst=3\n",
			err:    "",
		},
		Row {
			name:   "twice/subshell",
			script: r"( exit 3 ) & p=$!; wait $p; echo st=$?; wait $p; echo st=$?",
			out:    "st=3\nst=3\n",
			err:    "",
		},
		Row {
			name:   "twice/pipe",
			script: r"/bin/true | /bin/sh -c 'exit 3' & p=$!; wait $p; echo st=$?; wait $p; echo st=$?",
			out:    "st=3\nst=3\n",
			err:    "",
		},
		Row {
			name:   "twice/posix",
			script: r"set -o posix; /bin/sh -c 'exit 3' & p=$!; wait $p; echo st=$?; wait $p 2>/dev/null; echo st=$?",
			out:    "st=3\nst=127\n",
			err:    "",
		},
		Row {
			name:   "twice/plain-wait",
			script: r"/bin/sh -c 'exit 3' & p=$!; wait $p; echo st=$?; wait; wait $p 2>/dev/null; echo st=$?",
			out:    "st=3\nst=127\n",
			err:    "",
		},
	]);
}

/// A job the shell has just started has not run: `jobs` takes in no exit
/// for it and lists it `Running` (bash 5.3.20 10 of 10 for each row). A job
/// whose first turn ends it (a builtin, a function, an assignment) shows
/// that the take-in gives it no turn; a subshell takes more than one.
#[test]
fn jobs_owes_no_turn_to_a_job_the_shell_just_started() {
	assert_rows(&[
		Row {
			name:   "fresh/builtin",
			script: r": & jobs; wait; echo end",
			out:    "[1]+  Running                    : &\nend\n",
			err:    "",
		},
		Row {
			name:   "fresh/function",
			script: r"f() { return 3; }; f & jobs; wait; echo end",
			out:    "[1]+  Running                    f &\nend\n",
			err:    "",
		},
		Row {
			name:   "fresh/assignment",
			script: r"x=1 & jobs; wait; echo end",
			out:    "[1]+  Running                    x=1 &\nend\n",
			err:    "",
		},
		Row {
			name:   "fresh/subshell",
			script: r"( exit 3 ) & jobs; wait; echo end",
			out:    "[1]+  Running                    ( exit 3 ) &\nend\n",
			err:    "",
		},
	]);
}

/// `kill -0 $p` of a finished job's pid finds no process once the job left
/// the table (`jobs` reported it, `disown -a`, `wait $p`), while `$p` is
/// still `$!`.
#[test]
fn kill_of_bang_finds_no_process_once_its_job_left() {
	assert_rows(&[
		Row {
			name:   "kill0/after-jobs",
			script: r"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; kill -0 $p 2>/dev/null; echo k=$?",
			out:    "k=1\n",
			err:    "",
		},
		Row {
			name:   "kill0/after-jobs-sub",
			script: r"( exit 3 ) & p=$!; while kill -0 $p 2>/dev/null; do :; done; jobs >/dev/null; kill -0 $p 2>/dev/null; echo k=$?",
			out:    "k=1\n",
			err:    "",
		},
		Row {
			name:   "kill0/after-disown-a",
			script: r"/bin/sh -c 'exit 3' & p=$!; while kill -0 $p 2>/dev/null; do :; done; disown -a; kill -0 $p 2>/dev/null; echo k=$?",
			out:    "k=1\n",
			err:    "",
		},
		Row {
			name:   "kill0/after-wait",
			script: r"/bin/sh -c 'exit 3' & p=$!; wait $p; kill -0 $p 2>/dev/null; echo k=$?",
			out:    "k=1\n",
			err:    "",
		},
		Row {
			name:   "kill0/after-wait-sub",
			script: r"( exit 3 ) & p=$!; wait $p; kill -0 $p 2>/dev/null; echo k=$?",
			out:    "k=1\n",
			err:    "",
		},
	]);
}

/// A `CHLD` trap that a builtin's take-in owed runs once the builtin's
/// command is over, outside that command's redirections and before the
/// next command, as bash runs a trap between commands: here `kill -0`
/// takes the job's end in, its `2>/dev/null` does not hide the trap's
/// stderr, and the trap's `chld` comes before the `jobs` that follows. Each
/// row runs as `obash -c` and from a file.
#[test]
fn a_chld_trap_runs_once_the_builtin_that_took_the_exit_in_is_done() {
	let rows = [
		Row {
			name:   "chld/stderr",
			script: r"trap 'echo chld >&2; echo out' CHLD; /bin/sh -c 'exit 3' & while kill -0 $! 2>/dev/null; do :; done; echo end",
			out:    "out\nend\n",
			err:    "chld\n",
		},
		Row {
			name:   "chld/before-jobs",
			script: r"trap 'echo chld' CHLD; /bin/sh -c 'exit 3' & while kill -0 $! 2>/dev/null; do :; done; jobs; echo end",
			out:    "chld\n[1]+  Exit 3                     /bin/sh -c 'exit 3'\nend\n",
			err:    "",
		},
	];
	assert_rows_via(&rows, Via::Command);
	assert_rows_via(&rows, Via::File);
}

/// Set to a directory, this test binary is the stand-in of
/// [`a_killed_test_leaves_no_row_process_behind`]: a test killed while its
/// row runs.
const STAND_IN: &str = "JOB_STATES_STAND_IN";

/// The stand-in's row: the job's stage waits for a file nobody makes, as the
/// rows' stages wait (writing its pid to `F` first), and so does the shell
/// (writing its pid to `O`), with no `$PPID` check: only its death signal
/// ends it before its own bound.
const HELD: &str = "/bin/sh -c 'echo $$ > F; n=0; until [ -e G ]; do n=$((n+1)); [ $n -le 6000 ] \
                    && kill -0 $PPID 2>/dev/null || exit 97; sleep 0.01; done; exit 3' | /bin/sh \
                    -c 'exit 5' & echo $$ > O; n=0; until [ -e G ]; do n=$((n+1)); [ $n -le 6000 \
                    ] || exit 97; sleep 0.01; done";

/// Whether process `pid` still runs: neither gone nor a zombie.
fn runs(pid: i32) -> bool {
	std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
		// The state follows the command name's closing parenthesis.
		stat
			.rsplit_once(") ")
			.is_some_and(|(_, rest)| !rest.starts_with(['Z', 'X']))
	})
}

/// The pid the stand-in's row wrote to `name` in `dir`, once it is there.
fn pid_written(dir: &Path, name: &str, stand_in: &mut Child, deadline: Instant) -> i32 {
	loop {
		let text = std::fs::read_to_string(dir.join(name)).unwrap_or_default();
		if let Some(pid) = text.strip_suffix('\n').and_then(|pid| pid.parse().ok()) {
			return pid;
		}
		if let Some(status) = stand_in.try_wait().unwrap() {
			panic!("the stand-in ended ({status}) before its row wrote {name}");
		}
		if Instant::now() >= deadline {
			stand_in.kill().unwrap();
			stand_in.wait().unwrap();
			panic!("the stand-in's row did not write {name} within {:?}", obash_support::LIMIT);
		}
		thread::sleep(Duration::from_millis(10));
	}
}

/// A test killed while a row runs leaves none of the row's processes:
/// obash dies with the test, and the job's stage, which waits for a file
/// nobody makes, ends once its shell is gone. A stand-in (this test binary
/// run again for this test alone, with [`STAND_IN`] naming a directory of
/// this test's) starts such a row ([`HELD`]) and waits; this test kills it
/// with `SIGKILL`, as a runner kills a test past its time, then waits up to
/// [`obash_support::LIMIT`] for the shell and the stage to be gone. Whatever
/// is left then is killed by its pid, so a failing run leaves nothing either.
#[test]
fn a_killed_test_leaves_no_row_process_behind() {
	if let Some(dir) = std::env::var_os(STAND_IN) {
		let mut row = row_command(Path::new(&dir), HELD, Via::Command)
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.spawn()
			.unwrap();
		// The row's shell dies with this thread, so the thread waits for it:
		// this test kills the stand-in first, or the shell's own bound ends
		// it.
		let _ = row.wait();
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let mut stand_in = Command::new(std::env::current_exe().unwrap())
		.args(["--exact", "a_killed_test_leaves_no_row_process_behind", "--test-threads", "1"])
		.env(STAND_IN, dir.path())
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.unwrap();
	let deadline = Instant::now() + obash_support::LIMIT;
	let shell = pid_written(dir.path(), "O", &mut stand_in, deadline);
	let stage = pid_written(dir.path(), "F", &mut stand_in, deadline);
	stand_in.kill().unwrap();
	stand_in.wait().unwrap();
	let deadline = Instant::now() + obash_support::LIMIT;
	let left = loop {
		let left: Vec<i32> = [shell, stage]
			.into_iter()
			.filter(|&pid| runs(pid))
			.collect();
		if left.is_empty() || Instant::now() >= deadline {
			break left;
		}
		thread::sleep(Duration::from_millis(10));
	};
	for &pid in &left {
		// SAFETY: plain syscall; `pid` is a process of this test's row.
		unsafe { libc::kill(pid, libc::SIGKILL) };
	}
	assert!(
		left.is_empty(),
		"{left:?} of the row's shell {shell} and stage {stage} still ran {:?} after the test that \
		 started them was killed",
		obash_support::LIMIT
	);
}
