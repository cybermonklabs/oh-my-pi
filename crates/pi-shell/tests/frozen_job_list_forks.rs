//! A shell that keeps its job list frozen (bash's `jobs_list_frozen`: the
//! last stage of a `lastpipe` pipeline and a trap run with the list frozen
//! set 1, a function substitution `${ …; }` sets -1) passes that freeze to
//! every fork it starts: a command or process substitution, a `( … )`, a
//! `{ …; } &` group, a pipeline's stage. Nothing in the fork ends it, so for
//! the fork's whole life bash deletes no job: not after `wait`, `wait PID`,
//! `wait %N`, `disown`, `kill` and `wait`, a `CHLD` trap or `set -m`. Under 1
//! `wait -n` returns 127 at once; under -1 it takes a finished job and marks
//! it, and a later `wait -n` can take the same one again. The innermost
//! freeze counts: a function substitution inside a `lastpipe` stage, or one
//! started there, only marks. While no job may be deleted a foreground
//! command (an external, a `( … )`, a pipeline) keeps the job number bash
//! gave it, so the next job is numbered after it; a command substitution
//! takes the numbers held with the list it copies. A function substitution
//! marks the finished jobs it reports, and the first clean-up outside it
//! deletes them. Each row's output is bash 5.3.20's for `bash -c` and from a
//! script file; a finished job's end is waited for with `kill -0` or `wait`,
//! and a job listed as running is a `sleep 30` the row then ends with `kill`
//! (a SIGTERM bash does not report), so the rows need no timing. In a
//! `lastpipe` stage bash numbers jobs after the pipeline's own job, which
//! obash does not model: those rows count jobs (`jobs -p | wc -l`) instead
//! of listing them. bash 5.2.21 has no function substitution, and its
//! `lastpipe` substitution lists the pipeline's job.
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
/// each as a line `NAME: `, or `NAME (file): `, and the script.
fn assert_both(rows: &[Both]) {
	let mut found = Vec::new();
	for via in [Via::Command, Via::File] {
		for row in rows {
			let want = if via == Via::File { row.file } else { row.out };
			let (status, got, got_err) = run(row.script, via);
			if (status, got.as_str(), got_err.as_str()) != (Some(0), want, row.err) {
				let how = if via == Via::File { " (file)" } else { "" };
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

/// A command substitution started in a function substitution keeps every
/// job it starts: a finished one stays listed after `wait`, `wait PID`,
/// `wait %1`, a second `wait PID`, `kill %1` and `wait`, a `CHLD` trap,
/// `set -m` or `set +m`, and a disowned one stays as it runs. `wait -n`
/// works there and marks the job it takes: three `wait -n` for two jobs
/// all return 0. A plain `wait` marks the finished jobs it forgets there,
/// in the function substitution itself too, but not `$!`'s if it ended
/// before the `wait`: `jobs -n` lists that one alone. A substitution nested
/// in it, a process substitution, a `${| …; }`, a backquote and a
/// posix-mode shell keep them too.
#[test]
fn a_substitution_of_a_function_substitution_keeps_every_job() {
	assert_both(&[
		Both {
			name:   "wait-then-jobs",
			script: r#"y=${ x=$({ /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n",
			script: r#"y=${ x=$({ sleep 0.2 & wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[rc=0\n[1]+  Done                       sleep 0.2\ne]\nend\n",
			file:   "[rc=0\n[1]+  Done                       sleep 0.2\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "disown",
			script: r#"y=${ x=$({ sleep 30 & disown; jobs; kill $!; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Running                    sleep 30 &\ne]\nend\n",
			file:   "[[1]+  Running                    sleep 30 &\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-pid",
			script: r#"y=${ x=$({ sleep 0.1 & wait $!; echo "w=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			file:   "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "foreground-numbers",
			script: r#"y=${ x=$({ /bin/true; /bin/true; sleep 30 & jobs; kill $!; wait; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[3]+  Running                    sleep 30 &\ne]\nend\n",
			file:   "[[3]+  Running                    sleep 30 &\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "chld-trap",
			script: r#"y=${ x=$({ trap 'echo chld' CHLD; /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[chld\n[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[chld\n[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "set-m",
			script: r#"y=${ x=$({ set -m; /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "set-plus-m",
			script: r#"y=${ x=$({ set +m; /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-jobspec",
			script: r#"y=${ x=$({ sleep 30 & kill %1; wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Terminated                 sleep 30\ne]\nend\n",
			file:   "[[1]+  Terminated                 sleep 30\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-jobspec",
			script: r#"y=${ x=$({ sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			file:   "[w=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n-three-times",
			script: r#"y=${ x=$({ sleep 0.1 & sleep 0.2 & wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[rc=0\nrc=0\nrc=0\n[1]-  Done                       sleep 0.1\n[2]+  Done                       sleep 0.2\ne]\nend\n",
			file:   "[rc=0\nrc=0\nrc=0\n[1]-  Done                       sleep 0.1\n[2]+  Done                       sleep 0.2\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-pid-twice",
			script: r#"y=${ x=$({ /bin/sh -c 'exit 3' & p=$!; wait $p; echo "w=$?"; wait $p; echo "w2=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=3\nw2=3\n[1]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			file:   "[w=3\nw2=3\n[1]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-n",
			script: r#"y=${ x=$({ /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; /bin/sh -c 'exit 3' & q=$!; while kill -0 $q 2>/dev/null; do :; done; wait; jobs -n; echo n; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			file:   "[[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "jobs-n-in-the-function-substitution",
			script: r#"y=${ /bin/true & p=$!; while kill -0 $p 2>/dev/null; do :; done; /bin/sh -c 'exit 3' & q=$!; while kill -0 $q 2>/dev/null; do :; done; wait; jobs -n; echo n; jobs; }; echo "$y"; echo end"#,
			out:    "[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\nend\n",
			file:   "[2]+  Exit 3                     /bin/sh -c 'exit 3'\nn\n[1]   Done                       /bin/true\n[2]+  Exit 3                     /bin/sh -c 'exit 3'\nend\n",
			err:    "",
		},
		Both {
			name:   "nested-substitution",
			script: r#"y=${ x=$({ /bin/true & wait; z=$(jobs); echo "<$z>"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[<[1]+  Done                       /bin/true>\n[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[<[1]+  Done                       /bin/true>\n[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-pid-wait",
			script: r#"y=${ x=$({ sleep 30 & kill $!; wait $!; echo "w=$?"; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[w=143\n[1]+  Terminated                 sleep 30\ne]\nend\n",
			file:   "[w=143\n[1]+  Terminated                 sleep 30\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "procsub",
			script: r#"y=${ cat <({ /bin/true & wait; jobs; echo e; } 2>&1); }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "valuesub",
			script: r#"y=${| x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e; } 2>&1); REPLY="[$x]"; }; echo "$y"; echo end"#,
			out:    "[rc=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			file:   "[rc=0\n[1]+  Done                       sleep 0.1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "backquote",
			script: r#"y=${ x=`{ /bin/true & wait; jobs; echo e; } 2>&1`; echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "posix",
			script: r#"set -o posix; y=${ x=$({ /bin/true & wait; jobs; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[1]+  Done                       /bin/true\ne]\nend\n",
			file:   "[[1]+  Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "nested-in-a-substitution",
			script: r#"y=${ x=$(z=$({ /bin/true & wait; jobs; echo e; } 2>&1); echo "<$z>"); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[<[1]+  Done                       /bin/true\ne>]\nend\n",
			file:   "[<[1]+  Done                       /bin/true\ne>]\nend\n",
			err:    "",
		},
	]);
}

/// The same in the last stage of a `lastpipe` pipeline, where the freeze
/// also makes `wait -n` return 127 at once, with the job still running:
/// the substitution counts the jobs it keeps.
#[test]
fn a_substitution_of_a_lastpipe_stage_keeps_every_job() {
	assert_both(&[
		Both {
			name:   "wait",
			script: r#"shopt -s lastpipe; echo | { x=$({ /bin/true & wait; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[1\ne]\nend\n",
			file:   "[1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs -p | wc -l; wait; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[rc=127\n1\ne]\nend\n",
			file:   "[rc=127\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "disown",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 0.3 & disown; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[1\ne]\nend\n",
			file:   "[1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "kill-pid-wait",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 30 & kill $!; wait $!; echo "w=$?"; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[w=143\n1\ne]\nend\n",
			file:   "[w=143\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-n-twice",
			script: r#"shopt -s lastpipe; echo | { x=$({ sleep 0.1 & sleep 0.2 & wait -n; echo "rc=$?"; wait -n; echo "rc=$?"; jobs -p | wc -l; wait; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[rc=127\nrc=127\n2\ne]\nend\n",
			file:   "[rc=127\nrc=127\n2\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "chld-trap",
			script: r#"shopt -s lastpipe; echo | { x=$({ trap 'echo chld' CHLD; /bin/true & wait; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo end"#,
			out:    "[chld\n1\nchld\nchld\ne]\nend\n",
			file:   "[chld\n1\nchld\nchld\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "process-substitution",
			script: r"shopt -s lastpipe; echo | { cat <({ /bin/true & wait; jobs -p | wc -l; echo e; } 2>&1); }; echo end",
			out:    "1\ne\nend\n",
			file:   "1\ne\nend\n",
			err:    "",
		},
	]);
}

/// A `( … )`, a `{ …; } &` group and a pipeline's stage of a frozen shell
/// start with no jobs of their own (bash `without_job_control`) but keep
/// the freeze: a job each starts stays listed after `wait`, `kill %1` and
/// `wait`, and `wait %1`; `wait -n` returns 127 at once in a `lastpipe`
/// stage's fork and takes the job in a function substitution's.
#[test]
fn every_fork_of_a_frozen_shell_keeps_every_job() {
	assert_both(&[
		Both {
			name:   "subshell-wait-lastpipe",
			script: r"shopt -s lastpipe; echo | { ( /bin/true & wait; jobs; echo e ) 2>&1; }; echo end",
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait",
			script: r#"y=${ ( /bin/true & wait; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-n-lastpipe",
			script: r#"shopt -s lastpipe; echo | { ( sleep 30 & wait -n; echo "rc=$?"; jobs; kill $!; wait; echo e ) 2>&1; }; echo end"#,
			out:    "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			file:   "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-n",
			script: r#"y=${ ( sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-kill-lastpipe",
			script: r"shopt -s lastpipe; echo | { ( sleep 30 & kill %1; wait; jobs; echo e ) 2>&1; }; echo end",
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-kill",
			script: r#"y=${ ( sleep 30 & kill %1; wait; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-jobspec-lastpipe",
			script: r#"shopt -s lastpipe; echo | { ( sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e ) 2>&1; }; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell-wait-jobspec",
			script: r#"y=${ ( sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e ) 2>&1; }; echo "$y"; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-lastpipe",
			script: r"shopt -s lastpipe; echo | { { /bin/true & wait; jobs; echo e; } & wait 2>&1; }; echo end",
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait",
			script: r#"y=${ { /bin/true & wait; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-n-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 30 & wait -n; echo "rc=$?"; jobs; kill $!; wait; echo e; } & wait 2>&1; }; echo end"#,
			out:    "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			file:   "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-n",
			script: r#"y=${ { sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-kill-lastpipe",
			script: r"shopt -s lastpipe; echo | { { sleep 30 & kill %1; wait; jobs; echo e; } & wait 2>&1; }; echo end",
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-kill",
			script: r#"y=${ { sleep 30 & kill %1; wait; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-jobspec-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } & wait 2>&1; }; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "group-wait-jobspec",
			script: r#"y=${ { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } & wait 2>&1; }; echo "$y"; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-lastpipe",
			script: r"shopt -s lastpipe; echo | { { /bin/true & wait; jobs; echo e; } | cat 2>&1; }; echo end",
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait",
			script: r#"y=${ { /bin/true & wait; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Done                       /bin/true\ne\nend\n",
			file:   "[1]+  Done                       /bin/true\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-n-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 30 & wait -n; echo "rc=$?"; jobs; kill $!; wait; echo e; } | cat 2>&1; }; echo end"#,
			out:    "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			file:   "rc=127\n[1]+  Running                    sleep 30 &\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-n",
			script: r#"y=${ { sleep 0.1 & wait -n; echo "rc=$?"; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "rc=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-kill-lastpipe",
			script: r"shopt -s lastpipe; echo | { { sleep 30 & kill %1; wait; jobs; echo e; } | cat 2>&1; }; echo end",
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-kill",
			script: r#"y=${ { sleep 30 & kill %1; wait; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "[1]+  Terminated                 sleep 30\ne\nend\n",
			file:   "[1]+  Terminated                 sleep 30\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-jobspec-lastpipe",
			script: r#"shopt -s lastpipe; echo | { { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } | cat 2>&1; }; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
		Both {
			name:   "stage-wait-jobspec",
			script: r#"y=${ { sleep 0.1 & wait %1; echo "w=$?"; jobs; echo e; } | cat 2>&1; }; echo "$y"; echo end"#,
			out:    "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			file:   "w=0\n[1]+  Done                       sleep 0.1\ne\nend\n",
			err:    "",
		},
	]);
}

/// The innermost freeze counts: a function substitution inside a
/// `lastpipe` stage only marks (`wait -n` takes the job, in the shell and
/// in its command substitution), and a `lastpipe` stage inside a function
/// substitution freezes (`wait -n` returns 127 at once).
#[test]
fn the_innermost_freeze_counts() {
	assert_both(&[
		Both {
			name:   "a-function-substitution-in-a-lastpipe-stage-marks",
			script: r#"shopt -s lastpipe; echo | { y=${ x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs -p | wc -l; echo e; } 2>&1); echo "[$x]"; }; echo "$y"; }; echo end"#,
			out:    "[rc=0\n1\ne]\nend\n",
			file:   "[rc=0\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "a-lastpipe-stage-in-a-function-substitution-freezes",
			script: r#"shopt -s lastpipe; y=${ echo | { x=$({ sleep 0.1 & wait -n; echo "rc=$?"; jobs -p | wc -l; wait; echo e; } 2>&1); echo "[$x]"; }; }; echo "$y"; echo end"#,
			out:    "[rc=127\n1\ne]\nend\n",
			file:   "[rc=127\n1\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "the-shell-marks-in-a-function-substitution-in-a-lastpipe-stage",
			script: r#"shopt -s lastpipe; echo | { y=${ sleep 0.1 & wait -n; echo "rc=$?"; }; echo "$y"; }; echo end"#,
			out:    "rc=0\nend\n",
			file:   "rc=0\nend\n",
			err:    "",
		},
		Both {
			name:   "the-shell-freezes-in-a-lastpipe-stage-in-a-function-substitution",
			script: r#"shopt -s lastpipe; y=${ echo | { sleep 0.1 & wait -n; echo "rc=$?"; wait; }; }; echo "$y"; echo end"#,
			out:    "rc=127\nend\n",
			file:   "rc=127\nend\n",
			err:    "",
		},
	]);
}

/// While no job may be deleted, each foreground command bash forks (an
/// external, a `( … )`, a pipeline) keeps its job number, and the next job
/// takes the number after it; a builtin, a command substitution and a
/// background job hold none. A command substitution copies the numbers held
/// with the list; a `( … )` starts with none. After the function
/// substitution the next fork deletes them, and numbers start at 1 again.
#[test]
fn a_foreground_command_holds_its_number_while_no_job_is_deleted() {
	assert_both(&[
		Both {
			name:   "externals",
			script: r#"y=${ /bin/true; /bin/true; sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[3]+  Running                    sleep 30 &\nend\n",
			file:   "[3]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "subshell",
			script: r#"y=${ ( : ); sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[2]+  Running                    sleep 30 &\nend\n",
			file:   "[2]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "pipeline",
			script: r#"y=${ : | :; sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[2]+  Running                    sleep 30 &\nend\n",
			file:   "[2]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "builtin-and-substitution-hold-none",
			script: r#"y=${ :; z=$(:); sleep 30 & jobs; kill $!; wait; }; echo "$y"; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "background-jobs",
			script: r#"y=${ sleep 30 & sleep 30 & jobs; kill %1 %2; wait; }; echo "$y"; echo end"#,
			out:    "[1]-  Running                    sleep 30 &\n[2]+  Running                    \
			         sleep 30 &\nend\n",
			file:   "[1]-  Running                    sleep 30 &\n[2]+  Running                    \
			         sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "copied-by-a-substitution",
			script: r#"y=${ /bin/true; x=$(sleep 30 & jobs; kill $!; wait); echo "[$x]"; }; echo "$y"; echo end"#,
			out:    "[[2]+  Running                    sleep 30 &]\nend\n",
			file:   "[[2]+  Running                    sleep 30 &]\nend\n",
			err:    "",
		},
		Both {
			name:   "not-by-a-subshell",
			script: r#"y=${ /bin/true; ( sleep 30 & jobs; kill $!; wait ); }; echo "$y"; echo end"#,
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
		Both {
			name:   "gone-after",
			script: r"y=${ /bin/true; }; sleep 30 & jobs; kill $!; wait; echo end",
			out:    "[1]+  Running                    sleep 30 &\nend\n",
			file:   "[1]+  Running                    sleep 30 &\nend\n",
			err:    "",
		},
	]);
}

/// A function substitution run in a fork of a `-c` shell marks the finished
/// jobs it reports there (bash's `notify_and_cleanup` under -1 marks but
/// deletes nothing), and the first clean-up outside it, at a foreground
/// command, a `wait`, the fork's `jobs` or its next substitution, deletes
/// them; jobs that ended before it went as it was expanded. A job a SIGTERM
/// killed, and `$!`'s in posix mode, stay; `wait PID` still finds a deleted
/// job's status. From a script file the fork marks none (bash's
/// `startup_state` 0), and its substitution drops all but `$!`'s.
#[test]
fn a_function_substitution_s_marks_go_at_the_next_clean_up() {
	assert_both(&[
		Both {
			name:   "foreground-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; jobs; echo e )",
			out:    "e\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "wait-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; wait; jobs; echo e )",
			out:    "e\n",
			file:   "[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "jobs-twice-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; jobs; echo m; jobs; echo e )",
			out:    "m\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\nm\ne\n",
			err:    "",
		},
		Both {
			name:   "builtin-after",
			script: r"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; :; jobs; echo e )",
			out:    "e\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "substitution-process",
			script: r#"x=$( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ z=$(jobs); }; /bin/true; jobs; echo e ); echo "[$x]"; echo end"#,
			out:    "[[2]   Done                       /bin/true\ne]\nend\n",
			file:   "[[2]   Done                       /bin/true\ne]\nend\n",
			err:    "",
		},
		Both {
			name:   "wait-pid-after",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; wait $p; echo "w=$?"; jobs; echo e )"#,
			out:    "w=3\ne\n",
			file:   "w=3\n[2]   Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "inside-then-foreground",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); /bin/true; jobs; }; echo "$y"; echo e )"#,
			out:    "\ne\n",
			file:   "[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "posix-foreground-after",
			script: r"set -o posix; ( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; jobs; echo e )",
			out:    "[2]   Done                       /bin/true\ne\n",
			file:   "[1]-  Done(3)                    /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "ended-inside",
			script: r#"( sleep 0.1 & p=$!; /bin/true & q=$!; y=${ while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; x=$(jobs); echo "[$x]"; }; echo "$y"; z=$(jobs); echo "<$z>"; jobs; echo e )"#,
			out:    "[[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true]\n<>\ne\n",
			file:   "[[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true]\n<[2]   Done                       /bin/true>\n[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "ended-before",
			script: r#"( /bin/true & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); echo "[$x]"; }; echo "$y"; z=$(jobs); echo "<$z>"; jobs; echo e )"#,
			out:    "[]\n<>\ne\n",
			file:   "[[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true]\n<[2]   Done                       /bin/true>\n[1]-  Done                       /bin/true\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "jobs-after",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); echo "[$x]"; }; echo "$y"; jobs; echo e )"#,
			out:    "[]\ne\n",
			file:   "[[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true]\n[1]-  Exit 3                     /bin/sh -c 'exit 3'\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "wait-inside",
			script: r#"( /bin/sh -c 'exit 3' & p=$!; /bin/true & q=$!; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ wait $p; echo "w=$?"; }; echo "$y"; z=$(jobs); echo "<$z>"; wait $p; echo "w2=$?" )"#,
			out:    "w=3\n<>\nw2=3\n",
			file:   "w=3\n<[2]   Done                       /bin/true>\nw2=3\n",
			err:    "",
		},
		Both {
			name:   "term-foreground-after",
			script: r"( sleep 20 & p=$!; /bin/true & q=$!; kill -TERM $p; while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; y=${ x=$(jobs); }; /bin/true; jobs; echo e )",
			out:    "[1]   Terminated                 sleep 20\ne\n",
			file:   "[1]-  Terminated                 sleep 20\n[2]+  Done                       /bin/true\ne\n",
			err:    "",
		},
		Both {
			name:   "jobs-n-after-a-mark",
			script: r#"( sleep 0.1 & p=$!; /bin/true & q=$!; y=${ while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; z=$(:); jobs -n; echo m; jobs; }; echo "$y" )"#,
			out:    "m\n[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\n",
			file:   "[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\nm\n[1]-  Done                       sleep 0.1\n[2]+  Done                       /bin/true\n",
			err:    "",
		},
		Both {
			name:   "jobs-n-in-a-lastpipe-stage-marks-none",
			script: r"shopt -s lastpipe; ( sleep 0.1 & p=$!; /bin/true & q=$!; echo | { while kill -0 $p 2>/dev/null || kill -0 $q 2>/dev/null; do :; done; z=$(:); jobs -n | wc -l; echo m; } )",
			out:    "2\nm\n",
			file:   "2\nm\n",
			err:    "",
		},
	]);
}
